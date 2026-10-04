//! Sauvegardes de la base (D-03 critères 8 et 9, P-04, PRD sections 7 et 8, ADR 0002 avenant, ADR 0009 avenant).
//!
//! Emplacement : `<dossier de configuration de l'app>/backups/`, à côté de `circletasks.db`
//! (hors du dossier d'installation, jamais touché par l'installeur, jamais synchronisé). Trois familles de fichiers, chacune purgée
//! séparément (la purge d'une famille ne supprime jamais un fichier d'une autre) :
//!
//! - migration : `circletasks-pre-migration-vNNNN-to-vMMMM-AAAAMMJJTHHMMSSZ.db` (gardées : 5) ;
//! - quotidienne (P-04) : `circletasks-daily-AAAAMMJJ.db` (gardées : 14) ;
//! - copie de sécurité avant restauration (P-04) : `circletasks-pre-restore-AAAAMMJJTHHMMSSZ.db` (gardées : 3).
//!
//! La copie est faite par `VACUUM INTO` (cohérente, WAL inclus). Le front fait en plus un `PRAGMA wal_checkpoint(TRUNCATE)` (busy = 0
//! exigé) avant l'appel.
//!
//! Restauration (P-04) : le front ne transmet qu'un NOM de fichier pris dans la liste ; il est revalidé ici (famille connue, aucun
//! séparateur de chemin), le fichier est vérifié (`integrity_check`, `schema_migrations`, version <= celle de l'app), l'état actuel est
//! copié, puis le fichier choisi est préparé à côté de la base et échangé par renommages avec retour arrière (`restore_backup_file`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Nom du fichier de base (tauri-plugin-sql, `sqlite:circletasks.db`).
pub const DB_FILE: &str = "circletasks.db";
/// Sous-dossier des sauvegardes.
pub const BACKUP_DIR: &str = "backups";
/// Préfixe des sauvegardes faites avant migration.
pub const MIGRATION_PREFIX: &str = "circletasks-pre-migration-";
/// Nombre de sauvegardes de migration conservées.
pub const KEEP_MIGRATION_BACKUPS: usize = 5;
/// Préfixe des sauvegardes quotidiennes (P-04).
pub const DAILY_PREFIX: &str = "circletasks-daily-";
/// Nombre de sauvegardes quotidiennes conservées (P-04 critère 2).
pub const KEEP_DAILY_BACKUPS: usize = 14;
/// Préfixe des copies de sécurité faites avant une restauration (P-04).
pub const PRE_RESTORE_PREFIX: &str = "circletasks-pre-restore-";
/// Nombre de copies de sécurité de restauration conservées (P-04 critère 6).
pub const KEEP_PRE_RESTORE_BACKUPS: usize = 3;
/// Version de schéma de cette app (plus haute migration de `src/db/migrations`). Une sauvegarde plus récente est refusée. Constante côté Rust :
/// la WebView ne fournit jamais cette valeur ; un test (`restore.rs`) la compare aux fichiers de migration.
pub const APP_SCHEMA_VERSION: u32 = 14;
/// Plafond de taille d'une base à vérifier ou à restaurer (512 Mo) : au-delà, la sauvegarde est refusée (`corrupt`).
pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
/// Déclencheurs créés par les migrations de l'app (index de recherche, migration 0011). Toute autre définition (déclencheur ou vue) dans une
/// base à restaurer est refusée : une base piégée pourrait exécuter du SQL à l'ouverture.
pub const EXPECTED_TRIGGERS: [&str; 18] = [
    "search_task_ai", "search_task_au", "search_task_ad",
    "search_routine_ai", "search_routine_au", "search_routine_ad",
    "search_event_ai", "search_event_au", "search_event_ad",
    "search_goal_ai", "search_goal_au", "search_goal_ad",
    "search_checklist_ai", "search_checklist_au", "search_checklist_ad",
    "search_checklist_item_ai", "search_checklist_item_au", "search_checklist_item_ad",
];
/// Attente maximale d'un verrou pendant une sauvegarde quotidienne : la base n'est jamais bloquée plus de 2 s (P-04 critère 1).
const DAILY_BUSY_MS: u64 = 2_000;
/// Attente maximale d'un verrou pour les autres copies.
const DEFAULT_BUSY_MS: u64 = 5_000;
/// Suffixe du fichier préparé pour une restauration, à côté de la base.
const STAGING_SUFFIX: &str = ".restoring";
/// Suffixe des fichiers de l'ancienne base pendant l'échange.
const OLD_SUFFIX: &str = ".restore-old";

/// Famille d'une sauvegarde, selon son nom.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Migration,
    Daily,
    PreRestore,
}

impl Family {
    pub fn prefix(self) -> &'static str {
        match self {
            Family::Migration => MIGRATION_PREFIX,
            Family::Daily => DAILY_PREFIX,
            Family::PreRestore => PRE_RESTORE_PREFIX,
        }
    }

    pub fn keep(self) -> usize {
        match self {
            Family::Migration => KEEP_MIGRATION_BACKUPS,
            Family::Daily => KEEP_DAILY_BACKUPS,
            Family::PreRestore => KEEP_PRE_RESTORE_BACKUPS,
        }
    }

    /// Valeur envoyée au front (`kind`).
    pub fn kind(self) -> &'static str {
        match self {
            Family::Migration => "pre-migration",
            Family::Daily => "daily",
            Family::PreRestore => "pre-restore",
        }
    }
}

/// Erreur renvoyée au front : `{ code, message }` (ADR 0001).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupError {
    pub code: &'static str,
    pub message: String,
}

impl BackupError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn io_err(e: io::Error) -> BackupError {
    BackupError::new("io", e.to_string())
}

fn sql_err(e: rusqlite::Error) -> BackupError {
    BackupError::new("sqlite", e.to_string())
}

/// Résultat : fichier créé, ou `None` si la base n'existe pas encore (rien à sauvegarder).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOutcome {
    pub path: Option<String>,
    pub removed: usize,
}

/// Horodatage attendu : `AAAAMMJJTHHMMSSZ` (UTC), fourni par le front (horloge injectée).
pub fn is_valid_stamp(stamp: &str) -> bool {
    let b = stamp.as_bytes();
    b.len() == 16
        && b[8] == b'T'
        && b[15] == b'Z'
        && b[..8].iter().chain(&b[9..15]).all(u8::is_ascii_digit)
}

/// Jour attendu : `AAAAMMJJ` (date locale de l'appareil, fournie par le front), mois 01-12 et jour 01-31.
pub fn is_valid_day(day: &str) -> bool {
    let b = day.as_bytes();
    if b.len() != 8 || !b.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let year: u32 = day[0..4].parse().unwrap_or(0);
    let month: u32 = day[4..6].parse().unwrap_or(0);
    let d: u32 = day[6..8].parse().unwrap_or(0);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=last).contains(&d)
}

/// Nom de fichier d'une sauvegarde de migration.
pub fn migration_backup_name(from_version: u32, to_version: u32, stamp: &str) -> String {
    format!("{MIGRATION_PREFIX}v{from_version:04}-to-v{to_version:04}-{stamp}.db")
}

/// Nom de fichier de la sauvegarde quotidienne d'un jour (`AAAAMMJJ`).
pub fn daily_backup_name(day: &str) -> String {
    format!("{DAILY_PREFIX}{day}.db")
}

/// Nom de fichier de la copie de sécurité d'une restauration.
pub fn pre_restore_backup_name(stamp: &str) -> String {
    format!("{PRE_RESTORE_PREFIX}{stamp}.db")
}

/// Horodatage extrait d'un nom de sauvegarde de migration (tri chronologique).
fn migration_stamp(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(MIGRATION_PREFIX)?.strip_suffix(".db")?;
    let stamp = rest.rsplit('-').next()?;
    is_valid_stamp(stamp).then_some(stamp)
}

/// Nom de fichier simple : aucun séparateur, aucun `:`, aucun `..` (jamais un chemin venant de la WebView).
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.contains(['/', '\\', ':', '\0'])
        && !name.contains("..")
        && Path::new(name).file_name().is_some_and(|n| n == name)
}

/// Famille et clé de tri d'un nom de sauvegarde reconnu, ou `None` (autre fichier, nom douteux). La clé trie du plus ancien au plus
/// récent : le jour (`AAAAMMJJ`) ou l'horodatage.
pub fn parse_backup_name(name: &str) -> Option<(Family, String)> {
    if !is_plain_file_name(name) {
        return None;
    }
    if let Some(stamp) = migration_stamp(name) {
        // Forme stricte : `vNNNN-to-vMMMM-AAAAMMJJTHHMMSSZ`.
        let middle = name.strip_prefix(MIGRATION_PREFIX)?.strip_suffix(".db")?.strip_suffix(stamp)?.strip_suffix('-')?;
        let (from, to) = middle.split_once("-to-")?;
        let versions_ok = [from, to].iter().all(|v| v.len() == 5 && v.starts_with('v') && v[1..].bytes().all(|b| b.is_ascii_digit()));
        return versions_ok.then(|| (Family::Migration, stamp.to_owned()));
    }
    if let Some(day) = name.strip_prefix(DAILY_PREFIX).and_then(|r| r.strip_suffix(".db")) {
        return is_valid_day(day).then(|| (Family::Daily, day.to_owned()));
    }
    let stamp = name.strip_prefix(PRE_RESTORE_PREFIX)?.strip_suffix(".db")?;
    is_valid_stamp(stamp).then(|| (Family::PreRestore, stamp.to_owned()))
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Supprime les plus anciennes sauvegardes d'une famille au-delà de `keep`. Renvoie le nombre supprimé.
pub fn prune_family(dir: &Path, family: Family, keep: usize) -> io::Result<usize> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some((found_family, key)) = parse_backup_name(name) {
            if found_family == family {
                found.push((format!("{key}{name}"), path));
            }
        }
    }
    found.sort();
    let excess = found.len().saturating_sub(keep);
    for (_, path) in found.into_iter().take(excess) {
        fs::remove_file(&path)?;
        let _ = fs::remove_file(sidecar(&path, "-wal"));
        let _ = fs::remove_file(sidecar(&path, "-shm"));
    }
    Ok(excess)
}

/// Vrai pour un fichier ordinaire, jamais pour un lien symbolique, une jonction ou tout autre point d'analyse (`FILE_ATTRIBUTE_REPARSE_POINT`).
/// `symlink_metadata` ne suit pas les liens : un fichier du dossier des sauvegardes qui pointerait ailleurs n'est ni lu ni restauré.
pub fn is_plain_file(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

/// Vrai pour un dossier ordinaire (ni lien ni jonction).
fn is_plain_dir(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

/// Supprime les plus anciennes sauvegardes de migration au-delà de `keep`. Renvoie le nombre supprimé.
pub fn prune_migration_backups(dir: &Path, keep: usize) -> io::Result<usize> {
    prune_family(dir, Family::Migration, keep)
}

/// Supprime les `.tmp` orphelins d'une sauvegarde interrompue (début de chaque sauvegarde), toutes familles.
fn remove_orphan_tmp(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.filter_map(Result::ok).map(|e| e.path()) {
        let is_tmp = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.ends_with(".tmp") && [MIGRATION_PREFIX, DAILY_PREFIX, PRE_RESTORE_PREFIX].iter().any(|prefix| n.starts_with(prefix))
        });
        if is_tmp {
            let _ = fs::remove_file(path);
        }
    }
}

/// Copie cohérente de `source` vers `target` : `VACUUM INTO` vers un `.tmp` (lecture seule de la source : le `-wal` est pris en compte,
/// aucune copie de `-wal` nécessaire), `sync_all`, puis renommage ; une copie partielle ne porte jamais son nom final, et une cible
/// existante n'est remplacée qu'au renommage.
fn copy_database(source: &Path, target: &Path, busy_ms: u64) -> Result<(), BackupError> {
    let tmp = sidecar(target, ".tmp");
    let _ = fs::remove_file(&tmp);
    let result = (|| {
        let conn = open_read_only_with(source, busy_ms).map_err(sql_err)?;
        conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()]).map_err(sql_err)?;
        drop(conn);
        fs::File::options().write(true).open(&tmp).and_then(|f| f.sync_all()).map_err(io_err)?;
        fs::rename(&tmp, target).map_err(io_err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Copie cohérente de la base dans `backups_dir` sous le nom de migration, puis nettoie.
/// Base absente alors que `from_version >= 1` : erreur `no-database` (jamais un succès
/// silencieux) ; `from_version == 0` : base neuve, rien à sauvegarder (`path: None`).
pub fn create_migration_backup(
    db_path: &Path,
    backups_dir: &Path,
    from_version: u32,
    to_version: u32,
    stamp: &str,
    keep: usize,
) -> Result<BackupOutcome, BackupError> {
    if !is_valid_stamp(stamp) {
        return Err(BackupError::new("bad-stamp", format!("horodatage invalide : {stamp}")));
    }
    if !db_path.is_file() {
        if from_version >= 1 {
            return Err(BackupError::new("no-database", "base introuvable"));
        }
        return Ok(BackupOutcome { path: None, removed: 0 });
    }
    fs::create_dir_all(backups_dir).map_err(io_err)?;
    remove_orphan_tmp(backups_dir);
    let target = backups_dir.join(migration_backup_name(from_version, to_version, stamp));
    copy_database(db_path, &target, DEFAULT_BUSY_MS)?;
    // Le nettoyage ne doit jamais faire échouer une sauvegarde réussie.
    let removed = prune_family(backups_dir, Family::Migration, keep).unwrap_or(0);
    Ok(BackupOutcome { path: Some(target.to_string_lossy().into_owned()), removed })
}

/// Résultat d'une sauvegarde quotidienne.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyOutcome {
    pub name: String,
    /// Faux si la sauvegarde du jour existait déjà et que le remplacement n'était pas demandé.
    pub created: bool,
    pub removed: usize,
}

/// Sauvegarde quotidienne `circletasks-daily-AAAAMMJJ.db` (P-04 critères 1 et 2). Une version du jour déjà présente est conservée sauf
/// si `replace` (« Sauvegarder maintenant »). Purge des seules sauvegardes quotidiennes au-delà de `keep`.
pub fn create_daily_backup(db_path: &Path, backups_dir: &Path, day: &str, replace: bool, keep: usize) -> Result<DailyOutcome, BackupError> {
    if !is_valid_day(day) {
        return Err(BackupError::new("bad-day", format!("jour invalide : {day}")));
    }
    if !db_path.is_file() {
        return Err(BackupError::new("no-database", "base introuvable"));
    }
    fs::create_dir_all(backups_dir).map_err(io_err)?;
    remove_orphan_tmp(backups_dir);
    let name = daily_backup_name(day);
    let target = backups_dir.join(&name);
    if target.is_file() && !replace {
        return Ok(DailyOutcome { name, created: false, removed: 0 });
    }
    copy_database(db_path, &target, DAILY_BUSY_MS)?;
    let removed = prune_family(backups_dir, Family::Daily, keep).unwrap_or(0);
    Ok(DailyOutcome { name, created: true, removed })
}

/// Une version listée dans la feuille de restauration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    /// `daily`, `pre-migration` ou `pre-restore`.
    pub kind: &'static str,
    /// Jour (`AAAAMMJJ`) ou horodatage UTC (`AAAAMMJJTHHMMSSZ`) du nom.
    pub stamp: String,
    pub size: u64,
    /// Dernière modification du fichier (ms depuis l'époque Unix) : heure réelle de la sauvegarde.
    pub modified_ms: u64,
    /// Nombre de tâches non supprimées, `None` si la version n'est pas lisible.
    pub tasks: Option<u64>,
    /// Version de schéma de la sauvegarde, `None` si illisible.
    pub schema_version: Option<u32>,
}

/// Liste des sauvegardes de `dir`, les plus récentes d'abord. Dossier absent : liste vide. Les fichiers d'autres noms sont ignorés.
pub fn list_backups_in(dir: &Path) -> Result<Vec<BackupEntry>, BackupError> {
    let reader = match fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err(e)),
    };
    let mut entries = Vec::new();
    for entry in reader {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        let Some((family, stamp)) = parse_backup_name(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !is_plain_file(&path) {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        let (tasks, schema_version) = if meta.len() > MAX_BACKUP_BYTES { (None, None) } else { read_summary(&path) };
        entries.push(BackupEntry { name, kind: family.kind(), stamp, size: meta.len(), modified_ms, tasks, schema_version });
    }
    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.stamp.cmp(&a.stamp)).then_with(|| b.name.cmp(&a.name)));
    Ok(entries)
}

/// Ouvre un fichier de sauvegarde en lecture seule avec `trusted_schema = OFF` : les fonctions SQL « non fiables » des déclencheurs et des vues
/// d'une base venue de l'extérieur ne sont pas exécutées.
fn open_read_only_with(path: &Path, busy_ms: u64) -> Result<rusqlite::Connection, rusqlite::Error> {
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_millis(busy_ms))?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    Ok(conn)
}

fn open_read_only(path: &Path) -> Result<rusqlite::Connection, rusqlite::Error> {
    open_read_only_with(path, DEFAULT_BUSY_MS)
}

/// Tâches et version de schéma d'une sauvegarde, sans jamais échouer (`None` si illisible). `task` doit être une vraie table (pas une vue
/// qui exécuterait autre chose) avant tout `COUNT`.
fn read_summary(path: &Path) -> (Option<u64>, Option<u32>) {
    let Ok(conn) = open_read_only(path) else { return (None, None) };
    let is_table = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task'", [], |r| r.get::<_, u64>(0))
        .is_ok_and(|n| n == 1);
    let tasks = if is_table { conn.query_row("SELECT COUNT(*) FROM task WHERE deleted_at IS NULL", [], |r| r.get::<_, u64>(0)).ok() } else { None };
    let version = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, Option<u32>>(0)).ok().flatten();
    (tasks, version)
}

/// Vérifie un fichier de sauvegarde (P-04 critères 6 et 7) : base SQLite lisible, `PRAGMA integrity_check` = ok, table
/// `schema_migrations` non vide, version <= `app_version`. Renvoie la version de schéma. Codes : `corrupt`, `newer-schema`.
pub fn check_backup_file(path: &Path, app_version: u32) -> Result<u32, BackupError> {
    let corrupt = |why: String| BackupError::new("corrupt", why);
    if !is_plain_file(path) {
        return Err(corrupt("ce n'est pas un fichier ordinaire".into()));
    }
    if fs::metadata(path).map_err(io_err)?.len() > MAX_BACKUP_BYTES {
        return Err(corrupt("sauvegarde de plus de 512 Mo".into()));
    }
    let conn = open_read_only(path).map_err(|e| corrupt(e.to_string()))?;
    let mut statement = conn.prepare("PRAGMA integrity_check").map_err(|e| corrupt(e.to_string()))?;
    let rows: Vec<String> = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| corrupt(e.to_string()))?
        .collect::<Result<_, _>>()
        .map_err(|e| corrupt(e.to_string()))?;
    drop(statement);
    if rows.as_slice() != ["ok"] {
        return Err(corrupt(rows.join("; ")));
    }
    // Seuls les déclencheurs de l'app sont admis, et aucune vue : une base piégée ne doit rien exécuter à l'ouverture.
    let mut definitions = conn
        .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')")
        .map_err(|e| corrupt(e.to_string()))?;
    let found: Vec<(String, String)> = definitions
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| corrupt(e.to_string()))?
        .collect::<Result<_, _>>()
        .map_err(|e| corrupt(e.to_string()))?;
    drop(definitions);
    if let Some((kind, name)) = found.iter().find(|(kind, name)| kind != "trigger" || !EXPECTED_TRIGGERS.contains(&name.as_str())) {
        return Err(corrupt(format!("définition inattendue : {kind} {name}")));
    }
    let version = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, Option<u32>>(0))
        .map_err(|e| corrupt(e.to_string()))?
        .filter(|v| *v >= 1)
        .ok_or_else(|| corrupt("aucune version de schéma".into()))?;
    if version > app_version {
        return Err(BackupError::new("newer-schema", format!("version de schéma {version} > {app_version}")));
    }
    Ok(version)
}

/// Étapes d'une restauration où un échec peut être simulé (tests, P-04 critère 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreStep {
    /// Le fichier choisi est prêt à côté de la base, rien n'a encore bougé.
    Staged,
    /// L'ancienne base est déplacée, la nouvelle n'est pas encore en place.
    OldMoved,
}

/// Résultat d'une restauration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// Copie de sécurité de l'état d'avant (`None` si la base n'existait pas).
    pub safety_copy: Option<String>,
    pub schema_version: u32,
}

/// Des fichiers `.restore-old` existent-ils ? (restauration interrompue, ou retour arrière incomplet `rollback-failed`)
pub fn has_pending_restore(db_path: &Path) -> bool {
    ["", "-wal", "-shm"].iter().any(|suffix| sidecar(&sidecar(db_path, suffix), OLD_SUFFIX).exists())
}

/// Récupération au démarrage, AVANT l'ouverture de la base : si `circletasks.db` est absent et qu'un `.restore-old` existe, l'échange a été
/// interrompu (arrêt brutal, `rollback-failed`) : l'ancienne base revient avec son `-wal` et son `-shm`. Si la base est présente, l'échange a
/// abouti et les `.restore-old` ne sont que des restes, supprimés. Un `.restoring` orphelin est toujours supprimé. Renvoie vrai si une
/// ancienne base a été remise en place.
pub fn recover_interrupted_restore(db_path: &Path) -> bool {
    let _ = fs::remove_file(sidecar(db_path, STAGING_SUFFIX));
    let _ = fs::remove_file(sidecar(&sidecar(db_path, STAGING_SUFFIX), ".tmp"));
    if !has_pending_restore(db_path) {
        return false;
    }
    if db_path.exists() {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(sidecar(&sidecar(db_path, suffix), OLD_SUFFIX));
        }
        return false;
    }
    let mut restored = false;
    // Base d'abord, puis son journal.
    for suffix in ["", "-wal", "-shm"] {
        let target = sidecar(db_path, suffix);
        let old = sidecar(&target, OLD_SUFFIX);
        if old.exists() && fs::rename(&old, &target).is_ok() && suffix.is_empty() {
            restored = true;
        }
    }
    restored
}

/// Échange la base par le fichier préparé. Tout ce qui est déplacé est remis en place si une étape échoue : l'ancienne base (et son
/// `-wal`) revient, le fichier préparé est supprimé par l'appelant.
fn swap_database(db_path: &Path, staged: &Path, hook: &dyn Fn(RestoreStep) -> io::Result<()>) -> Result<(), BackupError> {
    // Une restauration interrompue a laissé des `.restore-old` : ils portent peut-être la seule copie de la base. On ne les écrase jamais ;
    // `recover_interrupted_restore` (au démarrage, avant l'ouverture de la base) les remet en place.
    if has_pending_restore(db_path) {
        return Err(BackupError::new("restore-pending", "une restauration interrompue doit d'abord être récupérée (redémarrage)"));
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> io::Result<()> {
        // `-shm` et `-wal` d'abord, la base en dernier : si l'échange s'arrête ici, la base seule (sans son journal) n'est jamais présente
        // avec le fichier d'un autre état ; `circletasks.db` absent + `.restore-old` présent = restauration à récupérer.
        for suffix in ["-shm", "-wal", ""] {
            let from = sidecar(db_path, suffix);
            if from.exists() {
                let to = sidecar(&from, OLD_SUFFIX);
                fs::rename(&from, &to)?;
                moved.push((from, to));
            }
        }
        hook(RestoreStep::OldMoved)?;
        fs::rename(staged, db_path)
    })();
    let Err(error) = result else {
        for (_, old) in &moved {
            let _ = fs::remove_file(old);
        }
        return Ok(());
    };
    let mut rollback_failed = false;
    for (from, old) in moved.iter().rev() {
        if fs::rename(old, from).is_err() {
            rollback_failed = true;
        }
    }
    if rollback_failed {
        return Err(BackupError::new("rollback-failed", format!("restauration interrompue et retour arrière incomplet : {error}")));
    }
    Err(BackupError::new("io", error.to_string()))
}

/// Restaure la sauvegarde `name` de `backups_dir` (P-04 critères 5 à 8). La connexion à la base doit être fermée par l'appelant.
///
/// 1. `name` doit être une sauvegarde connue du dossier (aucun chemin) ; 2. le fichier est vérifié ; 3. l'état actuel est copié sous
/// `circletasks-pre-restore-<stamp>.db` ; 4. le fichier choisi est copié à côté de la base (`.restoring`) et revérifié ; 5. les fichiers
/// de la base sont renommés vers `.restore-old`, puis le fichier préparé prend la place : au moindre échec, l'ancienne base revient et
/// rien n'a changé. `hook` ne sert qu'aux tests (échec simulé).
pub fn restore_backup_file(
    db_path: &Path,
    backups_dir: &Path,
    name: &str,
    app_version: u32,
    stamp: &str,
    hook: &dyn Fn(RestoreStep) -> io::Result<()>,
) -> Result<RestoreOutcome, BackupError> {
    if !is_valid_stamp(stamp) {
        return Err(BackupError::new("bad-stamp", format!("horodatage invalide : {stamp}")));
    }
    if parse_backup_name(name).is_none() {
        return Err(BackupError::new("bad-name", "nom de sauvegarde inconnu"));
    }
    let source = backups_dir.join(name);
    if !is_plain_dir(backups_dir) || !is_plain_file(&source) {
        return Err(BackupError::new("not-found", format!("sauvegarde introuvable : {name}")));
    }
    if has_pending_restore(db_path) {
        return Err(BackupError::new("restore-pending", "une restauration interrompue doit d'abord être récupérée (redémarrage)"));
    }
    let schema_version = check_backup_file(&source, app_version)?;

    remove_orphan_tmp(backups_dir);
    let safety_copy = if db_path.is_file() {
        let safety = pre_restore_backup_name(stamp);
        copy_database(db_path, &backups_dir.join(&safety), DEFAULT_BUSY_MS)?;
        Some(safety)
    } else {
        None
    };

    let staged = sidecar(db_path, STAGING_SUFFIX);
    let _ = fs::remove_file(&staged);
    let prepared = copy_database(&source, &staged, DEFAULT_BUSY_MS)
        .and_then(|()| check_backup_file(&staged, app_version))
        .and_then(|_| hook(RestoreStep::Staged).map_err(io_err));
    if let Err(error) = prepared {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = swap_database(db_path, &staged, hook) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    let _ = prune_family(backups_dir, Family::PreRestore, KEEP_PRE_RESTORE_BACKUPS);
    Ok(RestoreOutcome { safety_copy, schema_version })
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, BackupError> {
    app.path().app_config_dir().map_err(|e| BackupError::new("no-data-dir", e.to_string()))
}

fn join_error(e: tauri::Error) -> BackupError {
    BackupError::new("io", e.to_string())
}

/// Commande appelée par le front avant d'appliquer des migrations sur une base existante.
#[tauri::command]
pub fn backup_database_before_migration(
    app: AppHandle,
    from_version: u32,
    to_version: u32,
    stamp: String,
) -> Result<BackupOutcome, BackupError> {
    let dir = data_dir(&app)?;
    create_migration_backup(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), from_version, to_version, &stamp, KEEP_MIGRATION_BACKUPS)
}

/// Sauvegarde quotidienne (P-04) ; `replace` = « Sauvegarder maintenant ». Hors du fil de l'interface.
#[tauri::command]
pub async fn daily_backup(app: AppHandle, day: String, replace: bool) -> Result<DailyOutcome, BackupError> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || create_daily_backup(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), &day, replace, KEEP_DAILY_BACKUPS))
        .await
        .map_err(|e| join_error(e.into()))?
}

/// Liste des sauvegardes et dossier qui les contient (affiché dans l'aide).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupListing {
    pub directory: String,
    pub entries: Vec<BackupEntry>,
}

/// Libellé neutre du dossier des sauvegardes, montré à l'utilisateur : jamais le chemin absolu (nom de session Windows) vers la WebView.
pub fn neutral_directory_label(identifier: &str) -> String {
    format!("%APPDATA%\\{identifier}\\{BACKUP_DIR}")
}

#[tauri::command]
pub async fn list_backups(app: AppHandle) -> Result<BackupListing, BackupError> {
    let dir = data_dir(&app)?.join(BACKUP_DIR);
    let label = neutral_directory_label(&app.config().identifier);
    tauri::async_runtime::spawn_blocking(move || {
        let entries = list_backups_in(&dir)?;
        Ok(BackupListing { directory: label, entries })
    })
    .await
    .map_err(|e| join_error(e.into()))?
}

/// Vérifie une sauvegarde avant que l'app ne ferme sa base (un fichier refusé ne coûte rien).
#[tauri::command]
pub async fn check_backup(app: AppHandle, name: String) -> Result<u32, BackupError> {
    let dir = data_dir(&app)?.join(BACKUP_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        if parse_backup_name(&name).is_none() {
            return Err(BackupError::new("bad-name", "nom de sauvegarde inconnu"));
        }
        let path = dir.join(&name);
        if !path.is_file() {
            return Err(BackupError::new("not-found", format!("sauvegarde introuvable : {name}")));
        }
        check_backup_file(&path, APP_SCHEMA_VERSION)
    })
    .await
    .map_err(|e| join_error(e.into()))?
}

/// Restaure une sauvegarde (la base a été fermée par le front, qui relance ensuite l'app).
#[tauri::command]
pub async fn restore_backup(app: AppHandle, name: String, stamp: String) -> Result<RestoreOutcome, BackupError> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        restore_backup_file(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), &name, APP_SCHEMA_VERSION, &stamp, &|_| Ok(()))
    })
    .await
    .map_err(|e| join_error(e.into()))?
}

/// Affiche le dossier des sauvegardes dans l'Explorateur (PC) : aucun paramètre venant de la WebView.
#[cfg(desktop)]
#[tauri::command]
pub fn reveal_backups_folder(app: AppHandle) -> Result<(), BackupError> {
    let dir = data_dir(&app)?.join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(io_err)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| BackupError::new("io", e.to_string()))
}
