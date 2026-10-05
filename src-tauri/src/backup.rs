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

use crate::backup_triggers::REFERENCE_TRIGGERS;

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
/// la WebView ne fournit jamais cette valeur ; un test (`restore_hardening.rs`) la compare aux fichiers de migration.
pub const APP_SCHEMA_VERSION: u32 = 17;
/// Plafond de taille d'une base à vérifier ou à restaurer (512 Mo) : au-delà, la sauvegarde est refusée (`corrupt`).
pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
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
    if family == Family::PreRestore {
        remove_orphan_sidecars(dir);
    }
    Ok(excess)
}

/// Rotation des copies `pre-restore` : supprime les `-wal` / `-shm` dont la base `.db` du même nom est absente (restes d'un archivage interrompu
/// jamais repris). Appelée seulement quand aucun archivage n'est en cours (après un archivage ou une restauration abouti).
fn remove_orphan_sidecars(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.filter_map(Result::ok).map(|e| e.path()) {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some(base) = name.strip_suffix("-wal").or_else(|| name.strip_suffix("-shm")) else { continue };
        if parse_backup_name(base).is_some_and(|(family, _)| family == Family::PreRestore) && !present(&dir.join(base)) && is_plain_file(&path) {
            let _ = fs::remove_file(&path);
        }
    }
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

/// Le dossier des sauvegardes, s'il existe, doit être un dossier ordinaire (ni lien ni jonction) avant toute écriture ou ouverture (`unsafe-folder`).
fn ensure_plain_backups_dir(dir: &Path) -> Result<(), BackupError> {
    // Seuls un lien ou une jonction sont refusés ici ; un fichier ordinaire à cet emplacement fait échouer `create_dir_all` (`io`).
    let linked = fs::symlink_metadata(dir).is_ok_and(|meta| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
        }
        #[cfg(not(windows))]
        {
            meta.file_type().is_symlink()
        }
    });
    if linked {
        return Err(BackupError::new("unsafe-folder", "le dossier des sauvegardes est un lien ou une jonction"));
    }
    Ok(())
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
    ensure_plain_backups_dir(backups_dir)?;
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
    ensure_plain_backups_dir(backups_dir)?;
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
    if present(dir) && !is_plain_dir(dir) {
        return Err(BackupError::new("not-found", "le dossier des sauvegardes n'est pas un dossier ordinaire"));
    }
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
pub fn open_read_only_with(path: &Path, busy_ms: u64) -> Result<rusqlite::Connection, rusqlite::Error> {
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
    let is_table = |name: &str| -> bool {
        conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |r| r.get::<_, u64>(0)).is_ok_and(|n| n == 1)
    };
    let tasks = if is_table("task") { conn.query_row("SELECT COUNT(*) FROM task WHERE deleted_at IS NULL", [], |r| r.get::<_, u64>(0)).ok() } else { None };
    let version = if is_table("schema_migrations") {
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, Option<u32>>(0)).ok().flatten()
    } else {
        None
    };
    (tasks, version)
}

/// SQL aux espaces ASCII compactés (retours à la ligne et indentation sans effet sur la comparaison ; une espace Unicode, elle, est une différence).
pub fn normalize_sql(sql: &str) -> String {
    sql.split(|c: char| c.is_ascii_whitespace()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Supprime tous les déclencheurs du fichier puis recrée ceux de l'app depuis leur référence (pour les tables présentes). Appelée sur le fichier
/// préparé d'une restauration, après sa vérification et AVANT l'échange : la base mise en place ne porte que des déclencheurs de l'app, et un
/// échec ne laisse aucun état à moitié restauré. Sans table `search_index_doc` (schéma antérieur à la migration 0011), aucun déclencheur n'est créé :
/// la migration le fera à l'ouverture.
pub fn reset_triggers(path: &Path) -> Result<(), BackupError> {
    let conn = rusqlite::Connection::open(path).map_err(sql_err)?;
    conn.pragma_update(None, "trusted_schema", "OFF").map_err(sql_err)?;
    // Journal « DELETE » : le fichier préparé reste un fichier unique (ni `-wal` ni `-shm` à côté, qu'un échange laisserait derrière lui).
    conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0)).map_err(sql_err)?;
    let tx = conn.unchecked_transaction().map_err(sql_err)?;
    let existing: Vec<String> = {
        let mut statement = tx.prepare("SELECT name FROM sqlite_master WHERE lower(type) = 'trigger'").map_err(sql_err)?;
        let rows = statement.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?.collect::<Result<_, _>>().map_err(sql_err)?;
        rows
    };
    for name in existing {
        tx.execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\""))).map_err(sql_err)?;
    }
    // Un objet dont le `type` de sqlite_master a une autre casse ('Trigger') n'est pas supprimé par DROP TRIGGER (SQLite cherche 'trigger') : s'il en
    // reste un, le fichier n'est pas fiable (`check_backup_file` l'aurait déjà refusé) et la préparation échoue, transaction annulée.
    let leftover: u64 = tx
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE lower(type) = 'trigger'", [], |r| r.get(0))
        .map_err(sql_err)?;
    if leftover > 0 {
        return Err(BackupError::new("corrupt", "un déclencheur n'a pas pu être supprimé"));
    }
    let has_table = |table: &str| -> Result<bool, BackupError> {
        tx.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |r| r.get::<_, u64>(0)).map(|n| n == 1).map_err(sql_err)
    };
    // Déclencheurs de capture de la synchro (`sync_*`, migration 0015) : seulement si leurs tables existent (une sauvegarde plus ancienne
    // les recevra par la migration à l'ouverture ; les créer ici ferait échouer cette migration).
    let has_sync = has_table("sync_guard")?;
    if has_table("search_index_doc")? {
        for (name, table, sql) in REFERENCE_TRIGGERS {
            if name.starts_with("sync_") && !has_sync {
                continue;
            }
            if has_table(table)? {
                tx.execute_batch(sql).map_err(sql_err)?;
            }
        }
    }
    tx.commit().map_err(sql_err)
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
    // Chaque déclencheur doit être identique (type, nom, table, SQL aux espaces près) à la référence de l'app ; une sauvegarde plus ancienne peut
    // en avoir moins (migration 0011 pas encore appliquée), jamais d'autre ni de différent.
    let mut definitions = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type NOT IN ('table', 'index')")
        .map_err(|e| corrupt(e.to_string()))?;
    let found: Vec<(String, String, String, Option<String>)> = definitions
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)))
        .map_err(|e| corrupt(e.to_string()))?
        .collect::<Result<_, _>>()
        .map_err(|e| corrupt(e.to_string()))?;
    drop(definitions);
    for (kind, name, table, sql) in &found {
        let matches_reference = kind == "trigger"
            && REFERENCE_TRIGGERS
                .iter()
                .any(|(ref_name, ref_table, ref_sql)| ref_name == name && ref_table == table && sql.as_deref().is_some_and(|text| normalize_sql(text) == normalize_sql(ref_sql)));
        if !matches_reference {
            return Err(corrupt(format!("définition inattendue : {kind} {name}")));
        }
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
    ["", "-wal", "-shm"].iter().any(|suffix| present(&sidecar(&sidecar(db_path, suffix), OLD_SUFFIX)))
}

/// Le chemin existe-t-il, lien inclus (un lien brisé existe) ?
fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Horodatage UTC `AAAAMMJJTHHMMSSZ` d'un instant en secondes depuis l'époque Unix (calendrier grégorien, algorithme de Howard Hinnant).
pub fn utc_stamp(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// Ce qu'a fait la récupération au démarrage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Rien à récupérer.
    Nothing,
    /// Des fichiers de l'ancienne base ont été remis en place (base, `-wal`, `-shm`).
    PutBack,
    /// L'échange était terminé : les restes de l'ancienne base ont été DÉPLACÉS dans `backups/` (famille `pre-restore`), jamais supprimés.
    Archived,
}

/// Récupération au démarrage, AVANT l'ouverture de la base, fondée sur la présence de `circletasks.db.restore-old` (la base, déplacée en dernier
/// par l'échange) :
///
/// | `circletasks.db` | `.db.restore-old` | `-wal` / `-shm.restore-old` | action |
/// | --- | --- | --- | --- |
/// | présente | présent | indifférent | échange terminé : les `.restore-old` sont déplacés dans `backups/` sous un nom `pre-restore` (purgé par la rotation) |
/// | présente | absent | présent | échange interrompu avant la base, ou retour arrière partiel : `-wal` et `-shm` remis en place |
/// | absente | présent | indifférent | la base, le `-wal` et le `-shm` sont remis en place |
///
/// Jamais de suppression d'une ancienne base. Chaque `.restore-old` doit être un fichier ordinaire (`is_plain_file`) : sinon rien n'est touché et
/// l'erreur `unsafe-restore-file` est renvoyée. Une cible déjà occupée n'est jamais écrasée (`recovery-conflict`). Un `.restoring` orphelin est
/// une copie préparée d'une sauvegarde qui existe toujours : il est supprimé s'il est ordinaire (sinon `unsafe-restore-file`). Toute erreur de
/// renommage est propagée : l'appelant n'ouvre alors pas la base (voir `desktop.rs`).
pub fn recover_interrupted_restore(db_path: &Path, backups_dir: &Path) -> Result<Recovery, BackupError> {
    let fail = |code: &'static str, e: io::Error| BackupError::new(code, e.to_string());
    let old_of = |suffix: &str| sidecar(&sidecar(db_path, suffix), OLD_SUFFIX);
    let olds: Vec<(&str, PathBuf)> = ["", "-wal", "-shm"].into_iter().map(|suffix| (suffix, old_of(suffix))).collect();
    let staged = sidecar(db_path, STAGING_SUFFIX);
    // Vérifications avant tout déplacement.
    for (_, old) in &olds {
        if present(old) && !is_plain_file(old) {
            return Err(BackupError::new("unsafe-restore-file", "un fichier de restauration n'est pas un fichier ordinaire"));
        }
    }
    for leftover in [staged.clone(), sidecar(&staged, ".tmp"), sidecar(&staged, "-wal"), sidecar(&staged, "-shm"), sidecar(&staged, "-journal")] {
        if present(&leftover) {
            if !is_plain_file(&leftover) {
                return Err(BackupError::new("unsafe-restore-file", "un fichier de restauration n'est pas un fichier ordinaire"));
            }
            fs::remove_file(&leftover).map_err(|e| fail("recovery-failed", e))?;
        }
    }
    let db_present = present(db_path);
    let main_old = present(&olds[0].1);
    let journal_old = olds[1..].iter().any(|(_, old)| present(old));

    if db_present && main_old {
        if present(backups_dir) && !is_plain_dir(backups_dir) {
            return Err(BackupError::new("unsafe-restore-file", "le dossier des sauvegardes n'est pas un dossier ordinaire"));
        }
        fs::create_dir_all(backups_dir).map_err(|e| fail("recovery-failed", e))?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        // Nom DÉRIVÉ de la date de modification de `circletasks.db.restore-old` : une reprise après un archivage interrompu vise le même nom que la
        // tentative précédente (ses `-shm` / `-wal` déjà déplacés y sont, la base y manque). Il est accepté si la base est absente et si la cible de
        // chaque fichier restant à déplacer est libre ; les autres orphelins de ce nom sont ceux de la même base (même seconde de modification).
        let resumed = fs::symlink_metadata(&olds[0].1)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| backups_dir.join(pre_restore_backup_name(&utc_stamp(elapsed.as_secs()))))
            .filter(|candidate| !present(candidate) && olds.iter().filter(|(_, old)| present(old)).all(|(suffix, _)| !present(&sidecar(candidate, suffix))));
        let target = match resumed {
            Some(candidate) => candidate,
            None => (0..1_000)
                .map(|n| backups_dir.join(pre_restore_backup_name(&utc_stamp(now + n))))
                // La cible ET ses -wal / -shm doivent être absents : un reste orphelin d'une autre archive n'est jamais mélangé à une nouvelle.
                .find(|candidate| ["", "-wal", "-shm"].iter().all(|suffix| !present(&sidecar(candidate, suffix))))
                .ok_or_else(|| BackupError::new("recovery-conflict", "aucun nom libre pour archiver l'ancienne base"))?,
        };
        // `-shm`, puis `-wal`, la base EN DERNIER : si l'archivage s'arrête en route, `circletasks.db.restore-old` est encore là et le démarrage suivant
        // recommence (cas « base présente + base restore-old présente ») ; ce qui a déjà été déplacé reste dans `backups/`, rien n'est perdu.
        for (suffix, old) in olds.iter().rev() {
            if present(old) {
                fs::rename(old, sidecar(&target, suffix)).map_err(|e| fail("recovery-failed", e))?;
            }
        }
        let _ = prune_family(backups_dir, Family::PreRestore, KEEP_PRE_RESTORE_BACKUPS);
        return Ok(Recovery::Archived);
    }
    if (db_present && !main_old && journal_old) || (!db_present && main_old) {
        // Base d'abord (si absente), puis son journal ; une cible occupée n'est jamais écrasée.
        // Toutes les cibles sont vérifiées AVANT le premier déplacement : un conflit ne laisse rien à moitié remis en place.
        if olds.iter().any(|(suffix, old)| present(old) && present(&sidecar(db_path, suffix))) {
            return Err(BackupError::new("recovery-conflict", "un fichier de la base existe déjà : l'ancien n'est pas écrasé"));
        }
        for (suffix, old) in &olds {
            if present(old) {
                fs::rename(old, sidecar(db_path, suffix)).map_err(|e| fail("recovery-failed", e))?;
            }
        }
        return Ok(Recovery::PutBack);
    }
    Ok(Recovery::Nothing)
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
        // Déclencheurs recréés depuis la référence de l'app sur le fichier préparé, avant l'échange : la base mise en place n'a que des
        // déclencheurs de l'app, et un échec ici ne laisse aucun état à moitié restauré.
        .and_then(|_| reset_triggers(&staged))
        .and_then(|()| hook(RestoreStep::Staged).map_err(io_err));
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

/// Instant ISO 8601 UTC à la milliseconde (`2026-10-05T08:00:00.000Z`), forme de `IsoDateTime` côté TypeScript.
pub fn iso_instant(secs: u64) -> String {
    let stamp = utc_stamp(secs);
    format!("{}-{}-{}T{}:{}:{}.000Z", &stamp[0..4], &stamp[4..6], &stamp[6..8], &stamp[9..11], &stamp[11..13], &stamp[13..15])
}

/// Marqueur de restauration de la synchro après un échange abouti (ADR 0010 règle 2, ADR 0011 section 9 ; Y-01 critère 16) : écrit par
/// `sync::marker::write_after_restore` du lot Y1 (`restore-marker.json`, `.tmp` + renommage), **seulement si un dossier de synchro est
/// configuré**. L'heure de la sauvegarde est celle de son fichier (sinon l'heure de restauration). Renvoie vrai s'il a été écrit. Jamais
/// appelé par la récupération au démarrage (`recover_interrupted_restore`) : une restauration interrompue puis récupérée n'a pas de marqueur.
pub fn write_restore_marker(config_dir: &Path, backups_dir: &Path, backup: &str, restored_at_secs: u64, schema_version: u32) -> Result<bool, crate::sync::SyncError> {
    let taken = fs::metadata(backups_dir.join(backup))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(restored_at_secs, |d| d.as_secs());
    crate::sync::marker::write_after_restore(config_dir, backup, &iso_instant(taken), &iso_instant(restored_at_secs), u64::from(schema_version))
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
    let outcome = create_migration_backup(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), from_version, to_version, &stamp, KEEP_MIGRATION_BACKUPS)?;
    Ok(outcome_for_webview(outcome))
}

/// Ce que la WebView reçoit d'une sauvegarde avant migration : le NOM du fichier créé seulement, jamais le chemin absolu.
pub fn outcome_for_webview(outcome: BackupOutcome) -> BackupOutcome {
    let name = outcome.path.as_deref().and_then(|path| Path::new(path).file_name()).map(|n| n.to_string_lossy().into_owned());
    BackupOutcome { path: name, removed: outcome.removed }
}

/// Vérifie la sauvegarde `name` du dossier : nom connu, dossier et fichier ordinaires (ni lien ni jonction), puis `check_backup_file`.
pub fn check_named_backup(backups_dir: &Path, name: &str) -> Result<u32, BackupError> {
    if parse_backup_name(name).is_none() {
        return Err(BackupError::new("bad-name", "nom de sauvegarde inconnu"));
    }
    let path = backups_dir.join(name);
    if !is_plain_dir(backups_dir) || !is_plain_file(&path) {
        return Err(BackupError::new("not-found", format!("sauvegarde introuvable : {name}")));
    }
    check_backup_file(&path, APP_SCHEMA_VERSION)
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
        check_named_backup(&dir, &name)
    })
    .await
    .map_err(|e| join_error(e.into()))?
}

/// Restaure une sauvegarde (la base a été fermée par le front, qui relance ensuite l'app).
#[tauri::command]
pub async fn restore_backup(app: AppHandle, name: String, stamp: String) -> Result<RestoreOutcome, BackupError> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = restore_backup_file(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), &name, APP_SCHEMA_VERSION, &stamp, &|_| Ok(()))?;
        // Échange abouti : marqueur de la synchro (aucun cycle ne partira avant le choix de l'utilisateur, ADR 0010 règle 3). Un échec
        // d'écriture est journalisé sans bloquer la restauration déjà faite.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        if let Err(error) = write_restore_marker(&dir, &dir.join(BACKUP_DIR), &name, now, outcome.schema_version) {
            eprintln!("[backup] marqueur de restauration non écrit : {}", error.code.as_str());
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| join_error(e.into()))?
}

/// Affiche le dossier des sauvegardes dans l'Explorateur (PC) : aucun paramètre venant de la WebView.
#[cfg(desktop)]
#[tauri::command]
pub fn reveal_backups_folder(app: AppHandle) -> Result<(), BackupError> {
    let dir = data_dir(&app)?.join(BACKUP_DIR);
    ensure_plain_backups_dir(&dir)?;
    fs::create_dir_all(&dir).map_err(io_err)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| BackupError::new("io", e.to_string()))
}
