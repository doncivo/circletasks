//! Sauvegarde de la base avant migration (D-03 critères 8 et 9, PRD section 7, ADR 0002 avenant).
//!
//! Emplacement : `<dossier de configuration de l'app>/backups/`, à côté de `circletasks.db`
//! (hors du dossier d'installation, jamais touché par l'installeur). Ce dossier est partagé avec
//! la sauvegarde quotidienne (P-04, ordre 3), qui s'y branche avec son propre préfixe :
//!
//! - migration : `circletasks-pre-migration-vNNNN-to-vMMMM-AAAAMMJJTHHMMSSZ.db` (gardées : 5) ;
//! - quotidienne (P-04) : `circletasks-daily-AAAAMMJJ.db` (14 versions, politique propre à P-04).
//!
//! Le nettoyage ne touche QUE les fichiers du préfixe de migration : il ne supprime jamais une
//! sauvegarde quotidienne, et inversement. La cohérence de la copie suppose un point de contrôle
//! WAL fait juste avant par le front (`PRAGMA wal_checkpoint(TRUNCATE)`, base inactive) ; le
//! fichier `-wal` éventuellement non vide est de toute façon copié avec la base.

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

/// Nom de fichier d'une sauvegarde de migration.
pub fn migration_backup_name(from_version: u32, to_version: u32, stamp: &str) -> String {
    format!("{MIGRATION_PREFIX}v{from_version:04}-to-v{to_version:04}-{stamp}.db")
}

/// Horodatage extrait d'un nom de sauvegarde de migration (tri chronologique).
fn migration_stamp(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(MIGRATION_PREFIX)?.strip_suffix(".db")?;
    let stamp = rest.rsplit('-').next()?;
    is_valid_stamp(stamp).then_some(stamp)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Supprime les plus anciennes sauvegardes de migration au-delà de `keep`. Renvoie le nombre supprimé.
pub fn prune_migration_backups(dir: &Path, keep: usize) -> io::Result<usize> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(stamp) = migration_stamp(name) {
            found.push((format!("{stamp}{name}"), path));
        }
    }
    found.sort();
    let excess = found.len().saturating_sub(keep);
    for (_, path) in found.into_iter().take(excess) {
        fs::remove_file(&path)?;
        let _ = fs::remove_file(sidecar(&path, "-wal"));
    }
    Ok(excess)
}

/// Copie la base dans `backups_dir` sous le nom de migration, puis nettoie. Écriture atomique :
/// copie vers un `.tmp` puis renommage, pour qu'une sauvegarde partielle ne porte jamais son nom final.
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
        return Ok(BackupOutcome { path: None, removed: 0 });
    }
    let io_err = |e: io::Error| BackupError::new("io", e.to_string());
    fs::create_dir_all(backups_dir).map_err(io_err)?;
    let target = backups_dir.join(migration_backup_name(from_version, to_version, stamp));
    let tmp = sidecar(&target, ".tmp");

    let wal = sidecar(db_path, "-wal");
    let wal_len = fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    let copied = fs::copy(db_path, &tmp).and_then(|_| {
        if wal_len > 0 {
            fs::copy(&wal, sidecar(&target, "-wal")).map(|_| ())
        } else {
            Ok(())
        }
    });
    if let Err(e) = copied {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(sidecar(&target, "-wal"));
        return Err(io_err(e));
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(e)
    })?;
    // Le nettoyage ne doit jamais faire échouer une sauvegarde réussie.
    let removed = prune_migration_backups(backups_dir, keep).unwrap_or(0);
    Ok(BackupOutcome { path: Some(target.to_string_lossy().into_owned()), removed })
}

/// Commande appelée par le front avant d'appliquer des migrations sur une base existante.
#[tauri::command]
pub fn backup_database_before_migration(
    app: AppHandle,
    from_version: u32,
    to_version: u32,
    stamp: String,
) -> Result<BackupOutcome, BackupError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| BackupError::new("no-data-dir", e.to_string()))?;
    create_migration_backup(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), from_version, to_version, &stamp, KEEP_MIGRATION_BACKUPS)
}
