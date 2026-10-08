//! iPhone : accès au dossier `iCloud Drive/CircleTasks` par le signet de sécurité du plugin Swift folder-bookmark (ADR 0011 §6.3 et §22 ;
//! Y-IOS-01).
//!
//! `BookmarkFs` implémente `SyncFs` au-dessus d'un transport injectable (`BookmarkTransport`) : le plugin sur iOS (`PluginTransport`), un
//! faux en mémoire qui parle exactement le même JSON dans les tests Windows (`tests/desktop/support/fake_bookmark.rs`). Le contrat des
//! commandes est fixé par `tests/fixtures/sync/folder-bookmark-contract.json` (contrôle statique des deux côtés). Chiffrement, noms,
//! bornes et anti-rejeu restent dans `store.rs` : ce module ne fait que déplacer des octets.
//!
//! - Chemins : **composants relatifs à la racine** (tableau JSON), déjà validés par `names.rs`, recontrôlés ici (`is_safe_component`)
//!   et par Swift ; jamais un chemin absolu.
//! - Octets en base64, 1 Mio au plus par appel (`MAX_PLUGIN_CHUNK_BYTES`).
//! - Erreur : le **code** rejeté par Swift, ramené à `FsError` (codes existants seulement) ; un code inconnu donne `Io` et le journal
//!   `bookmark-unknown-code`. L'absence (`missing`, `removed: false`) et la présence (`exists`) ne sont pas des erreurs du plugin.
//! - Budget d'hydratation : 60 s par fichier, 3 minutes par cycle (moins pour `hydrateBudgetMs`), tenu ici sur l'horloge injectée.
//! - `not-configured` (racine pas encore résolue dans la session du plugin) : un `resolve` puis un seul nouvel essai, sinon `Unreachable`.
//!
//! Compilé sous `cfg(any(target_os = "ios", feature = "test-hooks"))` : présent dans les tests Windows, absent du binaire PC livré.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::files::{is_safe_component, AppendMode, Availability, Chunk, FsEntry, FsError, Listing, SyncFs};
use super::folder::{CheckedFolder, FolderKind, FolderRecord};
use super::limits::{HYDRATE_CYCLE_TIMEOUT_MS, HYDRATE_FILE_TIMEOUT_MS, MAX_PLUGIN_CHUNK_BYTES};
use super::service::{Clock, FolderBackend};
use super::{fail, log, SyncCode, SyncError, SyncResult};

/// Transport des commandes du plugin : nom exact de la méthode Swift (lowerCamelCase), arguments JSON ; erreur = code rejeté.
pub trait BookmarkTransport: Send + Sync {
    fn call(&self, command: &str, args: Value) -> Result<Value, String>;
}

/// Commandes du plugin appelées par Rust (contrat §22 point 2 ; `confirm` et `appState` servent aussi à `consent_ios.rs`).
pub const PLUGIN_COMMANDS: [&str; 14] = [
    "pickFolder", "resolve", "status", "list", "readFrom", "download", "append", "writeAtomic", "rename", "createDir", "remove", "removeEmptyDir", "appState", "confirm",
];

/// Codes que Swift peut rejeter (tous des `SyncErrorCode` existants).
pub const PLUGIN_REJECT_CODES: [&str; 8] = ["not-configured", "folder-unreachable", "unsafe-folder", "cloud-pending", "cloud-error", "too-large", "not-foreground", "io"];

/// Plus grand entier transmis comme borne « sans limite » (entier exact en JSON et en `Int` Swift 64 bits).
const NO_LIMIT: u64 = (1 << 53) - 1;

/// Code de rejet du plugin → erreur d'accès. Un code inconnu (version du plugin plus récente, message de Tauri sans code) : `Io`, journal
/// du seul code s'il a la forme d'un code (sinon `invalid`), jamais d'un texte.
pub fn fs_error_of(code: &str) -> FsError {
    match code {
        "folder-unreachable" | "not-configured" => FsError::Unreachable,
        "unsafe-folder" => FsError::Unsafe,
        "cloud-pending" => FsError::CloudPending,
        "cloud-error" => FsError::CloudError,
        "too-large" => FsError::TooLarge,
        "io" => FsError::Io,
        other => {
            let shaped = !other.is_empty() && other.len() <= 32 && other.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
            log::event("bookmark-unknown-code", if shaped { other } else { "invalid" });
            FsError::Io
        }
    }
}

/// Code de rejet → erreur de commande (code existant seulement).
pub fn sync_error_of(code: &str) -> SyncError {
    match code {
        "not-foreground" => SyncError::new(SyncCode::NotForeground),
        other => SyncError::new(fs_error_of(other).code()),
    }
}

/// Composants relatifs à la racine, recontrôlés (défense en profondeur) ; `allow_root` : liste ou état de la racine elle-même.
fn components(parts: &[&str], allow_root: bool) -> Result<Value, FsError> {
    if parts.is_empty() && !allow_root {
        return Err(FsError::Unsafe);
    }
    if parts.iter().any(|p| !is_safe_component(p)) {
        return Err(FsError::Unsafe);
    }
    Ok(Value::Array(parts.iter().map(|p| Value::String((*p).to_owned())).collect()))
}

fn availability_of(value: Option<&Value>) -> Availability {
    match value.and_then(Value::as_str) {
        Some("local") => Availability::Local,
        Some("cloud") => Availability::Cloud,
        _ => Availability::Error,
    }
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn decode(value: &Value) -> Result<Vec<u8>, FsError> {
    let text = value.get("data").and_then(Value::as_str).ok_or(FsError::Io)?;
    STANDARD.decode(text).map_err(|_| FsError::Io)
}

/// Accès aux fichiers par le plugin (voir le module).
pub struct BookmarkFs {
    transport: Arc<dyn BookmarkTransport>,
    /// Chemin résolu attendu de la racine (gardé par Rust) : une racine déplacée est injoignable.
    root: String,
    bookmark: Mutex<String>,
    /// Signet rafraîchi par un `resolve`, à réécrire dans `folder.json` (`FolderBackend::take_refreshed`).
    refreshed: Arc<Mutex<Option<String>>>,
    now: Clock,
    /// Début (ms) et budget (ms) du cycle d'hydratation en cours.
    cycle: Mutex<(u64, u64)>,
}

impl BookmarkFs {
    pub fn new(transport: Arc<dyn BookmarkTransport>, root: String, bookmark: String, refreshed: Arc<Mutex<Option<String>>>, now: Clock) -> Self {
        let started = now();
        Self { transport, root, bookmark: Mutex::new(bookmark), refreshed, now, cycle: Mutex::new((started, HYDRATE_CYCLE_TIMEOUT_MS)) }
    }

    /// `resolve` du signet : racine rouverte dans la session du plugin, signet obsolète rafraîchi, racine déplacée refusée.
    fn resolve(&self) -> Result<(), FsError> {
        let bookmark = self.bookmark.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if bookmark.is_empty() {
            log::event("bookmark-missing", "resolve");
            return Err(FsError::Unreachable);
        }
        let out = self.transport.call("resolve", json!({ "bookmark": bookmark })).map_err(|code| fs_error_of(&code))?;
        if out.get("path").and_then(Value::as_str) != Some(self.root.as_str()) {
            log::event("bookmark-moved", "resolve");
            return Err(FsError::Unreachable);
        }
        if let Some(fresh) = out.get("refreshed").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            *self.bookmark.lock().unwrap_or_else(|e| e.into_inner()) = fresh.to_owned();
            *self.refreshed.lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh.to_owned());
        }
        Ok(())
    }

    /// Appel d'une commande de fichier ; `not-configured` : un `resolve`, puis un seul nouvel essai.
    fn call(&self, command: &str, args: Value) -> Result<Value, FsError> {
        match self.transport.call(command, args.clone()) {
            Ok(value) => Ok(value),
            Err(code) if code == "not-configured" => {
                self.resolve()?;
                self.transport.call(command, args).map_err(|code| fs_error_of(&code))
            }
            Err(code) => Err(fs_error_of(&code)),
        }
    }

    /// Délai de la prochaine hydratation : 60 s, et jamais au-delà du reste du budget du cycle.
    fn hydrate_timeout(&self) -> u64 {
        let (started, budget) = *self.cycle.lock().unwrap_or_else(|e| e.into_inner());
        let elapsed = (self.now)().saturating_sub(started);
        budget.saturating_sub(elapsed).min(HYDRATE_FILE_TIMEOUT_MS)
    }

    /// Téléchargement forcé d'un fichier dans le nuage (`download`), sous le budget.
    fn download(&self, path: &Value, limit: u64) -> Result<(), FsError> {
        let timeout = self.hydrate_timeout();
        if timeout == 0 {
            return Err(FsError::CloudPending);
        }
        self.call("download", json!({ "path": path, "timeoutMs": timeout, "limit": limit })).map(|_| ())
    }

    /// Un bloc `readFrom` : `None` si le fichier est absent.
    fn read_block(&self, path: &Value, offset: u64, max: usize, limit: u64) -> Result<Chunk, FsError> {
        let out = self.call("readFrom", json!({ "path": path, "offset": offset, "max": max.min(MAX_PLUGIN_CHUNK_BYTES), "limit": limit }))?;
        if flag(&out, "missing") {
            return Err(FsError::NotFound);
        }
        let bytes = decode(&out)?;
        if bytes.len() > max {
            return Err(FsError::Io);
        }
        let size = out.get("size").and_then(Value::as_u64).ok_or(FsError::Io)?;
        Ok(Chunk { bytes, size, eof: flag(&out, "eof") })
    }
}

impl SyncFs for BookmarkFs {
    fn check_root(&self) -> Result<(), FsError> {
        self.resolve()
    }

    fn start_cycle(&self) -> Result<(), FsError> {
        self.start_cycle_within(std::time::Duration::from_millis(HYDRATE_CYCLE_TIMEOUT_MS))
    }

    fn start_cycle_within(&self, budget: std::time::Duration) -> Result<(), FsError> {
        self.resolve()?;
        let budget = (budget.as_millis() as u64).min(HYDRATE_CYCLE_TIMEOUT_MS);
        *self.cycle.lock().unwrap_or_else(|e| e.into_inner()) = ((self.now)(), budget);
        Ok(())
    }

    fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
        let path = components(file, false)?;
        Ok(self.read_block(&path, 0, max, NO_LIMIT)?.bytes)
    }

    fn list(&self, dir: &[&str], max: usize) -> Result<Listing, FsError> {
        let path = components(dir, true)?;
        let out = self.call("list", json!({ "path": path, "max": max }))?;
        if flag(&out, "missing") {
            return Err(FsError::NotFound);
        }
        let mut listing = Listing { entries: Vec::new(), truncated: flag(&out, "truncated") };
        for entry in out.get("entries").and_then(Value::as_array).ok_or(FsError::Io)? {
            if listing.entries.len() >= max {
                listing.truncated = true;
                break;
            }
            let name = entry.get("name").and_then(Value::as_str).ok_or(FsError::Io)?.to_owned();
            listing.entries.push(FsEntry {
                name,
                is_dir: flag(entry, "isDir"),
                size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                availability: availability_of(entry.get("availability")),
            });
        }
        Ok(listing)
    }

    fn read(&self, file: &[&str], limit: u64, hydrate: bool) -> Result<Vec<u8>, FsError> {
        let path = components(file, false)?;
        let status = self.call("status", json!({ "path": path }))?;
        if !flag(&status, "exists") {
            return Err(FsError::NotFound);
        }
        if flag(&status, "isDir") {
            return Err(FsError::Unsafe);
        }
        // Taille annoncée contrôlée avant toute lecture ou hydratation (section 1.6).
        if status.get("size").and_then(Value::as_u64).is_some_and(|size| size > limit) {
            return Err(FsError::TooLarge);
        }
        match availability_of(status.get("availability")) {
            Availability::Local => {}
            Availability::Error => return Err(FsError::Unsafe),
            Availability::Cloud if !hydrate => return Err(FsError::CloudPending),
            Availability::Cloud => self.download(&path, limit)?,
        }
        let mut out = Vec::new();
        loop {
            let chunk = self.read_block(&path, out.len() as u64, MAX_PLUGIN_CHUNK_BYTES, limit)?;
            // Taille contrôlée pendant la lecture aussi (fichier qui grossit entre deux blocs).
            if chunk.size > limit || out.len() as u64 + chunk.bytes.len() as u64 > limit {
                return Err(FsError::TooLarge);
            }
            let empty = chunk.bytes.is_empty();
            out.extend_from_slice(&chunk.bytes);
            if chunk.eof {
                return Ok(out);
            }
            if empty {
                // Aucun progrès avant la fin annoncée : fichier en cours de transfert.
                return Err(FsError::CloudPending);
            }
        }
    }

    fn read_from(&self, file: &[&str], offset: u64, max: usize, hydrate: bool) -> Result<Chunk, FsError> {
        let path = components(file, false)?;
        match self.read_block(&path, offset, max, NO_LIMIT) {
            Err(FsError::CloudPending) if hydrate => {
                self.download(&path, NO_LIMIT)?;
                self.read_block(&path, offset, max, NO_LIMIT)
            }
            other => other,
        }
    }

    fn append(&self, file: &[&str], bytes: &[u8], mode: AppendMode) -> Result<(), FsError> {
        let path = components(file, false)?;
        let mut create = mode == AppendMode::CreateNew;
        // Un appel de 1 Mio au plus : une page d'instantané plus grande part en plusieurs ajouts (un arrêt entre deux laisse une ligne
        // incomplète, comme un arrêt pendant l'écriture : `.tmp` ignoré, ou `segment-mismatch` puis rotation).
        let mut pieces: Vec<&[u8]> = bytes.chunks(MAX_PLUGIN_CHUNK_BYTES).collect();
        if pieces.is_empty() {
            pieces.push(&[]);
        }
        for piece in pieces {
            let out = self.call("append", json!({ "path": path, "data": STANDARD.encode(piece), "createNew": create }))?;
            if flag(&out, "missing") {
                return Err(FsError::NotFound);
            }
            if flag(&out, "exists") {
                return Err(FsError::Exists);
            }
            create = false;
        }
        Ok(())
    }

    fn write_atomic(&self, file: &[&str], bytes: &[u8]) -> Result<(), FsError> {
        let path = components(file, false)?;
        // Seuls `state.ctx` et `state.next.ctx` (moins de 1 Mio) sont écrits ainsi.
        if bytes.len() > MAX_PLUGIN_CHUNK_BYTES {
            return Err(FsError::TooLarge);
        }
        self.call("writeAtomic", json!({ "path": path, "data": STANDARD.encode(bytes) })).map(|_| ())
    }

    fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError> {
        let path = components(dir, false)?;
        if !is_safe_component(from) || !is_safe_component(to) {
            return Err(FsError::Unsafe);
        }
        self.call("rename", json!({ "dir": path, "from": from, "to": to })).map(|_| ())
    }

    fn create_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        let path = components(dir, false)?;
        self.call("createDir", json!({ "path": path })).map(|_| ())
    }

    fn remove_file(&self, file: &[&str]) -> Result<bool, FsError> {
        let path = components(file, false)?;
        let out = self.call("remove", json!({ "path": path }))?;
        Ok(flag(&out, "removed"))
    }

    fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        let path = components(dir, false)?;
        self.call("removeEmptyDir", json!({ "path": path })).map(|_| ())
    }

    /// Pas d'épinglage sur iOS (§22 point 4) : aucun appel, `pinned` toujours faux.
    fn pin(&self, _file: &[&str]) -> Result<(), FsError> {
        Ok(())
    }
}

/// Contrôle du dossier et accès aux fichiers sur iPhone (§22 point 5) : `check` = `resolve` du signet de `folder.json`, `open` =
/// `BookmarkFs`. Le signet rafraîchi par un recontrôle est rendu au service (`take_refreshed`), qui le réécrit dans `folder.json`.
pub struct BookmarkBackend {
    transport: Arc<dyn BookmarkTransport>,
    refreshed: Arc<Mutex<Option<String>>>,
    now: Clock,
}

impl BookmarkBackend {
    pub fn new(transport: Arc<dyn BookmarkTransport>, now: Clock) -> Self {
        Self { transport, refreshed: Arc::new(Mutex::new(None)), now }
    }

    /// Sélecteur de dossier du plugin (`pickFolder`) : `None` si l'utilisateur annule ; sinon (chemin résolu, signet). Erreur : code seul,
    /// jamais un chemin ni le texte de Swift.
    pub fn pick(&self) -> SyncResult<Option<(String, String)>> {
        let out = self.transport.call("pickFolder", json!({})).map_err(|code| sync_error_of(&code))?;
        if flag(&out, "cancelled") {
            return Ok(None);
        }
        let path = out.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).ok_or(SyncError::new(SyncCode::Io))?;
        let bookmark = out.get("bookmark").and_then(Value::as_str).filter(|b| !b.is_empty()).ok_or(SyncError::new(SyncCode::Io))?;
        Ok(Some((path.to_owned(), bookmark.to_owned())))
    }
}

impl FolderBackend for BookmarkBackend {
    /// Sans signet, aucun dossier n'est joignable sur iPhone (le choix passe par `pickFolder`).
    fn check(&self, _path: &Path) -> SyncResult<CheckedFolder> {
        fail(SyncCode::FolderUnreachable)
    }

    fn open(&self, folder: &CheckedFolder) -> Box<dyn SyncFs> {
        Box::new(BookmarkFs::new(self.transport.clone(), folder.path.to_string_lossy().into_owned(), String::new(), self.refreshed.clone(), self.now.clone()))
    }

    fn check_record(&self, record: &FolderRecord) -> SyncResult<(CheckedFolder, Option<String>)> {
        // Signet absent (réinstallation, `folder.json` d'une autre version) : dossier injoignable, « choisissez de nouveau le dossier ».
        let Some(bookmark) = record.bookmark.as_deref().filter(|b| !b.is_empty()) else {
            log::event("bookmark-missing", "check");
            return fail(SyncCode::FolderUnreachable);
        };
        let out = self.transport.call("resolve", json!({ "bookmark": bookmark })).map_err(|code| sync_error_of(&code))?;
        let path = out.get("path").and_then(Value::as_str).ok_or(SyncError::new(SyncCode::Io))?;
        // Dossier déplacé ou renommé (le signet le suit) : injoignable, à choisir de nouveau (jamais un autre dossier en silence).
        if path != record.path {
            log::event("bookmark-moved", "check");
            return fail(SyncCode::FolderUnreachable);
        }
        let kind = match out.get("kind").and_then(Value::as_str) {
            Some("icloud") => FolderKind::Icloud,
            Some("local") => FolderKind::Local,
            _ => FolderKind::Unknown,
        };
        let refreshed = out.get("refreshed").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        Ok((CheckedFolder { path: PathBuf::from(path), kind, pinned: false }, refreshed))
    }

    fn open_record(&self, folder: &CheckedFolder, record: &FolderRecord) -> Box<dyn SyncFs> {
        Box::new(BookmarkFs::new(
            self.transport.clone(),
            folder.path.to_string_lossy().into_owned(),
            record.bookmark.clone().unwrap_or_default(),
            self.refreshed.clone(),
            self.now.clone(),
        ))
    }

    fn take_refreshed(&self) -> Option<String> {
        self.refreshed.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Service de synchro de l'iPhone (§22 point 7) : `SyncCore` (`platform = "ios"`) sur `BookmarkBackend`, avec le coffre et l'interface de
/// confirmation donnés ; rend aussi le contrôle du dossier (sélecteur). Utilisé par `commands_ios.rs` (iOS) et par les tests Windows.
pub fn ios_core(
    base: std::path::PathBuf,
    transport: Arc<dyn BookmarkTransport>,
    vault: Arc<dyn crate::vault::SecretVault>,
    consent_ui: Arc<dyn super::consent::ConsentUi>,
    clock: Clock,
) -> (Arc<super::service::SyncCore>, Arc<BookmarkBackend>) {
    let backend = Arc::new(BookmarkBackend::new(transport, clock.clone()));
    let consent = Arc::new(super::consent::ConsentGate::new(super::folder::config_dir(&base), consent_ui, clock.clone()));
    let mut options = super::service::SyncOptions::new(base);
    options.platform = "ios";
    let core = Arc::new(super::service::SyncCore::new(options, vault, backend.clone(), consent, clock));
    (core, backend)
}

/// `sync_folder_choose` sur iPhone (§22 point 5) : sélecteur du plugin ; annulé → `None`, rien n'est écrit ; sinon dossier lié par son signet.
pub fn choose_with_picker(core: &super::service::SyncCore, backend: &BookmarkBackend) -> SyncResult<Option<super::service::FolderInfo>> {
    let Some((path, bookmark)) = backend.pick()? else { return Ok(None) };
    core.choose_bookmarked_folder(&path, &bookmark).map(Some)
}

/// Transport de production : le plugin Swift (`tauri-plugin-folder-bookmark`), appelé par `run_mobile_plugin` (bloquant : toujours depuis
/// `spawn_blocking`).
#[cfg(target_os = "ios")]
pub struct PluginTransport<R: tauri::Runtime>(pub tauri_plugin_folder_bookmark::FolderBookmark<R>);

#[cfg(target_os = "ios")]
impl<R: tauri::Runtime> BookmarkTransport for PluginTransport<R> {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.0.call(command, args)
    }
}
