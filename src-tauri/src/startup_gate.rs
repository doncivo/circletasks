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
use std::sync::{Mutex, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Issue de la récupération (posée avant la fin du `setup` de l'iPhone). Revue B1 : elle peut être REMISE à l'échec après le démarrage,
/// quand un échange de restauration échoue sans retour arrière complet et que la récupération immédiate échoue aussi : le rechargement
/// de la WebView affiche alors l'écran d'erreur persistant au lieu d'ouvrir (ou créer) une base.
#[derive(Default)]
pub struct StartupGate(RwLock<Option<Result<(), &'static str>>>);

impl StartupGate {
    /// `None` : `setup` pas encore terminé ; `Some(Ok)` : prête ; `Some(Err(code))` : récupération impossible.
    pub fn outcome(&self) -> Option<Result<(), &'static str>> {
        *self.0.read().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set(&self, outcome: Result<(), &'static str>) {
        *self.0.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outcome);
    }
}

/// Revue B1 : après un échange en échec, si des `.restore-old` restent (retour arrière incomplet), la récupération est faite TOUT DE SUITE
/// (aucun pool ouvert : la connexion est fermée avant `restore_backup`), avec la table de décision habituelle. Rend `None` si rien
/// n'était en attente, sinon l'issue (`Err(code)` : les fichiers restent intacts, la porte doit passer à l'échec).
pub fn recover_after_failed_swap(db_path: &Path, backups_dir: &Path) -> Option<Result<(), &'static str>> {
    if !crate::backup::has_pending_restore(db_path) {
        return None;
    }
    let outcome = crate::backup::recover_interrupted_restore(db_path, backups_dir).map(|_| ()).map_err(|error| error.code);
    crate::applog::write("backup-recovery", match outcome {
        Ok(()) => "recovered-after-swap",
        Err(code) => code,
    });
    Some(outcome)
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
        Some(dir) => recover_and_settle(dir).map(|_| ()).map_err(|error| error.code),
    };
    // Plugin déjà enregistré (nouvel essai après « Mettre les fichiers en conflit de côté ») : rien à refaire.
    let outcome = outcome.and_then(|()| {
        if app.try_state::<tauri_plugin_sql::DbInstances>().is_some() {
            return Ok(());
        }
        app.plugin(tauri_plugin_sql::Builder::default().build()).map_err(|_| "sql-plugin")
    });
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

/// Revue I1 : action utile de l'écran « Restauration interrompue » pour `recovery-conflict` et `unsafe-restore-file`. Les fichiers qui
/// empêchent la récupération sont DÉPLACÉS (jamais supprimés) dans `backups/circletasks-set-aside-<horodatage>/` : un `.restore-old` qui
/// n'est pas un fichier ordinaire (lien, dossier), l'occupant d'une cible du retour en place (`-wal`, `-shm` actuels quand leur
/// `.restore-old` existe ; la base quand elle n'est pas un fichier ordinaire), et un fichier préparé `.restoring` anormal. Rend le nombre d'entrées déplacées ; `io` si un déplacement échoue (rien n'est supprimé).
pub fn set_aside_conflicts(db_path: &Path, backups_dir: &Path, stamp: &str) -> Result<usize, &'static str> {
    let name = |suffix: &str| {
        let mut text = db_path.as_os_str().to_owned();
        text.push(suffix);
        PathBuf::from(text)
    };
    let plain = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file());
    let present = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    let mut aside: Vec<PathBuf> = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let current = name(suffix);
        let old = name(&format!("{suffix}.restore-old"));
        if present(&old) && !plain(&old) {
            aside.push(old);
        } else if present(&old) && present(&current) && (suffix != "" || !plain(&current)) {
            aside.push(current);
        }
    }
    for leftover in [".restoring", ".restoring.tmp"] {
        let path = name(leftover);
        if present(&path) && !plain(&path) {
            aside.push(path);
        }
    }
    if aside.is_empty() {
        return Ok(0);
    }
    let target = backups_dir.join(format!("circletasks-set-aside-{stamp}"));
    std::fs::create_dir_all(&target).map_err(|_| "io")?;
    for path in &aside {
        let Some(file) = path.file_name() else { return Err("io") };
        std::fs::rename(path, target.join(file)).map_err(|_| "io")?;
    }
    crate::applog::write_count("backup-recovery", "conflicts-set-aside", u32::try_from(aside.len()).unwrap_or(u32::MAX));
    Ok(aside.len())
}

/// « Mettre les fichiers en conflit de côté » (iPhone) : déplacement, puis nouvelle récupération et, si elle réussit, enregistrement du
/// plugin SQL ; rend le nouvel état de la porte (`ready` : la WebView recharge et ouvre la base).
#[tauri::command]
pub async fn backup_set_aside_conflicts(app: AppHandle) -> StartupStatus {
    let Ok(dir) = app.path().app_config_dir() else { return StartupStatus { state: "failed", code: Some("no-data-dir") } };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let stamp = crate::backup::utc_stamp(now);
    let moved = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || set_aside_conflicts(&dir.join(crate::backup::DB_FILE), &dir.join(crate::backup::BACKUP_DIR), &stamp)).await
    };
    if !matches!(moved, Ok(Ok(_))) {
        if let Some(gate) = app.try_state::<StartupGate>() {
            gate.set(Err("io"));
        }
        return StartupStatus { state: "failed", code: Some("io") };
    }
    let _ = register_sql_after_recovery(&app, Some(&dir));
    status_of(app.try_state::<StartupGate>().as_deref())
}

/// Réponse de `backup_restore_marker_write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MarkerWriteOutcome {
    /// `written`, `not-configured` (aucun dossier de synchro) ou `failed`.
    pub marker: &'static str,
    pub code: Option<&'static str>,
}

/// Revue I2 : nouvel essai du marqueur de restauration à partir du mémo de la WebView (PC après la relance, iPhone après un arrêt) : le nom
/// est revalidé (sauvegarde connue du dossier), la version de schéma relue dans le fichier, l'heure est celle de l'essai.
pub fn write_marker_for(config_dir: &Path, backup: &str, now_secs: u64) -> MarkerWriteOutcome {
    let backups = config_dir.join(crate::backup::BACKUP_DIR);
    let schema = match crate::backup::check_named_backup(&backups, backup) {
        Ok(version) => version,
        Err(error) => return MarkerWriteOutcome { marker: "failed", code: Some(error.code) },
    };
    let (marker, code) = write_marker_with_retry(&MarkerToWrite { config_dir: config_dir.to_path_buf(), backup: backup.to_owned(), restored_at_secs: now_secs, schema_version: schema }, std::time::Duration::from_millis(0));
    MarkerWriteOutcome { marker, code }
}

/// « Réessayer » du marqueur non écrit (Réglages › Synchronisation, PC et iPhone).
#[tauri::command]
pub async fn backup_restore_marker_write(app: AppHandle, backup: String) -> MarkerWriteOutcome {
    let Ok(dir) = app.path().app_config_dir() else { return MarkerWriteOutcome { marker: "failed", code: Some("no-data-dir") } };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let outcome = tauri::async_runtime::spawn_blocking(move || write_marker_for(&dir, &backup, now)).await.unwrap_or(MarkerWriteOutcome { marker: "failed", code: Some("io") });
    if outcome.marker != "failed" {
        if let Some(pending) = app.try_state::<PendingRestoreMarker>() {
            if let Ok(mut slot) = pending.0.lock() {
                *slot = None;
            }
        }
    }
    outcome
}

/// Fichier qui garde, pendant une restauration, le marqueur d'une restauration précédente encore en attente de choix.
pub const PREVIOUS_MARKER_FILE: &str = "restore-marker.previous.json";

/// Remet le marqueur d'avant (s'il y en avait un) ou retire le marqueur provisoire ; rend faux si un fichier n'a pas pu être écrit.
fn undo_provisional_marker(config_dir: &Path) -> bool {
    let previous = config_dir.join(PREVIOUS_MARKER_FILE);
    let undone = match std::fs::read(&previous) {
        Ok(bytes) => crate::sync::folder::write_config_file(&config_dir.join(crate::sync::marker::MARKER_FILE), &bytes).is_ok(),
        Err(_) => crate::sync::marker::clear(config_dir).is_ok(),
    };
    let _ = std::fs::remove_file(previous);
    undone
}

/// Revue du lot F (marqueur provisoire) : le marqueur est écrit **provisoire** au point `Staged` (fichier préparé, juste avant les
/// renommages ; le marqueur d'avant est gardé à part), **confirmé** au point `Swapped` (version en place, avant le retrait des
/// `.restore-old`). Échange en échec : marqueur d'avant remis, ou provisoire retiré. Arrêt brutal : `settle_provisional_marker` le règle au
/// démarrage. Rend l'issue de la restauration (marqueur compris) et, si le marqueur n'a pas pu être écrit, celui à réessayer.
pub fn restore_with_provisional_marker(
    config_dir: &Path,
    name: &str,
    stamp: &str,
    now_secs: u64,
    hook: &dyn Fn(crate::backup::RestoreStep) -> std::io::Result<()>,
) -> Result<(crate::backup::RestoreOutcome, Option<MarkerToWrite>), crate::backup::BackupError> {
    use crate::backup::RestoreStep;
    use std::cell::Cell;
    let backups = config_dir.join(crate::backup::BACKUP_DIR);
    let schema = crate::backup::check_named_backup(&backups, name)?;
    let written = Cell::new(false);
    let confirmed = Cell::new(false);
    let wrapped = |step: RestoreStep| -> std::io::Result<()> {
        match step {
            RestoreStep::Staged => {
                let marker = config_dir.join(crate::sync::marker::MARKER_FILE);
                let previous = config_dir.join(PREVIOUS_MARKER_FILE);
                let _ = std::fs::remove_file(&previous);
                if let Ok(bytes) = std::fs::read(&marker) {
                    crate::sync::folder::write_config_file(&previous, &bytes).map_err(|_| std::io::Error::other("marqueur précédent"))?;
                }
                written.set(matches!(crate::backup::write_restore_marker_as(config_dir, &backups, name, now_secs, schema, true), Ok(true)));
            }
            RestoreStep::Swapped => {
                if written.get() {
                    confirmed.set(crate::sync::marker::confirm(config_dir).is_ok());
                }
            }
            RestoreStep::OldMoved => {}
        }
        hook(step)
    };
    let outcome = match crate::backup::restore_backup_file(&config_dir.join(crate::backup::DB_FILE), &backups, name, crate::backup::APP_SCHEMA_VERSION, stamp, &wrapped) {
        Ok(outcome) => outcome,
        Err(error) => {
            if written.get() && !undo_provisional_marker(config_dir) {
                crate::applog::write("backup", "provisional-marker-undo-failed");
            }
            return Err(error);
        }
    };
    let _ = std::fs::remove_file(config_dir.join(PREVIOUS_MARKER_FILE));
    let marker = MarkerToWrite { config_dir: config_dir.to_path_buf(), backup: name.to_owned(), restored_at_secs: now_secs, schema_version: outcome.schema_version };
    let (state, code) = if written.get() && confirmed.get() { ("written", None) } else { write_marker_with_retry(&marker, std::time::Duration::from_millis(200)) };
    let pending = (state == "failed").then_some(marker);
    Ok((crate::backup::RestoreOutcome { marker: state, marker_code: code, ..outcome }, pending))
}

/// Au démarrage, après la récupération (revue du lot F) : un marqueur encore provisoire vient d'un arrêt pendant une restauration.
/// `Archived` (l'échange avait abouti) -> confirmé ; `PutBack` ou `Nothing` (ancienne base remise, ou fichier préparé seulement supprimé : la
/// version n'a jamais été en place) -> marqueur d'avant remis, sinon retiré. Jamais « Appliquer partout » sur une version non restaurée.
pub fn settle_provisional_marker(config_dir: &Path, recovery: &Result<crate::backup::Recovery, crate::backup::BackupError>) {
    if !crate::sync::marker::is_provisional(config_dir) {
        let _ = std::fs::remove_file(config_dir.join(PREVIOUS_MARKER_FILE));
        return;
    }
    let done = match recovery {
        Ok(crate::backup::Recovery::Archived) => {
            let _ = std::fs::remove_file(config_dir.join(PREVIOUS_MARKER_FILE));
            crate::sync::marker::confirm(config_dir).is_ok()
        }
        Ok(_) => undo_provisional_marker(config_dir),
        // Récupération impossible : rien n'est touché (la porte reste fermée, l'écran le dit).
        Err(_) => return,
    };
    crate::applog::write("backup-recovery", if done { "provisional-marker-settled" } else { "provisional-marker-settle-failed" });
}

/// Récupération au démarrage puis règlement du marqueur provisoire (PC et iPhone).
pub fn recover_and_settle(config_dir: &Path) -> Result<crate::backup::Recovery, crate::backup::BackupError> {
    let recovery = crate::backup::recover_interrupted_restore(&config_dir.join(crate::backup::DB_FILE), &config_dir.join(crate::backup::BACKUP_DIR));
    settle_provisional_marker(config_dir, &recovery);
    recovery
}
