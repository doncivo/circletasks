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

/// Préfixe des dossiers de mise de côté (dans `backups/`, ou à côté de lui quand `backups` lui-même n'était pas un dossier ordinaire).
pub const SET_ASIDE_PREFIX: &str = "circletasks-set-aside-";
/// Durée de conservation des dossiers mis de côté (purgés au démarrage, comme les copies « Avant restauration » sont tournées).
pub const KEEP_SET_ASIDE_DAYS: u64 = 30;

/// Issue d'une mise de côté.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetAside {
    /// Nombre d'entrées déplacées (jamais supprimées).
    pub moved: usize,
    /// L'ancienne base (`.restore-old` anormal) a été mise de côté et aucune base n'est en place : l'app va en créer une neuve ; le message
    /// renvoie vers la copie « Avant restauration » des sauvegardes.
    pub fresh_base: bool,
}

/// Revue du lot F : la mise de côté n'est permise que si la porte a échoué sur un conflit (`recovery-conflict`, `unsafe-restore-file`) et
/// qu'aucun pool SQL n'est ouvert ; sinon `set-aside-refused` (rien d'autre à mettre de côté) ou `db-open`.
pub fn set_aside_allowed(outcome: Option<Result<(), &'static str>>, open_pools: usize) -> Result<(), &'static str> {
    if !matches!(outcome, Some(Err("recovery-conflict" | "unsafe-restore-file"))) {
        return Err("set-aside-refused");
    }
    if open_pools > 0 {
        return Err("db-open");
    }
    Ok(())
}

/// Crée un dossier de mise de côté NEUF (`create_dir`, exclusif) : `circletasks-set-aside-<stamp>`, sinon `-1`, `-2`… ; jamais un dossier existant.
fn create_set_aside_dir(parent: &Path, stamp: &str) -> Result<PathBuf, &'static str> {
    for n in 0..1_000 {
        let name = if n == 0 { format!("{SET_ASIDE_PREFIX}{stamp}") } else { format!("{SET_ASIDE_PREFIX}{stamp}-{n}") };
        let path = parent.join(name);
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("io"),
        }
    }
    Err("io")
}

/// Revue I1 et revue du lot F : action utile de l'écran « Restauration interrompue » pour `recovery-conflict` et `unsafe-restore-file`. Ce qui
/// empêche la récupération est DÉPLACÉ (jamais supprimé, jamais écrasé) dans un dossier neuf `backups/circletasks-set-aside-<horodatage>[-n]/` :
/// un `.restore-old` qui n'est pas un fichier ordinaire (lien, dossier ; celui de la base emmène aussi les `-wal` / `-shm.restore-old`, qui lui
/// appartiennent), l'occupant d'une cible du retour en place, un fichier préparé `.restoring` anormal. Si `backups` lui-même n'est pas un dossier
/// ordinaire, il est d'abord déplacé dans un dossier neuf à côté de lui, puis un `backups/` ordinaire est créé. `io` si un déplacement échoue.
pub fn set_aside_conflicts(db_path: &Path, backups_dir: &Path, stamp: &str) -> Result<SetAside, &'static str> {
    let name = |suffix: &str| {
        let mut text = db_path.as_os_str().to_owned();
        text.push(suffix);
        PathBuf::from(text)
    };
    let plain = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file());
    let present = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    let mut moved = 0;
    if present(backups_dir) && !crate::backup::is_plain_dir(backups_dir) {
        let parent = backups_dir.parent().ok_or("io")?;
        let holder = create_set_aside_dir(parent, stamp)?;
        let file = backups_dir.file_name().ok_or("io")?;
        std::fs::rename(backups_dir, holder.join(file)).map_err(|_| "io")?;
        moved += 1;
        std::fs::create_dir(backups_dir).map_err(|_| "io")?;
    }
    let mut aside: Vec<PathBuf> = Vec::new();
    let main_old = name(".restore-old");
    let main_old_unsafe = present(&main_old) && !plain(&main_old);
    for suffix in ["", "-wal", "-shm"] {
        let current = name(suffix);
        let old = name(&format!("{suffix}.restore-old"));
        if present(&old) && (!plain(&old) || main_old_unsafe) {
            aside.push(old);
        } else if present(&old) && present(&current) && (!suffix.is_empty() || !plain(&current)) {
            aside.push(current);
        }
    }
    for leftover in [".restoring", ".restoring.tmp", ".restoring-wal", ".restoring-shm", ".restoring-journal"] {
        let path = name(leftover);
        if present(&path) && !plain(&path) {
            aside.push(path);
        }
    }
    if !aside.is_empty() {
        std::fs::create_dir_all(backups_dir).map_err(|_| "io")?;
        let target = create_set_aside_dir(backups_dir, stamp)?;
        for path in &aside {
            let Some(file) = path.file_name() else { return Err("io") };
            std::fs::rename(path, target.join(file)).map_err(|_| "io")?;
        }
        moved += aside.len();
    }
    if moved > 0 {
        crate::applog::write_count("backup-recovery", "conflicts-set-aside", u32::try_from(moved).unwrap_or(u32::MAX));
    }
    Ok(SetAside { moved, fresh_base: main_old_unsafe && !present(db_path) })
}

/// Supprime les dossiers de mise de côté datés de plus de `KEEP_SET_ASIDE_DAYS` jours, dans `config_dir` et `config_dir/backups` : seulement
/// des DOSSIERS ordinaires au nom `circletasks-set-aside-<horodatage>[-n]` valide (jamais un lien, un fichier ou un nom inconnu). Rend le
/// nombre supprimé.
pub fn purge_set_aside(config_dir: &Path, now_secs: u64) -> usize {
    let cutoff = crate::backup::utc_stamp(now_secs.saturating_sub(KEEP_SET_ASIDE_DAYS * 86_400));
    let mut purged = 0;
    for parent in [config_dir.to_path_buf(), config_dir.join(crate::backup::BACKUP_DIR)] {
        if !crate::backup::is_plain_dir(&parent) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&parent) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(rest) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix(SET_ASIDE_PREFIX)) else { continue };
            let Some(stamp) = rest.get(..16) else { continue };
            let suffix = &rest[16..];
            let suffix_ok = suffix.is_empty() || suffix.strip_prefix('-').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
            if crate::backup::is_valid_stamp(stamp) && suffix_ok && stamp < cutoff.as_str() && crate::backup::is_plain_dir(&path) && std::fs::remove_dir_all(&path).is_ok() {
                purged += 1;
            }
        }
    }
    purged
}

/// Réponse de `backup_set_aside_conflicts` : l'état de la porte et, si l'app va créer une base neuve, `notice: "fresh-base"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SetAsideStatus {
    pub state: &'static str,
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<&'static str>,
}

/// « Mettre les fichiers en conflit de côté » (iPhone) : refusée sauf porte en échec sur un conflit et aucun pool SQL ouvert ; déplacement,
/// puis nouvelle récupération et, si elle réussit, enregistrement du plugin SQL ; rend le nouvel état de la porte (`ready` : la WebView
/// recharge et ouvre la base).
#[tauri::command]
pub async fn backup_set_aside_conflicts(app: AppHandle) -> SetAsideStatus {
    let failed = |code: &'static str| SetAsideStatus { state: "failed", code: Some(code), notice: None };
    let outcome = app.try_state::<StartupGate>().as_deref().and_then(StartupGate::outcome);
    let pools = match app.try_state::<tauri_plugin_sql::DbInstances>() {
        Some(instances) => open_sql_pools(&instances).await,
        None => 0,
    };
    if let Err(code) = set_aside_allowed(outcome, pools) {
        crate::applog::write("backup-recovery", code);
        return failed(code);
    }
    let Ok(dir) = app.path().app_config_dir() else { return failed("no-data-dir") };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let stamp = crate::backup::utc_stamp(now);
    let moved = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || set_aside_conflicts(&dir.join(crate::backup::DB_FILE), &dir.join(crate::backup::BACKUP_DIR), &stamp)).await
    };
    let Ok(Ok(aside)) = moved else {
        if let Some(gate) = app.try_state::<StartupGate>() {
            gate.set(Err("io"));
        }
        return failed("io");
    };
    let _ = register_sql_after_recovery(&app, Some(&dir));
    let status = status_of(app.try_state::<StartupGate>().as_deref());
    SetAsideStatus { state: status.state, code: status.code, notice: (aside.fresh_base && status.state == "ready").then_some("fresh-base") }
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
    // Le marqueur d'avant n'est effacé que si l'annulation a réussi : sinon la preuve reste pour le prochain essai.
    if undone {
        let _ = std::fs::remove_file(previous);
    }
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
    // Un marqueur encore provisoire (règlement précédent impossible) est d'abord réglé d'après la base en place ; s'il l'est toujours, la
    // restauration est refusée (`restore-unconfirmed`, « rouvrez CircleTasks ») : `restore-marker.previous.json` n'est jamais écrasé.
    if !settle_provisional_marker(config_dir, &Ok(crate::backup::Recovery::Nothing)) {
        return Err(crate::backup::BackupError { code: "restore-unconfirmed", message: "un marqueur de restauration provisoire n'est pas encore réglé (redémarrage)".to_owned() });
    }
    let written = Cell::new(false);
    let confirmed = Cell::new(false);
    let wrapped = |step: RestoreStep| -> std::io::Result<()> {
        match step {
            RestoreStep::Staged => {
                // Le jeton est celui que le fichier préparé porte déjà : la base en place le portera si, et seulement si, l'échange a lieu.
                let token = crate::backup::staged_restore_token(&config_dir.join(crate::backup::DB_FILE))
                    .ok()
                    .flatten()
                    .ok_or_else(|| std::io::Error::other("jeton de restauration"))?;
                let marker = config_dir.join(crate::sync::marker::MARKER_FILE);
                let previous = config_dir.join(PREVIOUS_MARKER_FILE);
                let _ = std::fs::remove_file(&previous);
                if let Ok(bytes) = std::fs::read(&marker) {
                    crate::sync::folder::write_config_file(&previous, &bytes).map_err(|_| std::io::Error::other("marqueur précédent"))?;
                }
                written.set(matches!(crate::backup::write_provisional_marker(config_dir, &backups, name, now_secs, schema, token), Ok(true)));
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

/// Règle un marqueur provisoire (au démarrage après la récupération, et avant toute nouvelle restauration). La DÉCISION vient de la base en
/// place, jamais de l'issue de la récupération (`Nothing` est ambigu) : le marqueur est confirmé seulement si la base porte le jeton de
/// restauration qu'il contient (`backup::database_token`), sinon annulé (marqueur d'avant remis, ou provisoire retiré). Si la confirmation ou
/// l'annulation échoue, le marqueur reste provisoire (la décision se reprend, identique, au prochain essai) : la fenêtre de choix le dit
/// (`sync.restore.provisional`), « Appliquer partout » reste retiré, une nouvelle restauration est refusée, et le journal le consigne.
/// Rend vrai si le marqueur n'est plus provisoire. Récupération en erreur : rien n'est touché (la porte reste fermée).
pub fn settle_provisional_marker(config_dir: &Path, recovery: &Result<crate::backup::Recovery, crate::backup::BackupError>) -> bool {
    let Some(token) = crate::sync::marker::provisional_token(config_dir) else {
        let _ = std::fs::remove_file(config_dir.join(PREVIOUS_MARKER_FILE));
        return true;
    };
    if recovery.is_err() {
        return false;
    }
    // Base en place illisible : on ne décide RIEN (ni confirmation ni annulation), le marqueur reste provisoire et la décision est reprise.
    let Ok(in_place) = crate::backup::database_token(&config_dir.join(crate::backup::DB_FILE)) else {
        crate::applog::write("backup-recovery", "provisional-marker-db-unreadable");
        return false;
    };
    let landed = token.is_some() && in_place == token;
    let done = if landed {
        let confirmed = crate::sync::marker::confirm(config_dir).is_ok();
        if confirmed {
            let _ = std::fs::remove_file(config_dir.join(PREVIOUS_MARKER_FILE));
        }
        confirmed
    } else {
        undo_provisional_marker(config_dir)
    };
    crate::applog::write("backup-recovery", if done { "provisional-marker-settled" } else { "provisional-marker-settle-failed" });
    done
}

/// Récupération au démarrage puis règlement du marqueur provisoire (PC et iPhone).
pub fn recover_and_settle(config_dir: &Path) -> Result<crate::backup::Recovery, crate::backup::BackupError> {
    let recovery = crate::backup::recover_interrupted_restore(&config_dir.join(crate::backup::DB_FILE), &config_dir.join(crate::backup::BACKUP_DIR));
    settle_provisional_marker(config_dir, &recovery);
    if recovery.is_ok() {
        // Revue du lot F : conservation des dossiers mis de côté (30 jours).
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let purged = purge_set_aside(config_dir, now);
        if purged > 0 {
            crate::applog::write_count("backup-recovery", "set-aside-purged", u32::try_from(purged).unwrap_or(u32::MAX));
        }
    }
    recovery
}
