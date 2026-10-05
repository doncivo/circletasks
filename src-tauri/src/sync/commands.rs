//! Les 21 commandes `sync_*` (ADR 0011 section 11.1), PC. Déclarées dans `build.rs` ; `capabilities/sync.json` en accorde 18 à la
//! fenêtre `main`, `capabilities/sync-pairing.json` accorde `sync_pairing_payload`, `sync_key_import` et `sync_pairing_close` à la
//! seule fenêtre `pairing`. Rejets : `{ code, message }` sans chemin, sans clé, sans recopie de l'entrée.
//!
//! Chaque commande est mince : la logique est dans `service::SyncCore` (testée sans fenêtre). Ici : boîte système de choix du
//! dossier, création de la fenêtre `pairing` (masquée, `WDA_EXCLUDEFROMCAPTURE`, minuteur), contrôles de la fenêtre appelante.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use super::consent::{ConsentGate, WindowsConsentUi};
use super::folder::{config_dir, DEFAULT_FOLDER_NAME, ICLOUD_DRIVE_DIR};
use super::marker::RestoreMarker;
use super::pairing::{Caller, PairingMode, PairingRegistry, PAIRING_PAGE, PAIRING_WINDOW};
use super::service::{system_clock, AppendRequest, FolderInfo, KeyImportResult, KeyInput, KeyStatus, PairingPayload, SyncCore, SyncOptions, SystemBackend};
use super::store::{AppendResult, FolderScan, OwnFileRef, ReadPage, RecordCursor};
use super::{fail, log, SyncCode, SyncError, SyncResult};
use crate::desktop::MAIN_WINDOW;

/// Événement émis vers `main` à la réussite d'un appairage (sans clé).
pub const PAIRED_EVENT: &str = "sync-paired";
/// Taille logique de la fenêtre `pairing` (PC-Appairage.html).
const PAIRING_WIDTH: f64 = 440.0;
const PAIRING_HEIGHT: f64 = 640.0;

/// État géré par Tauri : service créé au premier appel (dossier de configuration connu), registre de la fenêtre `pairing`.
#[derive(Default)]
pub struct SyncState {
    core: OnceLock<Arc<SyncCore>>,
    pairing: Arc<PairingRegistry>,
}

impl SyncState {
    fn core(&self, app: &AppHandle) -> SyncResult<Arc<SyncCore>> {
        if let Some(core) = self.core.get() {
            return Ok(core.clone());
        }
        let base = app.path().app_config_dir().map_err(|_| SyncError::new(SyncCode::Io))?;
        let clock = system_clock();
        let consent = Arc::new(ConsentGate::new(config_dir(&base), Arc::new(WindowsConsentUi), clock.clone()));
        let core = Arc::new(SyncCore::new(SyncOptions::new(base), Arc::from(crate::vault::sync_key_vault()), Arc::new(SystemBackend), consent, clock));
        Ok(self.core.get_or_init(|| core).clone())
    }
}

fn hwnd_of(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}


async fn blocking<T: Send + 'static>(f: impl FnOnce() -> SyncResult<T> + Send + 'static) -> SyncResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| SyncError::new(SyncCode::Io))?
}

/// Seule la fenêtre `main` appelle les 18 commandes qui lui sont accordées (la capability le garantit ; contrôle redondant).
fn require_main(window: &WebviewWindow) -> SyncResult<()> {
    if window.label() == MAIN_WINDOW {
        Ok(())
    } else {
        fail(SyncCode::WrongWindow)
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Dossier
// ------------------------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_folder_info(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<FolderInfo> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.folder_info()).await
}

/// Boîte système de choix de dossier, ouverte par Rust ; dossier proposé `%USERPROFILE%\iCloudDrive\CircleTasks` (créé s'il
/// n'existe pas, puis retiré s'il reste vide après une annulation). Annulation : `null`.
#[tauri::command]
pub async fn sync_folder_choose(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<Option<FolderInfo>> {
    require_main(&window)?;
    let core = state.core(&app)?;
    let proposed = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(ICLOUD_DRIVE_DIR)).filter(|drive| drive.is_dir()).map(|drive| drive.join(DEFAULT_FOLDER_NAME));
    let created = match &proposed {
        Some(dir) if !dir.exists() => std::fs::create_dir(dir).is_ok(),
        _ => false,
    };
    let dialog_app = app.clone();
    let start = proposed.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app.dialog().file();
        if let Some(dir) = &start {
            dialog = dialog.set_directory(dir);
        }
        if let Some(main) = dialog_app.get_webview_window(MAIN_WINDOW) {
            dialog = dialog.set_parent(&main);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|_| SyncError::new(SyncCode::Io))?;
    let path = chosen.and_then(|file| file.into_path().ok());
    if created {
        if let Some(dir) = &proposed {
            if path.as_deref() != Some(dir.as_path()) {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }
    let Some(path) = path else { return Ok(None) };
    blocking(move || core.choose_folder(&path).map(Some)).await
}

#[tauri::command]
pub async fn sync_folder_forget(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, erase_key: bool) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    let owner = hwnd_of(&window);
    blocking(move || core.forget_folder(erase_key, owner)).await
}

#[tauri::command]
pub async fn sync_bind_device(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, device_id: String) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.bind_device(&device_id)).await
}

// ------------------------------------------------------------------------------------------------------------------------------
// Clé
// ------------------------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_key_status(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<KeyStatus> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.key_status()).await
}

#[derive(Serialize)]
pub struct KeyCreated {
    kid: String,
}

#[tauri::command]
pub async fn sync_key_create(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<KeyCreated> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.key_create().map(|kid| KeyCreated { kid })).await
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fenêtre `pairing`
// ------------------------------------------------------------------------------------------------------------------------------

fn caller_url(window: &WebviewWindow) -> String {
    window.url().map(|u| u.to_string()).unwrap_or_default()
}

fn destroy_pairing(app: &AppHandle, registry: &PairingRegistry, hwnd: isize) {
    registry.clear(hwnd);
    if let Some(window) = app.get_webview_window(PAIRING_WINDOW) {
        if hwnd_of(&window) == hwnd {
            let _ = window.destroy();
        }
    }
}

#[cfg(windows)]
fn exclude_from_capture(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    // SAFETY: HWND de la fenêtre que Rust vient de créer, appelé sur son fil propriétaire.
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut core::ffi::c_void), WDA_EXCLUDEFROMCAPTURE) }.is_ok()
}

#[cfg(not(windows))]
fn exclude_from_capture(_hwnd: isize) -> bool {
    false
}

/// Surveille l'instance : échéance de la génération courante, `main` réduite ou masquée → fenêtre détruite.
fn watch_pairing(app: AppHandle, registry: Arc<PairingRegistry>, core: Arc<SyncCore>, hwnd: isize) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let Some(instance) = registry.current().filter(|i| i.hwnd == hwnd) else { return };
        let main_hidden = app
            .get_webview_window(MAIN_WINDOW)
            .map_or(true, |main| !main.is_visible().unwrap_or(false) || main.is_minimized().unwrap_or(true));
        if registry.expire_if_due(hwnd, instance.generation, core.now()) || main_hidden {
            log::event("pairing-destroyed", if main_hidden { "main-hidden" } else { "expired" });
            let handle = app.clone();
            let registry = registry.clone();
            let _ = app.run_on_main_thread(move || destroy_pairing(&handle, &registry, hwnd));
            return;
        }
    });
}

/// `sync_pairing_open({ mode })` (fenêtre `main`) : `show` → confirmation native (propriétaire `main`) puis fenêtre dédiée ; jamais
/// de réutilisation d'une fenêtre existante (libellé occupé avant ou pendant la boîte : `consent-denied`).
#[tauri::command]
pub async fn sync_pairing_open(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, mode: String) -> SyncResult<()> {
    require_main(&window)?;
    let mode = PairingMode::parse(&mode).ok_or(SyncError::new(SyncCode::WrongMode))?;
    let core = state.core(&app)?;
    let registry = state.pairing.clone();
    let check = core.clone();
    blocking(move || check.pairing_preconditions(mode == PairingMode::Show)).await?;
    registry.begin_open(app.get_webview_window(PAIRING_WINDOW).is_some())?;
    let result = open_pairing_window(&app, &window, &core, &registry, mode).await;
    if result.is_err() {
        registry.abort_open();
    }
    result
}

async fn open_pairing_window(app: &AppHandle, main: &WebviewWindow, core: &Arc<SyncCore>, registry: &Arc<PairingRegistry>, mode: PairingMode) -> SyncResult<()> {
    let owner = hwnd_of(main);
    if mode == PairingMode::Show {
        let consent = core.consent().clone();
        blocking(move || consent.confirm_show(owner)).await?;
    } else {
        // Mode `import` : aucune boîte (rien à exfiltrer) ; `main` doit pourtant être au premier plan, sans blocage en cours.
        core.consent().precheck(owner)?;
    }
    // Libellé pris pendant la boîte : refus, rien n'est créé.
    if app.get_webview_window(PAIRING_WINDOW).is_some() {
        log::event("pairing-refused", "label-taken");
        return fail(SyncCode::ConsentDenied);
    }
    let window = WebviewWindowBuilder::new(app, PAIRING_WINDOW, WebviewUrl::App(PAIRING_PAGE.into()))
        .title("CircleTasks")
        .inner_size(PAIRING_WIDTH, PAIRING_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .center()
        .build()
        .map_err(|_| SyncError::new(SyncCode::Io))?;
    let hwnd = hwnd_of(&window);
    // Affinité d'affichage appliquée sur le fil propriétaire, vérifiée avant l'affichage ; échec : fenêtre détruite, rien de renvoyé.
    let (sender, receiver) = std::sync::mpsc::channel();
    let applied = app.run_on_main_thread(move || {
        let _ = sender.send(exclude_from_capture(hwnd));
    });
    let excluded = applied.is_ok() && tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(5)).unwrap_or(false)).await.unwrap_or(false);
    if hwnd == 0 || !excluded {
        let _ = window.destroy();
        log::event("pairing-refused", "display-affinity");
        return fail(SyncCode::Io);
    }
    registry.register(hwnd, mode, core.now());
    let events_app = app.clone();
    let events_registry = registry.clone();
    window.on_window_event(move |event| match event {
        // Croix native : la fenêtre est détruite, jamais seulement masquée.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            destroy_pairing(&events_app, &events_registry, hwnd);
        }
        WindowEvent::Destroyed => events_registry.clear(hwnd),
        _ => {}
    });
    window.show().map_err(|_| SyncError::new(SyncCode::Io))?;
    let _ = window.set_focus();
    watch_pairing(app.clone(), registry.clone(), core.clone(), hwnd);
    log::event("pairing-opened", if mode == PairingMode::Show { "show" } else { "import" });
    Ok(())
}

/// `sync_pairing_payload({ renew? })` (fenêtre `pairing`, instance `show`).
#[tauri::command]
pub async fn sync_pairing_payload(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, renew: Option<bool>) -> SyncResult<PairingPayload> {
    let core = state.core(&app)?;
    let registry = state.pairing.clone();
    let url = caller_url(&window);
    let caller = Caller { label: window.label(), url: &url, hwnd: hwnd_of(&window) };
    let instance = if renew == Some(true) {
        let instance = registry.verify(&caller, core.now())?;
        if instance.mode != PairingMode::Show {
            return fail(SyncCode::WrongMode);
        }
        // « Nouveau code » : nouvelle confirmation dont `pairing` est propriétaire.
        let consent = core.consent().clone();
        let owner = caller.hwnd;
        blocking(move || consent.confirm_show(owner)).await?;
        registry.renew(&caller, instance.generation, core.now())?
    } else {
        registry.take_token(&caller, core.now())?
    };
    let payload_core = core.clone();
    blocking(move || payload_core.pairing_payload(instance.expires_at)).await
}

/// `sync_key_import({ qrText } | { recoveryKey })` (fenêtre `pairing`, instance `import`).
#[tauri::command]
pub async fn sync_key_import(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SyncState>,
    qr_text: Option<String>,
    recovery_key: Option<String>,
    scan: Option<bool>,
) -> SyncResult<KeyImportResult> {
    let qr_text = qr_text.map(Zeroizing::new);
    let recovery_key = recovery_key.map(Zeroizing::new);
    let core = state.core(&app)?;
    let registry = state.pairing.clone();
    let url = caller_url(&window);
    let caller = Caller { label: window.label(), url: &url, hwnd: hwnd_of(&window) };
    let instance = registry.verify(&caller, core.now())?;
    if instance.mode != PairingMode::Import {
        return fail(SyncCode::WrongMode);
    }
    let input = match (qr_text, recovery_key, scan) {
        (Some(text), None, None) => KeyInput::QrText(text),
        (None, Some(text), None) => KeyInput::RecoveryKey(text),
        // Le scan lancé par Rust n'existe que sur l'iPhone (ordre 5).
        _ => return fail(SyncCode::InvalidPairing),
    };
    let owner = caller.hwnd;
    let import_core = core.clone();
    let result = blocking(move || import_core.key_import(input, owner)).await?;
    let _ = app.emit_to(MAIN_WINDOW, PAIRED_EVENT, ());
    destroy_pairing(&app, &registry, instance.hwnd);
    Ok(result)
}

/// `sync_pairing_close()` : détruit la seule fenêtre appelante (aucun paramètre de cible).
#[tauri::command]
pub async fn sync_pairing_close(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<()> {
    let core = state.core(&app)?;
    let url = caller_url(&window);
    let caller = Caller { label: window.label(), url: &url, hwnd: hwnd_of(&window) };
    let instance = state.pairing.verify(&caller, core.now())?;
    destroy_pairing(&app, &state.pairing, instance.hwnd);
    Ok(())
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fichiers
// ------------------------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_scan(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, keep: Vec<String>) -> SyncResult<FolderScan> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.scan(&keep)).await
}

#[tauri::command]
pub async fn sync_read_journal(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SyncState>,
    device_id: String,
    epoch: String,
    from: RecordCursor,
    max_bytes: Option<u64>,
) -> SyncResult<ReadPage> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.read_journal(&device_id, &epoch, from, max_bytes)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_append_journal(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SyncState>,
    epoch: String,
    segment: u64,
    expect_records: u64,
    sv: u64,
    max_hlc: String,
    records: Vec<String>,
) -> SyncResult<AppendResult> {
    require_main(&window)?;
    let core = state.core(&app)?;
    let request = AppendRequest { epoch, segment, expect_records, sv, max_hlc, records };
    blocking(move || core.append_journal(&request)).await
}

#[tauri::command]
pub async fn sync_write_state(app: AppHandle, window: WebviewWindow, sync: State<'_, SyncState>, sv: u64, state: serde_json::Value) -> SyncResult<()> {
    require_main(&window)?;
    let core = sync.core(&app)?;
    blocking(move || core.write_state(sv, state)).await
}

#[derive(Serialize)]
pub struct SnapshotHandle {
    handle: u32,
}

#[tauri::command]
pub async fn sync_snapshot_begin(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, epoch: String, seq: u64, sv: u64) -> SyncResult<SnapshotHandle> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_begin(&epoch, seq, sv).map(|handle| SnapshotHandle { handle })).await
}

#[tauri::command]
pub async fn sync_snapshot_append(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, handle: u32, records: Vec<String>) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_append(handle, &records)).await
}

#[tauri::command]
pub async fn sync_snapshot_commit(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, handle: u32) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_commit(handle)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_read_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SyncState>,
    device_id: String,
    epoch: String,
    seq: u64,
    from_record: u64,
    max_bytes: Option<u64>,
) -> SyncResult<ReadPage> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.read_snapshot(&device_id, &epoch, seq, from_record, max_bytes)).await
}

#[derive(Serialize)]
pub struct Deleted {
    deleted: u64,
}

#[tauri::command]
pub async fn sync_delete_own(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>, files: Vec<OwnFileRef>) -> SyncResult<Deleted> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.delete_own(&files).map(|deleted| Deleted { deleted })).await
}

#[tauri::command]
pub async fn sync_restore_marker_get(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<Option<RestoreMarker>> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.restore_marker()).await
}

#[tauri::command]
pub async fn sync_restore_marker_clear(app: AppHandle, window: WebviewWindow, state: State<'_, SyncState>) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.clear_restore_marker()).await
}
