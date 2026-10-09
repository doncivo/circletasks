//! Marqueur de restauration (ADR 0010 règle 2, ADR 0011 section 9 ; Y-01 critère 16).
//!
//! `<dossier de configuration>/restore-marker.json` : `{ v, backup, backupTakenAt, restoredAt, schemaVersion }`, écrit par `.tmp` +
//! renommage **seulement si un dossier de synchro est configuré** ; depuis la revue du lot F, écrit AVANT l'échange (provisoire, remis
//! à l'état d'avant si l'échange échoue : `startup_gate::restore_with_provisional_marker`) (`write_after_restore`, appelé par
//! `backup::restore_backup` via `backup::write_restore_marker`), lu par `sync_restore_marker_get`, supprimé par `sync_restore_marker_clear`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::folder::{config_dir, read_config_file, remove_config_file, write_config_file, FOLDER_FILE};
use super::{fail, SyncCode, SyncResult};

pub const MARKER_FILE: &str = "restore-marker.json";

/// Contenu du fichier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerFile {
    pub v: u32,
    pub backup: String,
    pub backup_taken_at: String,
    pub restored_at: String,
    pub schema_version: u64,
    /// Revue du lot F : marqueur écrit juste avant l'échange, pas encore confirmé (la version n'est peut-être pas en place). Réglé au
    /// démarrage selon la récupération (`startup_gate::settle_provisional_marker`) ; jamais « Appliquer partout » tant qu'il l'est.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub provisional: bool,
}

/// Forme IPC (`RestoreMarker` de `types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreMarker {
    pub backup: String,
    pub backup_taken_at: String,
    pub restored_at: String,
    pub schema_version: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub provisional: bool,
}

/// Un dossier de synchro est-il configuré (fichier `sync/folder.json` présent) ?
pub fn sync_folder_configured(base: &Path) -> bool {
    config_dir(base).join(FOLDER_FILE).is_file()
}

/// Écrit le marqueur si un dossier de synchro est configuré ; renvoie `true` s'il a été écrit.
pub fn write_after_restore(base: &Path, backup: &str, backup_taken_at: &str, restored_at: &str, schema_version: u64) -> SyncResult<bool> {
    write_marker(base, backup, backup_taken_at, restored_at, schema_version, false)
}

/// Écrit le marqueur, provisoire ou confirmé, si un dossier de synchro est configuré.
pub fn write_marker(base: &Path, backup: &str, backup_taken_at: &str, restored_at: &str, schema_version: u64, provisional: bool) -> SyncResult<bool> {
    if !sync_folder_configured(base) {
        return Ok(false);
    }
    let marker = MarkerFile { v: 1, backup: backup.to_owned(), backup_taken_at: backup_taken_at.to_owned(), restored_at: restored_at.to_owned(), schema_version, provisional };
    let bytes = serde_json::to_vec(&marker).map_err(|_| super::SyncError::new(SyncCode::Io))?;
    write_config_file(&base.join(MARKER_FILE), &bytes)?;
    Ok(true)
}

/// Marqueur présent, ou `None`.
pub fn read(base: &Path) -> SyncResult<Option<RestoreMarker>> {
    match read_config_file::<MarkerFile>(&base.join(MARKER_FILE)) {
        Ok(Some(m)) if m.v == 1 => Ok(Some(RestoreMarker { backup: m.backup, backup_taken_at: m.backup_taken_at, restored_at: m.restored_at, schema_version: m.schema_version, provisional: m.provisional })),
        Ok(None) => Ok(None),
        // Marqueur illisible : la synchro reste suspendue (le choix explicite reste dû), jamais ignorée.
        _ => fail(SyncCode::Io),
    }
}

pub fn clear(base: &Path) -> SyncResult<()> {
    remove_config_file(&base.join(MARKER_FILE))
}

/// Confirme un marqueur provisoire (échange abouti) ; `Ok(false)` s'il n'y en a pas.
pub fn confirm(base: &Path) -> SyncResult<bool> {
    match read_config_file::<MarkerFile>(&base.join(MARKER_FILE)).map_err(|()| super::SyncError::new(SyncCode::Io))? {
        Some(mut marker) if marker.provisional => {
            marker.provisional = false;
            let bytes = serde_json::to_vec(&marker).map_err(|_| super::SyncError::new(SyncCode::Io))?;
            write_config_file(&base.join(MARKER_FILE), &bytes)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Le marqueur présent est-il provisoire ?
pub fn is_provisional(base: &Path) -> bool {
    matches!(read_config_file::<MarkerFile>(&base.join(MARKER_FILE)), Ok(Some(marker)) if marker.provisional)
}
