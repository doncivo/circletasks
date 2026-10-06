//! Service de synchronisation commun aux commandes Tauri et aux tests (ADR 0011 section 11.1 ; Y-08, Y-01).
//!
//! `SyncCore` tient l'état de Rust : dossier lié (`sync/folder.json`), appareil lié, clé (coffre), `sync/own.json`, `sync/usage.json`,
//! états acceptés (anti-rejeu), instantanés en cours. Ses dépendances sont injectées (coffre, contrôle du dossier et accès aux
//! fichiers, confirmation native, horloge) : les tests l'exercent sans fenêtre ni iCloud. Les boîtes de confirmation sont ouvertes
//! **hors** du verrou interne.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::consent::{ConsentGate, ConsentKind};
use super::crypto::{key_from_recovery, parse_qr_text, qr_text_of, MasterKey};
use super::files::{StdFs, SyncFs};
use super::folder::{
    check_sync_path, config_dir, read_config_file, remove_config_file, write_config_file, CheckedFolder, FolderKind, FolderRecord, FOLDER_FILE,
};
use super::limits::{NONCE_MAX_RECORDS, NONCE_WARN_RECORDS, PAIRING_CLOCK_TOLERANCE_MS};
use super::marker::{self, RestoreMarker};
use super::names::{is_uuid_v4, EpochId};
use super::files::{delete_forgotten_device_files, ForgottenDeletion};
use super::files::Listing;
use super::forget::{
    cited_devices, completed_forgotten, declaration_author, forget_dialog_detail, forget_order, forgotten_delete_check, learn_declarations, local_offset_minutes, seen_devices,
    next_declaration_hlc, state_hlcs, AcceptedRecord, DeleteCheck, ForgottenRegistry, ForgottenView, KnownDevice, KnownState, FORGET_DECLARE_LIMIT, FORGOTTEN_FILE,
    MAX_FORGOTTEN_DELETE_ENTRIES, MAX_FORGOTTEN_ENTRIES, SYNC_NEXT_KEY_ACCOUNT,
};
use super::limits::MAX_SCAN_ENTRIES_PER_FOLDER;
use super::names::DEVICES_DIR;
use super::state::{ForgottenDevice, OwnState, PublishedState, Usage};
use super::store::{Accepted, AppendResult, FolderScan, OwnFileRef, ReadPage, RecordCursor, SnapshotCache, SnapshotWriter, StateRead, StateStatus, Store};
use super::{fail, log, SyncCode, SyncError, SyncResult};
use crate::vault::{SecretVault, VaultError};

/// Compte de la clé au coffre (service `fr.circletasks.planner`).
pub const SYNC_KEY_ACCOUNT: &str = "circletasks.sync.key.v1";
pub const OWN_FILE: &str = "own.json";
pub const USAGE_FILE: &str = "usage.json";

/// Contrôle du dossier et accès aux fichiers (injectés).
pub trait FolderBackend: Send + Sync {
    fn check(&self, path: &Path) -> SyncResult<CheckedFolder>;
    fn open(&self, folder: &CheckedFolder) -> Box<dyn SyncFs>;
}

/// Production : `check_sync_path` et `StdFs`.
pub struct SystemBackend;

impl FolderBackend for SystemBackend {
    fn check(&self, path: &Path) -> SyncResult<CheckedFolder> {
        check_sync_path(path)
    }

    fn open(&self, folder: &CheckedFolder) -> Box<dyn SyncFs> {
        Box::new(StdFs::new(folder.path.clone()))
    }
}

/// Réglages du service.
#[derive(Debug, Clone)]
pub struct SyncOptions {
    /// Dossier de configuration de l'app (`app_config_dir`) : `sync/` y est créé.
    pub base_dir: PathBuf,
    /// Plateforme publiée (`windows` ou `ios`).
    pub platform: &'static str,
    /// Seuils du budget de nonces (injectables dans les tests).
    pub nonce_warn: u64,
    pub nonce_max: u64,
}

impl SyncOptions {
    pub fn new(base_dir: PathBuf) -> Self {
        let platform = if cfg!(target_os = "ios") { "ios" } else { "windows" };
        Self { base_dir, platform, nonce_warn: NONCE_WARN_RECORDS, nonce_max: NONCE_MAX_RECORDS }
    }
}

/// Forme IPC de `SyncFolderInfo` : nom du dossier et nature, jamais un chemin ; le libellé affiché (« iCloud Drive / CircleTasks »)
/// est composé par l'interface (`src/i18n`, revue 13).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderInfo {
    pub configured: bool,
    pub name: Option<String>,
    pub kind: &'static str,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyStatus {
    pub present: bool,
    pub kid: Option<String>,
}

/// Réponse de `sync_pairing_payload` : contient la clé (destinée à la seule fenêtre `pairing`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub qr_text: String,
    pub recovery_key: String,
    pub expires_at: u64,
}

/// La charge utile contient la clé : effacée à la destruction (audit S5).
impl Drop for PairingPayload {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.qr_text);
        zeroize::Zeroize::zeroize(&mut self.recovery_key);
    }
}

/// Écrivains d'instantanés ouverts en même temps au plus (revue 5) : au-delà, le plus ancien est abandonné.
pub const MAX_OPEN_SNAPSHOTS: usize = 4;

/// Entrée de `sync_key_import` (PC : QR ou clé de secours ; le scan lancé par Rust arrive à l'ordre 5).
pub enum KeyInput {
    QrText(Zeroizing<String>),
    RecoveryKey(Zeroizing<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyImportResult {
    pub kid: String,
    pub paired_by: Option<String>,
    pub epoch: Option<String>,
}

/// Requête `sync_append_journal`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendRequest {
    pub epoch: String,
    pub segment: u64,
    pub expect_records: u64,
    pub sv: u64,
    pub max_hlc: String,
    pub records: Vec<String>,
}

struct Bound {
    checked: CheckedFolder,
    fs: Box<dyn SyncFs>,
    folder_id: String,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    record: Option<FolderRecord>,
    folder: Option<Bound>,
    key: Option<Arc<MasterKey>>,
    own: Option<OwnState>,
    usage: Option<Usage>,
    accepted: HashMap<String, Accepted>,
    snapshots: HashMap<u32, SnapshotWriter>,
    next_handle: u32,
    pending_paired_by: Option<String>,
    /// Dernier instantané lu par pages (revue 15) : relu du disque seulement quand un autre est demandé.
    snapshot_cache: Option<SnapshotCache>,
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Horloge système (ms Unix).
pub fn system_clock() -> Clock {
    Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

pub struct SyncCore {
    options: SyncOptions,
    vault: Arc<dyn SecretVault>,
    backend: Arc<dyn FolderBackend>,
    consent: Arc<ConsentGate>,
    now: Clock,
    inner: Mutex<Inner>,
}

fn vault_error(_: VaultError) -> SyncError {
    SyncError::new(SyncCode::VaultUnavailable)
}

fn kind_str(kind: FolderKind) -> &'static str {
    match kind {
        FolderKind::Icloud => "icloud",
        FolderKind::Local => "local",
        FolderKind::Unknown => "unknown",
    }
}

impl SyncCore {
    pub fn new(options: SyncOptions, vault: Arc<dyn SecretVault>, backend: Arc<dyn FolderBackend>, consent: Arc<ConsentGate>, now: Clock) -> Self {
        Self { options, vault, backend, consent, now, inner: Mutex::new(Inner::default()) }
    }

    pub fn options(&self) -> &SyncOptions {
        &self.options
    }

    pub fn consent(&self) -> &Arc<ConsentGate> {
        &self.consent
    }

    pub fn now(&self) -> u64 {
        (self.now)()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sync_dir(&self) -> PathBuf {
        config_dir(&self.options.base_dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.sync_dir().join(name)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Dossier
    // --------------------------------------------------------------------------------------------------------------------------

    fn ensure_loaded(&self, inner: &mut Inner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        inner.record = match read_config_file::<FolderRecord>(&self.path(FOLDER_FILE)) {
            Ok(record) => record,
            Err(()) => {
                log::event("folder-file-unreadable", "ignored");
                None
            }
        };
    }

    /// Dossier lié, revalidé au premier chargement (et tant qu'il échoue) ; erreur du contrôle sinon (`folder-unreachable`,
    /// `unsafe-folder`, `not-local`), `not-configured` sans dossier.
    fn require_folder<'a>(&self, inner: &'a mut Inner) -> SyncResult<&'a Bound> {
        self.ensure_loaded(inner);
        if inner.folder.is_none() {
            let Some(record) = &inner.record else { return fail(SyncCode::NotConfigured) };
            let checked = self.backend.check(Path::new(&record.path))?;
            // Windows ignore la casse : un dossier renommé en ne changeant que la casse reste le même (QA-Y1-3) ; son chemin final est
            // enregistré de nouveau.
            if checked.path.to_string_lossy().to_lowercase() != record.path.to_lowercase() {
                return fail(SyncCode::UnsafeFolder);
            }
            if checked.path != Path::new(&record.path) {
                let updated = FolderRecord { path: checked.path.to_string_lossy().into_owned(), ..record.clone() };
                write_config_file(&self.path(FOLDER_FILE), &serde_json::to_vec(&updated).unwrap_or_default())?;
                inner.record = Some(updated);
            }
            let fs = self.backend.open(&checked);
            let folder_id = checked.folder_id();
            inner.folder = Some(Bound { checked, fs, folder_id });
        }
        inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))
    }

    fn info_of(bound: &Bound) -> FolderInfo {
        FolderInfo { configured: true, name: Some(bound.checked.name()), kind: kind_str(bound.checked.kind), pinned: bound.checked.pinned }
    }

    /// `sync_folder_info`.
    pub fn folder_info(&self) -> SyncResult<FolderInfo> {
        let mut inner = self.lock();
        self.ensure_loaded(&mut inner);
        if inner.record.is_none() {
            return Ok(FolderInfo { configured: false, name: None, kind: "unknown", pinned: false });
        }
        let bound = self.require_folder(&mut inner)?;
        // Racine recontrôlée à chaque lecture (revue 1) : un dossier devenu jonction ou démonté est signalé aussitôt.
        bound.fs.check_root().map_err(|e| SyncError::new(e.code()))?;
        Ok(Self::info_of(bound))
    }

    /// Liaison du dossier choisi dans la boîte système (`sync_folder_choose`) : contrôle, `folder.json`, `own.json` remis à zéro si
    /// le dossier change.
    pub fn choose_folder(&self, path: &Path) -> SyncResult<FolderInfo> {
        let checked = self.backend.check(path)?;
        let mut inner = self.lock();
        // Autre dossier, ou le même rechoisi : aucun instantané en cache (revue B3).
        inner.snapshot_cache = None;
        self.ensure_loaded(&mut inner);
        let folder_id = checked.folder_id();
        let previous_id = inner.record.as_ref().map(|r| CheckedFolder { path: PathBuf::from(&r.path), kind: FolderKind::Unknown, pinned: false }.folder_id());
        if previous_id.as_deref() != Some(folder_id.as_str()) {
            remove_config_file(&self.path(super::service::OWN_FILE))?;
            remove_config_file(&self.path(FORGOTTEN_FILE))?;
            inner.own = None;
            inner.accepted.clear();
            inner.snapshots.clear();
        }
        let device_id = inner.record.as_ref().and_then(|r| r.device_id.clone());
        let record = FolderRecord { v: 1, path: checked.path.to_string_lossy().into_owned(), device_id };
        write_config_file(&self.path(FOLDER_FILE), &serde_json::to_vec(&record).unwrap_or_default())?;
        let fs = self.backend.open(&checked);
        inner.record = Some(record);
        inner.folder = Some(Bound { checked, fs, folder_id });
        log::event("folder-bound", "ok");
        // Y-10 : appareil lié et clé présente : registre du dossier créé dès le choix (sinon au premier scan, mêmes règles).
        if let (Some(id), Ok(key)) = (Self::bound_device(&inner), self.load_key(&mut inner)) {
            if self.registry(&mut inner, &key, &id).is_err() {
                log::event("forgotten-registry-deferred", "folder-choose");
            }
        }
        Ok(Self::info_of(inner.folder.as_ref().ok_or(SyncError::new(SyncCode::Io))?))
    }

    /// `sync_folder_forget` : le dossier est délié, `own.json` supprimé ; la clé est gardée, sauf `erase_key` (confirmation native
    /// dont `owner` est propriétaire).
    pub fn forget_folder(&self, erase_key: bool, owner: isize) -> SyncResult<()> {
        if erase_key {
            let present = self.vault.get(SYNC_KEY_ACCOUNT).map_err(vault_error)?.map(Zeroizing::new).is_some();
            if present {
                self.consent.confirm(ConsentKind::EraseKey, owner)?;
                // usage.json est indexé par kid : gardé, il resservira si la même clé est réimportée (audit S9).
                self.vault.delete(SYNC_KEY_ACCOUNT).map_err(vault_error)?;
            }
        }
        let mut inner = self.lock();
        remove_config_file(&self.path(FOLDER_FILE))?;
        remove_config_file(&self.path(OWN_FILE))?;
        // Y-10 : les déclarations sont liées au dossier et à l'appareil ; reconstruites depuis son `state.ctx` si le même dossier est
        // repris sous la même identité, jamais héritées par une nouvelle identité (« Associer de nouveau »).
        remove_config_file(&self.path(FORGOTTEN_FILE))?;
        let loaded = Inner { loaded: true, ..Inner::default() };
        *inner = loaded;
        log::event("folder-forgotten", if erase_key { "key-erased" } else { "key-kept" });
        Ok(())
    }

    /// `sync_bind_device` : figé tant que le dossier n'est pas oublié (`already-bound`).
    pub fn bind_device(&self, device_id: &str) -> SyncResult<()> {
        if !is_uuid_v4(device_id) {
            return fail(SyncCode::BadName);
        }
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        let Some(record) = inner.record.as_mut() else { return fail(SyncCode::NotConfigured) };
        match record.device_id.as_deref() {
            Some(bound) if bound != device_id => return fail(SyncCode::AlreadyBound),
            Some(_) => {}
            None => {
                record.device_id = Some(device_id.to_owned());
                let bytes = serde_json::to_vec(&*record).unwrap_or_default();
                write_config_file(&self.path(FOLDER_FILE), &bytes)?;
            }
        }
        // Y-10 (§18 point 7) : registre créé dès la liaison s'il manque (appareil qui n'a encore rien publié : cas (ii)), avant toute
        // écriture ; sans clé ou s'il ne peut pas encore l'être, il l'est au premier scan, qui applique les mêmes règles et le dit.
        if let Ok(key) = self.load_key(&mut inner) {
            if self.registry(&mut inner, &key, device_id).is_err() {
                log::event("forgotten-registry-deferred", "bind");
            }
        }
        // pairedBy reçu à l'import avant la liaison : reporté dès que own.json est disponible, jamais perdu (revue 17).
        if inner.pending_paired_by.is_some() {
            if let Ok(key) = self.load_key(&mut inner) {
                if let Ok(own) = self.valid_own(&mut inner, &key, device_id) {
                    self.apply_pending(&mut inner, own)?;
                }
            }
        }
        Ok(())
    }

    /// Reporte un `pairedBy` en attente dans own.json.
    fn apply_pending(&self, inner: &mut Inner, mut own: OwnState) -> SyncResult<OwnState> {
        if let Some(paired_by) = inner.pending_paired_by.clone() {
            own.paired_by = Some(paired_by);
            self.save_own(inner, own.clone())?;
            inner.pending_paired_by = None;
        }
        Ok(own)
    }

    fn bound_device(inner: &Inner) -> Option<String> {
        inner.record.as_ref().and_then(|r| r.device_id.clone())
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Clé
    // --------------------------------------------------------------------------------------------------------------------------

    fn read_vault_key(&self) -> SyncResult<Option<MasterKey>> {
        let Some(value) = self.vault.get(SYNC_KEY_ACCOUNT).map_err(vault_error)?.map(Zeroizing::new) else { return Ok(None) };
        MasterKey::from_vault_value(&value).map(Some).ok_or(SyncError::new(SyncCode::VaultUnavailable))
    }

    fn load_key(&self, inner: &mut Inner) -> SyncResult<Arc<MasterKey>> {
        if let Some(key) = &inner.key {
            return Ok(key.clone());
        }
        let key = Arc::new(self.read_vault_key()?.ok_or(SyncError::new(SyncCode::KeyMissing))?);
        inner.key = Some(key.clone());
        Ok(key)
    }

    /// `sync_key_status` : présence et `kid`, jamais la clé.
    pub fn key_status(&self) -> SyncResult<KeyStatus> {
        let key = self.read_vault_key()?;
        Ok(KeyStatus { present: key.is_some(), kid: key.map(|k| k.kid().to_owned()) })
    }

    /// `sync_key_create` : `key-exists` si une clé existe ; `folder-has-data` si le dossier contient déjà des données CircleTasks.
    pub fn key_create(&self) -> SyncResult<String> {
        // Clé existante contrôlée sous le verrou (revue 17) : deux appels simultanés ne créent jamais deux clés.
        let mut inner = self.lock();
        if self.read_vault_key()?.is_some() {
            return fail(SyncCode::KeyExists);
        }
        let bound = self.require_folder(&mut inner)?;
        // Nouveau cycle d'hydratation (budget de 3 minutes) et racine recontrôlée (revue 2).
        bound.fs.start_cycle().map_err(|e| SyncError::new(e.code()))?;
        if Store::folder_has_data(bound.fs.as_ref())? {
            log::event("key-create-refused", "folder-has-data");
            return fail(SyncCode::FolderHasData);
        }
        let key = MasterKey::generate().map_err(|_| SyncError::new(SyncCode::Io))?;
        self.vault.set(SYNC_KEY_ACCOUNT, &key.to_vault_value()).map_err(vault_error)?;
        let kid = key.kid().to_owned();
        self.save_usage(&mut inner, Usage { kid: kid.clone(), sealed: 0 })?;
        let key = Arc::new(key);
        inner.key = Some(key.clone());
        inner.own = None;
        // Y-10 : appareil déjà lié, dossier sans données : registre créé dès maintenant (rien n'a été publié, cas (ii)).
        if let Some(id) = Self::bound_device(&inner) {
            if self.registry(&mut inner, &key, &id).is_err() {
                log::event("forgotten-registry-deferred", "key-create");
            }
        }
        log::event("key-created", &kid);
        Ok(kid)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // own.json et usage.json
    // --------------------------------------------------------------------------------------------------------------------------

    /// `own.json` valide pour ce dossier et cette clé ; sinon relu du disque, sinon reconstruit (section 1.4).
    fn valid_own(&self, inner: &mut Inner, key: &MasterKey, self_id: &str) -> SyncResult<OwnState> {
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        let matches = |own: &OwnState| own.folder_id == folder_id && own.kid == key.kid();
        if let Some(own) = inner.own.as_ref().filter(|o| matches(o)) {
            return Ok(own.clone());
        }
        if let Ok(Some(own)) = read_config_file::<OwnState>(&self.path(OWN_FILE)) {
            if matches(&own) {
                inner.own = Some(own.clone());
                return Ok(own);
            }
        }
        self.require_folder(inner)?;
        let Inner { folder, accepted, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key, pin: false };
        let own = store.rebuild_own(&folder_id, self_id, accepted)?;
        log::event("own-rebuilt", &own.state_seq.to_string());
        inner.own = Some(own.clone());
        Ok(own)
    }

    fn save_own(&self, inner: &mut Inner, own: OwnState) -> SyncResult<()> {
        write_config_file(&self.path(OWN_FILE), &serde_json::to_vec(&own).unwrap_or_default())?;
        inner.own = Some(own);
        Ok(())
    }

    fn usage(&self, inner: &mut Inner, kid: &str) -> Usage {
        if let Some(usage) = inner.usage.as_ref().filter(|u| u.kid == kid) {
            return usage.clone();
        }
        let usage = match read_config_file::<Usage>(&self.path(USAGE_FILE)) {
            Ok(Some(usage)) if usage.kid == kid => usage,
            _ => Usage { kid: kid.to_owned(), sealed: 0 },
        };
        inner.usage = Some(usage.clone());
        usage
    }

    fn save_usage(&self, inner: &mut Inner, usage: Usage) -> SyncResult<()> {
        write_config_file(&self.path(USAGE_FILE), &serde_json::to_vec(&usage).unwrap_or_default())?;
        if usage.sealed > self.options.nonce_warn {
            log::event("nonce-budget-warning", &usage.sealed.to_string());
        }
        inner.usage = Some(usage);
        Ok(())
    }

    /// Enregistrements scellés avec la clé courante (budget de nonces).
    pub fn sealed_records(&self) -> u64 {
        let mut inner = self.lock();
        match self.load_key(&mut inner) {
            Ok(key) => self.usage(&mut inner, key.kid()).sealed,
            Err(_) => 0,
        }
    }

    /// Alerte du budget de nonces (au-delà du seuil d'alerte).
    pub fn nonce_warning(&self) -> bool {
        self.sealed_records() > self.options.nonce_warn
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Lecture
    // --------------------------------------------------------------------------------------------------------------------------

    /// `sync_scan({ keep })`.
    pub fn scan(&self, keep: &[String]) -> SyncResult<FolderScan> {
        if keep.iter().any(|id| !is_uuid_v4(id)) {
            return fail(SyncCode::BadName);
        }
        let mut inner = self.lock();
        // Début de cycle : le cache de lecture d'instantané est vidé (revue B3).
        inner.snapshot_cache = None;
        self.require_folder(&mut inner)?;
        let key = self.load_key(&mut inner)?;
        let self_id = Self::bound_device(&inner);
        // Y-10 (§18 points 3 et 7) : registre lu (anti-rejeu persistant versé avant la lecture des états) ou reconstruit.
        if let Some(id) = self_id.as_deref() {
            self.registry(&mut inner, &key, id)?;
        }
        let mut scan = {
            let Inner { folder, accepted, .. } = &mut *inner;
            let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
            let store = Store { fs: bound.fs.as_ref(), key: &key, pin: bound.checked.kind == FolderKind::Icloud };
            store.scan(self_id.as_deref(), keep, accepted)?
        };
        if let Some(id) = self_id.as_deref() {
            scan.forgotten = self.merge_scan(&mut inner, &key, id, &scan)?;
        }
        Ok(scan)
    }

    /// Identifiants des dossiers d'appareil listés dans `devices/` (noms UUID), sans lire ni hydrater aucun fichier : référence
    /// d'arrivée prise à l'ouverture de la fenêtre `pairing` (audit 2).
    pub fn listed_devices(&self) -> SyncResult<Vec<String>> {
        let mut inner = self.lock();
        let bound = self.require_folder(&mut inner)?;
        let listing = bound.fs.list(&[super::names::DEVICES_DIR], super::limits::MAX_SCAN_ENTRIES_PER_FOLDER).map_err(|e| SyncError::new(e.code()))?;
        Ok(listing.entries.into_iter().filter(|e| e.is_dir && is_uuid_v4(&e.name)).map(|e| e.name).collect())
    }

    /// Appareils du scan dont l'état **authentifié** (`stateStatus` `ok`, déchiffré avec la clé locale) porte `pairedBy` = cet appareil
    /// (Y-06 critère 9 : arrivée de l'appareil associé). Aucun si cet appareil n'est pas lié.
    pub fn paired_with_self(&self, scan: &FolderScan) -> Vec<String> {
        let self_id = {
            let mut inner = self.lock();
            self.ensure_loaded(&mut inner);
            Self::bound_device(&inner)
        };
        let Some(self_id) = self_id else { return Vec::new() };
        scan.devices
            .iter()
            .filter(|d| d.device_id != self_id && d.state_status == "ok")
            .filter(|d| d.state.as_ref().is_some_and(|s| s.device_id == d.device_id && s.paired_by.as_deref() == Some(self_id.as_str())))
            .map(|d| d.device_id.clone())
            .collect()
    }

    /// `sync_read_journal`.
    pub fn read_journal(&self, device_id: &str, epoch: &str, from: RecordCursor, max_bytes: Option<u64>) -> SyncResult<ReadPage> {
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        let key = self.load_key(&mut inner)?;
        let Inner { folder, accepted, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        Store { fs: bound.fs.as_ref(), key: &key, pin: false }.read_journal(device_id, epoch, from, max_bytes, accepted)
    }

    /// `sync_read_snapshot`.
    pub fn read_snapshot(&self, device_id: &str, epoch: &str, seq: u64, from_record: u64, max_bytes: Option<u64>) -> SyncResult<ReadPage> {
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        let key = self.load_key(&mut inner)?;
        let Inner { folder, accepted, snapshot_cache, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        Store { fs: bound.fs.as_ref(), key: &key, pin: false }.read_snapshot(device_id, epoch, seq, from_record, max_bytes, accepted, snapshot_cache)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Écriture
    // --------------------------------------------------------------------------------------------------------------------------

    /// Dossier, clé, appareil lié, `own.json` valide.
    fn writable(&self, inner: &mut Inner) -> SyncResult<(Arc<MasterKey>, String, OwnState, Usage)> {
        self.require_folder(inner)?;
        let key = self.load_key(inner)?;
        let self_id = Self::bound_device(inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        let own = self.valid_own(inner, &key, &self_id)?;
        let own = self.apply_pending(inner, own)?;
        let usage = self.usage(inner, key.kid());
        Ok((key, self_id, own, usage))
    }

    /// `sync_append_journal`.
    pub fn append_journal(&self, request: &AppendRequest) -> SyncResult<AppendResult> {
        let mut inner = self.lock();
        let (key, self_id, mut own, mut usage) = self.writable(&mut inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        let result = store.append_journal(
            &mut own,
            &mut usage,
            self.options.nonce_max,
            &self_id,
            &request.epoch,
            request.segment,
            request.expect_records,
            request.sv,
            &request.max_hlc,
            &request.records,
        );
        // Les octets écrits comptent même si la persistance de own.json échoue ensuite (le budget n'est jamais sous-estimé).
        if result.is_ok() {
            self.save_usage(&mut inner, usage)?;
            self.save_own(&mut inner, own)?;
        }
        result
    }

    /// `sync_write_state` (état en forme JSON, analysé strictement).
    pub fn write_state(&self, sv: u64, state: serde_json::Value) -> SyncResult<()> {
        let state: PublishedState = serde_json::from_value(state).map_err(|_| SyncError::new(SyncCode::BadName))?;
        let mut inner = self.lock();
        let (key, self_id, mut own, mut usage) = self.writable(&mut inner)?;
        // Y-10 (section 1.4, §18 point 3) : Rust est maître de `forgotten`. La liste du moteur doit être la liste maître du registre, ou
        // son préfixe (Rust complète, comme `pairedBy`) ; sinon refus. Registre illisible : `io` ; non reconstructible : refus.
        let master = self.registry(&mut inner, &key, &self_id)?.entries;
        let Some(forgotten) = completed_forgotten(&state.forgotten, &master) else {
            log::event("write-state-refused", "forgotten");
            return fail(SyncCode::StateMismatch);
        };
        let state = PublishedState { forgotten, ..state };
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        let digest = store.write_state(&mut own, &mut usage, self.options.nonce_max, &self_id, self.options.platform, sv, &state)?;
        self.save_usage(&mut inner, usage)?;
        self.save_own(&mut inner, own)?;
        if let Some(epoch) = EpochId::parse(&state.epoch) {
            let head = RecordCursor { segment: state.head.segment, record: state.head.record };
            inner.accepted.insert(self_id, Accepted { epoch, seq: state.state_seq, digest, head });
        }
        Ok(())
    }

    /// `sync_snapshot_begin` : renvoie un numéro de handle.
    pub fn snapshot_begin(&self, epoch: &str, seq: u64, sv: u64) -> SyncResult<u32> {
        let mut inner = self.lock();
        let (key, self_id, own, _) = self.writable(&mut inner)?;
        // Instantané de même époque et même numéro déjà en cours d'écriture : même code qu'un numéro pris (revue 5).
        if inner.snapshots.values().any(|w| w.epoch == epoch && u64::from(w.seq) == seq) {
            return fail(SyncCode::SegmentMismatch);
        }
        let Inner { folder, snapshots, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        let writer = store.snapshot_begin(&own, &self_id, epoch, seq, sv)?;
        // Plafond des écrivains ouverts (moteur interrompu sans validation) : le plus ancien est abandonné, son .tmp supprimé.
        while snapshots.len() >= MAX_OPEN_SNAPSHOTS {
            let Some(oldest) = snapshots.keys().min().copied() else { break };
            if let Some(old) = snapshots.remove(&oldest) {
                store.snapshot_discard(&old);
                log::event("snapshot-abandoned", &old.seq.to_string());
            }
        }
        inner.next_handle = inner.next_handle.wrapping_add(1).max(1);
        let handle = inner.next_handle;
        inner.snapshots.insert(handle, writer);
        Ok(handle)
    }

    /// `sync_snapshot_append` : le `.tmp` est abandonné à la première erreur.
    pub fn snapshot_append(&self, handle: u32, records: &[String]) -> SyncResult<()> {
        let mut inner = self.lock();
        let (key, _, _, mut usage) = self.writable(&mut inner)?;
        let Some(mut writer) = inner.snapshots.remove(&handle) else { return fail(SyncCode::BadName) };
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        match store.snapshot_append(&mut writer, &mut usage, self.options.nonce_max, records) {
            Ok(()) => {
                inner.snapshots.insert(handle, writer);
                self.save_usage(&mut inner, usage)
            }
            Err(error) => {
                store.snapshot_discard(&writer);
                Err(error)
            }
        }
    }

    /// `sync_snapshot_commit` : renommage atomique.
    pub fn snapshot_commit(&self, handle: u32) -> SyncResult<()> {
        let mut inner = self.lock();
        let (key, _, _, _) = self.writable(&mut inner)?;
        let Some(writer) = inner.snapshots.remove(&handle) else { return fail(SyncCode::BadName) };
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        store.snapshot_commit(&writer).inspect_err(|_| store.snapshot_discard(&writer))
    }

    /// `sync_delete_own`.
    pub fn delete_own(&self, files: &[OwnFileRef]) -> SyncResult<u64> {
        let mut inner = self.lock();
        let (key, self_id, own, _) = self.writable(&mut inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        Store { fs: bound.fs.as_ref(), key: &key, pin: false }.delete_own(&own, &self_id, files)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Appairage
    // --------------------------------------------------------------------------------------------------------------------------

    /// Préconditions de `sync_pairing_open` : dossier ; en mode `show`, clé et appareil lié.
    pub fn pairing_preconditions(&self, show: bool) -> SyncResult<()> {
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        if show {
            self.load_key(&mut inner)?;
            Self::bound_device(&inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        }
        Ok(())
    }

    /// Contenu du QR et clé de secours (`sync_pairing_payload`, après les contrôles de fenêtre et de jeton).
    pub fn pairing_payload(&self, expires_at: u64) -> SyncResult<PairingPayload> {
        let mut inner = self.lock();
        let folder_id = self.require_folder(&mut inner)?.folder_id.clone();
        let key = self.load_key(&mut inner)?;
        let self_id = Self::bound_device(&inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        let epoch = inner.own.as_ref().filter(|o| o.folder_id == folder_id && o.kid == key.kid()).and_then(|o| o.epoch.clone()).or_else(|| {
            read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == key.kid()).and_then(|o| o.epoch)
        });
        let qr = qr_text_of(&key, &self_id, epoch.as_deref(), expires_at);
        let recovery = key.recovery_key();
        log::event("pairing-payload", "issued");
        Ok(PairingPayload { qr_text: (*qr).clone(), recovery_key: (*recovery).clone(), expires_at })
    }

    /// `sync_key_import` : dossier d'abord, clé ensuite (section 10.3). `owner` : fenêtre appelante (premier plan, boîte).
    pub fn key_import(&self, input: KeyInput, owner: isize) -> SyncResult<KeyImportResult> {
        self.consent.count_import(owner)?;
        let (key, paired_by, epoch, replace) = {
            let mut inner = self.lock();
            let bound = self.require_folder(&mut inner)?;
            // Nouveau cycle d'hydratation et racine recontrôlée (revue 2).
            bound.fs.start_cycle().map_err(|e| SyncError::new(e.code()))?;
            let (key, paired_by, epoch) = match &input {
                KeyInput::QrText(text) => {
                    let qr = parse_qr_text(text).ok_or(SyncError::new(SyncCode::InvalidPairing))?;
                    if self.now() > qr.expires_at.saturating_add(PAIRING_CLOCK_TOLERANCE_MS) {
                        return fail(SyncCode::PairingExpired);
                    }
                    (qr.key, Some(qr.device_id), qr.epoch)
                }
                KeyInput::RecoveryKey(text) => (key_from_recovery(text).ok_or(SyncError::new(SyncCode::InvalidPairing))?, None, None),
            };
            drop(input);
            // La clé doit être celle du dossier avant tout enregistrement (audit B3) : un state.ctx présent doit se déchiffrer avec
            // elle, pas seulement annoncer son kid en clair (audit S4).
            let check = Store::folder_kids(bound.fs.as_ref(), paired_by.as_deref(), &key)?;
            if check.readable == 0 {
                return fail(SyncCode::CloudPending);
            }
            if !check.decrypts {
                log::event("key-import-refused", "key-mismatch");
                return fail(SyncCode::KeyMismatch);
            }
            let existing = self.read_vault_key()?;
            let replace = existing.as_ref().is_some_and(|e| !e.same_as(&key));
            let same = existing.as_ref().is_some_and(|e| e.same_as(&key));
            (key, paired_by, epoch, if same { None } else { Some(replace) })
        };
        if replace == Some(true) {
            self.consent.confirm(ConsentKind::ReplaceKey, owner)?;
        }
        let mut inner = self.lock();
        // Nouvelle clé : aucun instantané lu avec l'ancienne ne reste en cache (revue B3).
        inner.snapshot_cache = None;
        // Clé existante relue sous le verrou (revue 17) : une autre clé apparue pendant la boîte n'est jamais remplacée sans accord.
        let existing = self.read_vault_key()?;
        if replace != Some(true) && existing.as_ref().is_some_and(|e| !e.same_as(&key)) {
            return fail(SyncCode::ConsentDenied);
        }
        if !existing.as_ref().is_some_and(|e| e.same_as(&key)) {
            // usage.json n'est pas remis à zéro : indexé par kid, il ne repart de 0 que pour une autre clé (audit S9).
            self.vault.set(SYNC_KEY_ACCOUNT, &key.to_vault_value()).map_err(vault_error)?;
            inner.usage = None;
        }
        let kid = key.kid().to_owned();
        let key = Arc::new(key);
        inner.key = Some(key.clone());
        inner.own = None;
        if paired_by.is_some() {
            inner.pending_paired_by = paired_by.clone();
        }
        if let Some(self_id) = Self::bound_device(&inner) {
            // own.json pas encore reconstructible (propre state.ctx dans le nuage) : pairedBy reste en attente, l'import réussit.
            if let Ok(own) = self.valid_own(&mut inner, &key, &self_id) {
                self.apply_pending(&mut inner, own)?;
            }
            // Y-10 : registre créé avec la clé (sinon au premier scan, mêmes règles et refus visibles).
            if self.registry(&mut inner, &key, &self_id).is_err() {
                log::event("forgotten-registry-deferred", "key-import");
            }
        }
        log::event("key-imported", &kid);
        Ok(KeyImportResult { kid, paired_by, epoch })
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Oubli d'un appareil (Y-10 ; ADR 0011 sections 11.1, 14.2 et 18 points 3 à 10)
    // --------------------------------------------------------------------------------------------------------------------------

    /// Registre lu : absent (fichier manquant, autre dossier, autre identité) → `None` ; illisible (lecture, JSON, schéma, plus de 64
    /// entrées) → `io`, jamais traité comme absent (§18 point 7).
    fn load_registry(&self, folder_id: &str, self_id: &str) -> SyncResult<Option<ForgottenRegistry>> {
        match read_config_file::<ForgottenRegistry>(&self.path(FORGOTTEN_FILE)) {
            Ok(None) => Ok(None),
            Ok(Some(reg)) if reg.is_valid() => Ok((reg.folder_id == folder_id && reg.device_id == self_id).then_some(reg)),
            Ok(Some(_)) | Err(()) => {
                log::event("forgotten-registry-unreadable", "io");
                fail(SyncCode::Io)
            }
        }
    }

    fn save_registry(&self, reg: &ForgottenRegistry) -> SyncResult<()> {
        write_config_file(&self.path(FORGOTTEN_FILE), &serde_json::to_vec(reg).unwrap_or_default())
    }

    /// Anti-rejeu persistant versé dans celui de la session (le plus récent l'emporte ; une tête inconnue vaut zéro).
    fn seed_accepted(accepted: &mut HashMap<String, Accepted>, reg: &ForgottenRegistry) {
        for (id, rec) in &reg.accepted {
            let Some(epoch) = EpochId::parse(&rec.epoch) else { continue };
            if accepted.get(id).is_some_and(|a| a.seq > rec.state_seq || (a.seq == rec.state_seq && a.digest == rec.digest)) {
                continue;
            }
            accepted.insert(id.clone(), Accepted { epoch, seq: rec.state_seq, digest: rec.digest.clone(), head: RecordCursor { segment: 0, record: 0 } });
        }
    }

    /// Anti-rejeu de la session versé dans le registre (ne décroît jamais) ; vrai s'il a changé.
    fn absorb_accepted(reg: &mut ForgottenRegistry, accepted: &HashMap<String, Accepted>) -> bool {
        let mut changed = false;
        for (id, a) in accepted {
            let newer = reg.accepted.get(id).map_or(true, |rec| a.seq > rec.state_seq);
            if newer {
                reg.accepted.insert(id.clone(), AcceptedRecord { epoch: a.epoch.name(), state_seq: a.seq, digest: a.digest.clone() });
                changed = true;
            }
        }
        changed
    }

    /// Registre valide pour le dossier et l'appareil liés : lu, sinon reconstruit (§18 point 7) et persisté avant toute écriture ; son
    /// anti-rejeu est versé dans celui de la session.
    fn registry(&self, inner: &mut Inner, key: &MasterKey, self_id: &str) -> SyncResult<ForgottenRegistry> {
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        if let Some(reg) = self.load_registry(&folder_id, self_id)? {
            Self::seed_accepted(&mut inner.accepted, &reg);
            return Ok(reg);
        }
        let reg = self.rebuild_registry(inner, key, &folder_id, self_id)?;
        self.save_registry(&reg)?;
        Self::seed_accepted(&mut inner.accepted, &reg);
        log::event("forgotten-registry-rebuilt", &reg.entries.len().to_string());
        Ok(reg)
    }

    /// Reconstruction d'un registre absent (§18 point 7) : seulement si (i) son propre état est `ok`, (ii) il est absent et l'appareil
    /// n'a jamais publié, ou (iii) il est absent ou illisible, `own.json` est valide et un actif non oublié publie un accusé authentifié
    /// sur soi de `stateSeq` au moins égal à celui de `own.json` ; sinon `cloud-pending`, `newer-format` ou `state-mismatch`.
    fn rebuild_registry(&self, inner: &Inner, key: &MasterKey, folder_id: &str, self_id: &str) -> SyncResult<ForgottenRegistry> {
        let own_json = read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == key.kid());
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key, pin: false };
        let reads = Self::read_all_states(&store, &inner.accepted)?.ok_or(SyncError::new(SyncCode::StateMismatch))?;
        let ok: Vec<(&str, &PublishedState)> = Self::ok_states(&reads);
        let candidates: Vec<ForgottenDevice> = ok.iter().flat_map(|(_, s)| s.forgotten.iter().cloned()).collect();
        let (entries, _) = learn_declarations(&[], &candidates, MAX_FORGOTTEN_ENTRIES);
        let order = forget_order(&entries);
        let acks_on_self: Vec<u64> = ok.iter().filter(|(id, _)| *id != self_id && !order.contains_key(*id)).filter_map(|(_, s)| s.acks.get(self_id).map(|a| a.state_seq)).collect();
        let own_status = reads.get(self_id).map_or(StateStatus::Missing, |r| r.status);
        let never_published = match store.fs.list(&[DEVICES_DIR, self_id], 1) {
            Err(super::files::FsError::NotFound) => true,
            Ok(Listing { entries, .. }) => entries.is_empty(),
            Err(_) => false,
        }
            && !ok.iter().any(|(_, s)| s.acks.contains_key(self_id));
        let allowed = match own_status {
            StateStatus::Ok => true,
            StateStatus::CloudPending => return fail(SyncCode::CloudPending),
            StateStatus::NewerFormat => return fail(SyncCode::NewerFormat),
            StateStatus::Missing if never_published => true,
            StateStatus::Missing | StateStatus::Foreign | StateStatus::Corrupt | StateStatus::Rollback | StateStatus::TooLarge => {
                own_json.as_ref().is_some_and(|o| acks_on_self.iter().any(|seq| *seq >= o.state_seq))
            }
        };
        if !allowed {
            log::event("forgotten-registry-rebuild-refused", own_status.as_str());
            return fail(SyncCode::StateMismatch);
        }
        let mut reg = ForgottenRegistry::empty(folder_id, self_id);
        reg.entries = entries;
        for (id, read) in &reads {
            if let (StateStatus::Ok, Some(state), Some(digest)) = (read.status, &read.state, &read.digest) {
                reg.accepted.insert(id.clone(), AcceptedRecord { epoch: state.epoch.clone(), state_seq: state.state_seq, digest: digest.clone() });
            }
        }
        Ok(reg)
    }

    fn ok_states(reads: &BTreeMap<String, StateRead>) -> Vec<(&str, &PublishedState)> {
        reads.iter().filter(|(_, r)| r.status == StateStatus::Ok).filter_map(|(id, r)| r.state.as_ref().map(|s| (id.as_str(), s))).collect()
    }

    /// Fusion au scan (§18 point 3) : déclarations retenues des états authentifiés apprises, anti-rejeu versé, registre persisté avant
    /// que le scan rende son résultat ; renvoie la vue de `FolderScan.forgotten`.
    fn merge_scan(&self, inner: &mut Inner, key: &MasterKey, self_id: &str, scan: &FolderScan) -> SyncResult<ForgottenView> {
        let mut reg = self.registry(inner, key, self_id)?;
        let candidates: Vec<ForgottenDevice> =
            scan.devices.iter().filter(|d| d.state_status == "ok").filter_map(|d| d.state.as_ref()).flat_map(|s| s.forgotten.iter().cloned()).collect();
        let (entries, overflow) = learn_declarations(&reg.entries, &candidates, MAX_FORGOTTEN_ENTRIES);
        if overflow {
            log::event("forgotten-overflow", &reg.entries.len().to_string());
        }
        let mut changed = entries.len() != reg.entries.len();
        reg.entries = entries;
        changed |= Self::absorb_accepted(&mut reg, &inner.accepted);
        if changed {
            self.save_registry(&reg)?;
        }
        Ok(reg.view(overflow))
    }

    /// Réinitialisation en cours (section 14.3) : entrée `.next` au coffre (présence seule, secret jamais gardé), ou annonce `reset`
    /// lue dans un état authentifié.
    fn reset_in_progress(&self, reads: &BTreeMap<String, StateRead>) -> SyncResult<bool> {
        if self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)? {
            return Ok(true);
        }
        Ok(reads.values().any(|r| r.status == StateStatus::Ok && r.state.as_ref().is_some_and(|s| s.reset.is_some())))
    }

    /// États de tous les dossiers d'appareils de `devices/` (liste complète exigée, 10 000 entrées ; le plafond de 16 dossiers ne
    /// s'applique pas) : anti-rejeu de `accepted`, rien n'est retenu. `None` : liste coupée.
    fn read_all_states(store: &Store<'_>, accepted: &HashMap<String, Accepted>) -> SyncResult<Option<BTreeMap<String, StateRead>>> {
        let listing = match store.fs.list(&[DEVICES_DIR], MAX_SCAN_ENTRIES_PER_FOLDER) {
            Ok(listing) => listing,
            Err(super::files::FsError::NotFound) => return Ok(Some(BTreeMap::new())),
            Err(error) => return Err(SyncError::new(error.code())),
        };
        if listing.truncated {
            return Ok(None);
        }
        let mut reads = BTreeMap::new();
        for entry in listing.entries.iter().filter(|e| e.is_dir && is_uuid_v4(&e.name)) {
            reads.insert(entry.name.clone(), store.read_state(&entry.name, accepted));
        }
        Ok(Some(reads))
    }

    /// Préconditions communes : dossier, clé, appareil lié ; renvoie la clé et l'appareil local.
    fn forget_context(&self, inner: &mut Inner) -> SyncResult<(Arc<MasterKey>, String)> {
        let bound = self.require_folder(inner)?;
        bound.fs.start_cycle().map_err(|e| SyncError::new(e.code()))?;
        let key = self.load_key(inner)?;
        let self_id = Self::bound_device(inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        Ok((key, self_id))
    }

    /// Contrôles de `sync_device_forget`, avant puis après la boîte (sous le verrou) : `Ok(None)` si l'appareil est déjà oublié
    /// (idempotent, aucune boîte), sinon le registre avec la déclaration ajoutée et le détail de la boîte.
    fn forget_declaration(&self, inner: &mut Inner, device_id: &str) -> SyncResult<Option<(ForgottenRegistry, String)>> {
        let (key, self_id) = self.forget_context(inner)?;
        if device_id == self_id {
            return fail(SyncCode::BadName);
        }
        let mut reg = self.registry(inner, &key, &self_id)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        let reads = Self::read_all_states(&store, &inner.accepted)?.ok_or(SyncError::new(SyncCode::StateMismatch))?;
        if self.reset_in_progress(&reads)? {
            return fail(SyncCode::StateMismatch);
        }
        let order = forget_order(&reg.entries);
        // Un appareil oublié ne déclare plus rien (sa déclaration serait sans effet dans l'ordre total).
        if order.contains_key(&self_id) {
            return fail(SyncCode::StateMismatch);
        }
        if order.contains_key(device_id) {
            return Ok(None);
        }
        let ok = Self::ok_states(&reads);
        let actives: Vec<&PublishedState> = ok.iter().filter(|(id, _)| !order.contains_key(*id)).map(|(_, s)| *s).collect();
        let cited = cited_devices(actives.iter().copied());
        let known = reads.contains_key(device_id) || cited.contains(device_id) || reg.accepted.contains_key(device_id) || reg.entries.iter().any(|e| e.device_id == device_id);
        if !known {
            return fail(SyncCode::BadName);
        }
        if reg.entries.len() >= FORGET_DECLARE_LIMIT {
            return fail(SyncCode::TooLarge);
        }
        let seen = actives.iter().filter(|s| s.device_id != device_id).flat_map(|s| state_hlcs(s));
        let at = next_declaration_hlc(self.now(), seen, &self_id, PAIRING_CLOCK_TOLERANCE_MS).ok_or(SyncError::new(SyncCode::HlcOrder))?;
        let own_state = ok.iter().find(|(id, _)| *id == self_id).map(|(_, s)| *s);
        reg.entries.push(ForgottenDevice { device_id: device_id.to_owned(), at, last_ack: own_state.and_then(|s| s.acks.get(device_id).cloned()) });
        let target = ok.iter().find(|(id, _)| *id == device_id).map(|(_, s)| *s);
        let detail = forget_dialog_detail(device_id, target, local_offset_minutes(self.now()));
        Ok(Some((reg, detail)))
    }

    /// `sync_device_forget` : refus avant toute boîte (`bad-name`, `not-configured`, `key-missing`, `not-bound`, `state-mismatch`,
    /// `too-large`, `hlc-order`, `io`), appareil déjà oublié sans boîte, puis confirmation native (détail lu par Rust ; `not-foreground`,
    /// `rate-limited`, `consent-denied` : rien n'est écrit), puis déclaration ajoutée à la liste maître (`.tmp` + renommage).
    pub fn device_forget(&self, device_id: &str, owner: isize) -> SyncResult<()> {
        if !is_uuid_v4(device_id) {
            return fail(SyncCode::BadName);
        }
        let Some((_, detail)) = self.forget_declaration(&mut self.lock(), device_id)? else {
            log::event("forget-already", device_id);
            return Ok(());
        };
        self.consent.confirm_forget(owner, &detail)?;
        let mut inner = self.lock();
        // Contrôles refaits après la boîte : l'état a pu changer pendant qu'elle était ouverte.
        let Some((reg, _)) = self.forget_declaration(&mut inner, device_id)? else { return Ok(()) };
        self.save_registry(&reg)?;
        log::event("forget-declared", device_id);
        Ok(())
    }

    /// `sync_forgotten_delete` : conditions recalculées depuis le dossier et le registre (section 14.2 (a) à (g)), puis suppression des
    /// noms stricts de `devices/<device_id>/` (`state.ctx` en dernier) ; terminé : inscrit dans `done`. Aucune boîte.
    pub fn forgotten_delete(&self, device_id: &str) -> SyncResult<ForgottenDeletion> {
        if !is_uuid_v4(device_id) {
            return fail(SyncCode::BadName);
        }
        let mut inner = self.lock();
        let (key, self_id) = self.forget_context(&mut inner)?;
        if device_id == self_id {
            return fail(SyncCode::BadName);
        }
        let mut reg = self.registry(&mut inner, &key, &self_id)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false };
        let Some(reads) = Self::read_all_states(&store, &inner.accepted)? else {
            log::event("forgotten-delete-refused", "listing");
            return fail(SyncCode::StateMismatch);
        };
        if self.reset_in_progress(&reads)? {
            return fail(SyncCode::StateMismatch);
        }
        let order = forget_order(&reg.entries);
        let ok = Self::ok_states(&reads);
        let seen_set = seen_devices(reg.accepted.keys(), ok.iter().map(|(id, s)| (*id, &s.acks)), &reg.entries);
        let mut ids: BTreeSet<String> = reads.keys().cloned().collect();
        ids.extend(seen_set.iter().cloned());
        ids.extend(reg.entries.iter().map(|f| f.device_id.clone()));
        let authors: BTreeSet<&str> = reg.entries.iter().filter_map(declaration_author).collect();
        let known: Vec<KnownDevice> = ids
            .into_iter()
            .map(|id| {
                let read = reads.get(&id);
                let status = read.map_or(StateStatus::Missing, |r| r.status);
                let seen = seen_set.contains(&id);
                if status != StateStatus::Ok && !seen && !authors.contains(id.as_str()) && !order.contains_key(&id) && id != self_id {
                    log::event("forgotten-delete-phantom", &id);
                }
                KnownDevice { state: read.filter(|r| r.status == StateStatus::Ok).and_then(|r| r.state.as_ref()).map(KnownState::from), status, seen, device_id: id }
            })
            .collect();
        match forgotten_delete_check(device_id, &self_id, &reg.entries, &reg.done, &known) {
            DeleteCheck::Ready { .. } => {}
            DeleteCheck::Waiting { device, code } => {
                log::event("forgotten-delete-waiting", &device);
                return fail(code);
            }
            DeleteCheck::Refused(code) => {
                log::event("forgotten-delete-refused", code.as_str());
                return fail(code);
            }
        }
        let result = delete_forgotten_device_files(bound.fs.as_ref(), device_id, MAX_FORGOTTEN_DELETE_ENTRIES).map_err(|e| SyncError::new(e.code()))?;
        if result.complete && !reg.done.iter().any(|d| d == device_id) {
            reg.done.push(device_id.to_owned());
            self.save_registry(&reg)?;
        }
        log::event("forgotten-delete", &format!("{device_id} {} {}", result.deleted, if result.complete { "complete" } else { "more" }));
        Ok(result)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Marqueur de restauration
    // --------------------------------------------------------------------------------------------------------------------------

    pub fn restore_marker(&self) -> SyncResult<Option<RestoreMarker>> {
        marker::read(&self.options.base_dir)
    }

    pub fn clear_restore_marker(&self) -> SyncResult<()> {
        marker::clear(&self.options.base_dir)
    }
}
