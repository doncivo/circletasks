//! Démarrage sûr et restauration sur iPhone (P-04-iOS, ADR 0009 avenant lot F B3, B6). Sans `cfg` : testé sur le runtime de test de
//! Tauri sous Windows ; utilisé par le `setup` de l'iPhone (`ios_setup.rs`) et par les commandes de sauvegarde (PC et iPhone).
//!
//! - **Porte de démarrage** (`StartupGate`) : sur iPhone, la fenêtre (donc la WebView) existe AVANT le `setup` ; le plugin SQL n'est
//!   enregistré qu'APRÈS une récupération réussie d'une restauration interrompue (`register_sql_after_recovery`) : tant qu'il ne l'est
//!   pas, tout `plugin:sql|…` échoue, aucune base n'est ouverte ni créée. L'issue est rendue par `backup_startup_status`.
//! - **Une seule connexion** : le plugin SQL (copie `vendor/tauri-plugin-sql`, pool à UNE connexion) doit avoir fermé ses pools avant
//!   l'échange des fichiers (`open_sql_pools`) : la restauration est refusée sinon (`db-open`), jamais une 2e connexion pendant l'échange.
//! - **Marqueur en attente** (`PendingRestoreMarker`) : un marqueur de restauration non écrit est gardé et réessayé par
//!   `sync_restore_marker_get` (le processus survit au rechargement de la WebView sur iPhone).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Issue de la récupération au démarrage (posée une fois, avant la fin du `setup` de l'iPhone).
#[derive(Default)]
pub struct StartupGate(OnceLock<Result<(), &'static str>>);

impl StartupGate {
    /// `None` : `setup` pas encore terminé ; `Some(Ok)` : prête ; `Some(Err(code))` : récupération impossible.
    pub fn outcome(&self) -> Option<Result<(), &'static str>> {
        self.0.get().copied()
    }

    pub fn set(&self, outcome: Result<(), &'static str>) {
        let _ = self.0.set(outcome);
    }
}

/// Réponse de `backup_startup_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// `ready`, `failed` ou `pending` (le `setup` n'est pas encore terminé : le front réessaie).
    pub state: &'static str,
    pub code: Option<&'static str>,
}

pub fn status_of(gate: Option<&StartupGate>) -> StartupStatus {
    match gate.and_then(StartupGate::outcome) {
        Some(Ok(())) => StartupStatus { state: "ready", code: None },
        Some(Err(code)) => StartupStatus { state: "failed", code: Some(code) },
        None => StartupStatus { state: "pending", code: None },
    }
}

/// Récupère une restauration interrompue (table de décision de `backup::recover_interrupted_restore`, inchangée), puis, seulement si elle
/// réussit, enregistre le plugin SQL. L'issue est posée dans `StartupGate` (géré ici) et inscrite au journal en cas d'échec
/// (`backup-recovery` / code). `config_dir` : `None` si le dossier de données est introuvable (`no-data-dir`).
pub fn register_sql_after_recovery<R: Runtime>(app: &AppHandle<R>, config_dir: Option<&Path>) -> Result<(), &'static str> {
    if app.try_state::<StartupGate>().is_none() {
        app.manage(StartupGate::default());
    }
    let outcome = match config_dir {
        None => Err("no-data-dir"),
        Some(dir) => crate::backup::recover_interrupted_restore(&dir.join(crate::backup::DB_FILE), &dir.join(crate::backup::BACKUP_DIR)).map(|_| ()).map_err(|error| error.code),
    };
    let outcome = outcome.and_then(|()| app.plugin(tauri_plugin_sql::Builder::default().build()).map_err(|_| "sql-plugin"));
    if let Err(code) = outcome {
        crate::applog::write("backup-recovery", code);
    }
    app.state::<StartupGate>().set(outcome);
    outcome
}

/// Issue de la récupération au démarrage, pour la WebView (écran d'erreur persistant avec le code, ADR 0009 avenant lot F B3).
#[tauri::command]
pub fn backup_startup_status(app: AppHandle) -> StartupStatus {
    status_of(app.try_state::<StartupGate>().as_deref())
}

/// Commandes de sauvegarde refusées (`restore-pending`) tant que la porte n'est pas prête ; sans porte (PC : récupération avant la fenêtre),
/// rien à vérifier.
pub fn ensure_ready<R: Runtime>(app: &AppHandle<R>) -> Result<(), crate::backup::BackupError> {
    match app.try_state::<StartupGate>().as_deref().map(StartupGate::outcome) {
        None | Some(Some(Ok(()))) => Ok(()),
        Some(_) => Err(crate::backup::BackupError { code: "restore-pending", message: "récupération au démarrage non terminée".to_owned() }),
    }
}

/// Nombre de pools SQLite du plugin SQL encore ouverts : la restauration exige zéro (le front a fermé sa connexion unique).
pub async fn open_sql_pools(instances: &tauri_plugin_sql::DbInstances) -> usize {
    instances
        .0
        .read()
        .await
        .values()
        .filter(|pool| match pool {
            tauri_plugin_sql::DbPool::Sqlite(pool) => !pool.is_closed(),
        })
        .count()
}

/// Marqueur de restauration à écrire, gardé après un échec (P-04-iOS critère 12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerToWrite {
    pub config_dir: PathBuf,
    pub backup: String,
    pub restored_at_secs: u64,
    pub schema_version: u32,
}

#[derive(Default)]
pub struct PendingRestoreMarker(pub Mutex<Option<MarkerToWrite>>);

/// Écrit le marqueur (un nouvel essai après 200 ms) : `written`, `not-configured`, ou `failed` avec le code (journal :
/// `backup` / `restore-marker-failed`).
pub fn write_marker_with_retry(marker: &MarkerToWrite, pause: std::time::Duration) -> (&'static str, Option<&'static str>) {
    let attempt = || crate::backup::write_restore_marker(&marker.config_dir, &marker.config_dir.join(crate::backup::BACKUP_DIR), &marker.backup, marker.restored_at_secs, marker.schema_version);
    let result = attempt().or_else(|_| {
        std::thread::sleep(pause);
        attempt()
    });
    match result {
        Ok(true) => ("written", None),
        Ok(false) => ("not-configured", None),
        Err(error) => {
            crate::applog::write("backup", "restore-marker-failed");
            ("failed", Some(error.code.as_str()))
        }
    }
}

/// Avant de lire le marqueur (`sync_restore_marker_get`, PC et iPhone) : un marqueur en attente est réécrit ; réussite -> oublié ;
/// nouvel échec -> `Err` (la précondition du cycle échoue : phase d'erreur visible, aucun cycle).
pub fn retry_pending_marker<R: Runtime>(app: &AppHandle<R>) -> Result<(), crate::sync::SyncError> {
    let Some(state) = app.try_state::<PendingRestoreMarker>() else { return Ok(()) };
    let Some(marker) = state.0.lock().map_err(|_| crate::sync::SyncError::new(crate::sync::SyncCode::Io))?.clone() else { return Ok(()) };
    match write_marker_with_retry(&marker, std::time::Duration::from_millis(0)) {
        ("failed", _) => Err(crate::sync::SyncError::new(crate::sync::SyncCode::Io)),
        _ => {
            if let Ok(mut pending) = state.0.lock() {
                *pending = None;
            }
            Ok(())
        }
    }
}
