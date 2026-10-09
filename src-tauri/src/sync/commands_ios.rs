//! Les commandes `sync_*` de l'iPhone (ADR 0011 §22 point 7 et §23 point 5) : mêmes noms, mêmes entrées et sorties que `commands.rs`
//! (PC), le même `SyncCore` (`SyncOptions.platform = "ios"`), avec `BookmarkBackend` (plugin folder-bookmark) au lieu du dossier Windows.
//! Accordées à la seule fenêtre `main` par `capabilities/sync-ios.json` ; **aucune commande de la fenêtre `pairing`** (`sync_pairing_open`,
//! `sync_pairing_payload`, `sync_pairing_close`) n'existe sur iPhone : l'iPhone n'affiche jamais le QR.
//!
//! Compilé pour iOS seulement (les macros de `#[tauri::command]` ne peuvent pas coexister avec celles de `commands.rs`) : la logique
//! (`ios_core`, `choose_with_picker`) est dans `bookmark.rs`, testée sous Windows ; tout appel au plugin est bloquant, fait depuis
//! `spawn_blocking`. La compilation par `build-ios.yml` fait foi pour ce fichier.

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use super::bookmark::{choose_with_picker, import_ios, ios_core, BookmarkBackend, BookmarkTransport, PluginTransport};
use super::consent::ConsentUi;
use super::consent_ios::IosConsentUi;
use crate::vault_ios::CachedVault;
use super::marker::RestoreMarker;
use super::service::{system_clock, AppendRequest, FolderInfo, KeyImportResult, KeyStatus, SyncCore};
use super::store::{AppendResult, FolderScan, OwnFileRef, ReadPage, RecordCursor};
use super::{fail, SyncCode, SyncError, SyncResult};

/// Fenêtre unique de l'iPhone.
pub const MAIN_WINDOW: &str = "main";
/// Propriétaire des confirmations natives sur iPhone (une seule fenêtre, §23 point 3).
const OWNER: isize = 0;

/// Commandes de l'iPhone (Y-IOS-01, Y-IOS-02) : les 24 moins les trois de la fenêtre `pairing`.
pub const IOS_SYNC_COMMANDS: [&str; 22] = [
    "sync_folder_info",
    "sync_folder_choose",
    "sync_folder_forget",
    "sync_bind_device",
    "sync_key_status",
    "sync_key_create",
    "sync_scan",
    "sync_read_journal",
    "sync_append_journal",
    "sync_write_state",
    "sync_snapshot_begin",
    "sync_snapshot_append",
    "sync_snapshot_commit",
    "sync_read_snapshot",
    "sync_delete_own",
    "sync_abandon_orphan_epoch",
    "sync_restore_marker_get",
    "sync_restore_marker_clear",
    "sync_forgotten_delete",
    "sync_key_import",
    "sync_device_forget",
    "sync_reset_key",
];

/// Transport du plugin folder-bookmark, géré par son `init()` (`lib.rs`, bloc iOS).
fn plugin_transport<R: Runtime>(app: &AppHandle<R>) -> SyncResult<Arc<dyn BookmarkTransport>> {
    let plugin = app.try_state::<tauri_plugin_folder_bookmark::FolderBookmark<R>>().ok_or(SyncError::new(SyncCode::Io))?;
    Ok(Arc::new(PluginTransport(plugin.inner().clone())))
}

/// Confirmation native de l'iPhone (§23 point 3) : `UIAlertController` du plugin folder-bookmark, textes lus par Rust.
fn consent_ui(transport: &Arc<dyn BookmarkTransport>) -> Arc<dyn ConsentUi> {
    Arc::new(IosConsentUi::new(transport.clone()))
}

/// État géré par Tauri : service et contrôle du dossier créés au premier appel (dossier de configuration et plugin connus).
#[derive(Default)]
pub struct SyncState {
    core: OnceLock<(Arc<SyncCore>, Arc<BookmarkBackend>)>,
}

impl SyncState {
    fn get<R: Runtime>(&self, app: &AppHandle<R>) -> SyncResult<(Arc<SyncCore>, Arc<BookmarkBackend>)> {
        if let Some(pair) = self.core.get() {
            return Ok(pair.clone());
        }
        let base = app.path().app_config_dir().map_err(|_| SyncError::new(SyncCode::Io))?;
        let transport = plugin_transport(app)?;
        let ui = consent_ui(&transport);
        // §23 point 1 : la clé lue reste en mémoire (cycle du passage en arrière-plan, écran verrouillé).
        let vault = Arc::new(CachedVault::new(crate::vault::sync_key_vault()));
        let pair = ios_core(base, transport, vault, ui, system_clock());
        Ok(self.core.get_or_init(|| pair).clone())
    }

    fn core<R: Runtime>(&self, app: &AppHandle<R>) -> SyncResult<Arc<SyncCore>> {
        self.get(app).map(|(core, _)| core)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> SyncResult<T> + Send + 'static) -> SyncResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| SyncError::new(SyncCode::Io))?
}

/// Seule la fenêtre `main` (la capability le garantit ; contrôle redondant).
fn require_main<R: Runtime>(window: &WebviewWindow<R>) -> SyncResult<()> {
    if window.label() == MAIN_WINDOW {
        Ok(())
    } else {
        fail(SyncCode::WrongWindow)
    }
}

#[derive(Serialize)]
pub struct KeyCreated {
    kid: String,
}

#[derive(Serialize)]
pub struct SnapshotHandle {
    handle: u32,
}

#[derive(Serialize)]
pub struct Deleted {
    deleted: u64,
}

#[derive(Serialize)]
pub struct ForgottenDeleted {
    deleted: u64,
    complete: bool,
}

// ------------------------------------------------------------------------------------------------------------------------------
// Dossier
// ------------------------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_folder_info<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<FolderInfo> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.folder_info()).await
}

/// Sélecteur de dossier du plugin (`UIDocumentPickerViewController`, §22 point 5) : annulé → `null`, rien n'est écrit, aucune erreur ;
/// erreur du sélecteur → code seul. Choisir la racine d'iCloud Drive crée puis lie `CircleTasks` dessous (Swift).
#[tauri::command]
pub async fn sync_folder_choose<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<Option<FolderInfo>> {
    require_main(&window)?;
    let (core, backend) = state.get(&app)?;
    blocking(move || choose_with_picker(&core, &backend)).await
}

#[tauri::command]
pub async fn sync_folder_forget<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, erase_key: bool) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.forget_folder(erase_key, OWNER)).await
}

#[tauri::command]
pub async fn sync_bind_device<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, device_id: String) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.bind_device(&device_id)).await
}

// ------------------------------------------------------------------------------------------------------------------------------
// Clé
// ------------------------------------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_key_status<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<KeyStatus> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.key_status()).await
}

#[tauri::command]
pub async fn sync_key_create<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<KeyCreated> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.key_create().map(|kid| KeyCreated { kid })).await
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fichiers
// ------------------------------------------------------------------------------------------------------------------------------

/// `hydrate_budget_ms` (§22 point 4) : budget d'hydratation réduit du cycle `hide` (1 à 180 000, sinon `bad-name`).
#[tauri::command]
pub async fn sync_scan<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, keep: Vec<String>, hydrate_budget_ms: Option<u64>) -> SyncResult<FolderScan> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.scan_within(&keep, hydrate_budget_ms)).await
}

#[tauri::command]
pub async fn sync_read_journal<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
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
pub async fn sync_append_journal<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
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
pub async fn sync_write_state<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, sync: State<'_, SyncState>, sv: u64, state: serde_json::Value) -> SyncResult<()> {
    require_main(&window)?;
    let core = sync.core(&app)?;
    blocking(move || core.write_state(sv, state)).await
}

#[tauri::command]
pub async fn sync_snapshot_begin<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, epoch: String, seq: u64, sv: u64) -> SyncResult<SnapshotHandle> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_begin(&epoch, seq, sv).map(|handle| SnapshotHandle { handle })).await
}

#[tauri::command]
pub async fn sync_snapshot_append<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, handle: u32, records: Vec<String>) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_append(handle, &records)).await
}

#[tauri::command]
pub async fn sync_snapshot_commit<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, handle: u32) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.snapshot_commit(handle)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_read_snapshot<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, SyncState>,
    device_id: String,
    epoch: String,
    seq: u64,
    from_record: u64,
    max_bytes: Option<u64>,
    tail: Option<bool>,
) -> SyncResult<ReadPage> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.read_snapshot_with(&device_id, &epoch, seq, from_record, max_bytes, tail == Some(true))).await
}

#[tauri::command]
pub async fn sync_delete_own<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, files: Vec<OwnFileRef>) -> SyncResult<Deleted> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.delete_own(&files).map(|deleted| Deleted { deleted })).await
}

/// Y-IOS-02 (ADR 0011 §24 point 4 (b)) : `own.json` revient sans époque pour une époque orpheline (preuve recontrôlée).
#[tauri::command]
pub async fn sync_abandon_orphan_epoch<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, epoch: String) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.abandon_orphan_epoch(&epoch)).await
}

#[tauri::command]
pub async fn sync_restore_marker_get<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<Option<RestoreMarker>> {
    require_main(&window)?;
    // P-04-iOS critère 12 : un marqueur de restauration non écrit est réessayé ici ; nouvel échec -> erreur (aucun cycle).
    crate::startup_gate::retry_pending_marker(&app)?;
    let core = state.core(&app)?;
    blocking(move || core.restore_marker()).await
}

#[tauri::command]
pub async fn sync_restore_marker_clear<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.clear_restore_marker()).await
}

/// Y-10 : suppression des fichiers d'un appareil oublié, appelée par le cycle (sans boîte) ; conditions recalculées par Rust.
#[tauri::command]
pub async fn sync_forgotten_delete<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, device_id: String) -> SyncResult<ForgottenDeleted> {
    require_main(&window)?;
    let core = state.core(&app)?;
    let result = blocking(move || core.forgotten_delete(&device_id)).await?;
    Ok(ForgottenDeleted { deleted: result.deleted, complete: result.complete })
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-IOS-02 (ADR 0011 §23) : clé importée depuis `main`, oubli d'un appareil, réinitialisation ; confirmations par `IosConsentUi`
// ------------------------------------------------------------------------------------------------------------------------------

/// `sync_key_import({ qrText } | { recoveryKey })` depuis `main`, au premier plan (`appState`) ; `{ scan: true }` refusé (`invalid-pairing`).
#[tauri::command]
pub async fn sync_key_import<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, SyncState>,
    qr_text: Option<String>,
    recovery_key: Option<String>,
    scan: Option<bool>,
) -> SyncResult<KeyImportResult> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || import_ios(&core, qr_text, recovery_key, scan)).await
}

/// Y-10 : déclaration d'oubli d'un autre appareil, après la confirmation native de l'iPhone.
#[tauri::command]
pub async fn sync_device_forget<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>, device_id: String) -> SyncResult<()> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.device_forget(&device_id, OWNER)).await
}

/// Y-11 : réinitialisation avec une nouvelle clé, après la confirmation native de l'iPhone ; seul le `kid` est rendu.
#[tauri::command]
pub async fn sync_reset_key<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, SyncState>) -> SyncResult<KeyCreated> {
    require_main(&window)?;
    let core = state.core(&app)?;
    blocking(move || core.reset_key(OWNER).map(|kid| KeyCreated { kid })).await
}
