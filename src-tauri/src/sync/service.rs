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
    cited_devices, completed_forgotten, declaration_author, forget_dialog_detail, parse_snapshot_end, snapshot_in_epoch, SnapshotEnd, SnapshotEndRead, forget_order, forgotten_delete_check, learn_declarations, local_offset_minutes, seen_devices,
    next_declaration_hlc, state_hlcs, AcceptedRecord, DeleteCheck, ForgottenRegistry, ForgottenView, KnownDevice, KnownState, FORGET_DECLARE_LIMIT, FORGOTTEN_FILE,
    MAX_FORGOTTEN_DELETE_ENTRIES, MAX_FORGOTTEN_ENTRIES, SYNC_NEXT_KEY_ACCOUNT,
};
use super::limits::{DEVICE_EXPIRY_MS, MAX_SCAN_ENTRIES_PER_FOLDER, MAX_STATE_FILE_BYTES};
use super::names::{parse_file_name, SyncFileName, DEVICES_DIR, STATE_FILE, STATE_NEXT_FILE};
use super::reset::{
    reset_precondition, reset_waiting, reset_winner, restore_candidates, without_stale_acks, AuthorSeen, ForgottenCut, KState, OpenedEpoch, PreconditionDevice, ResetBase, ResetCandidate, ResetKnown,
    ResetRecord, ResetRole, ResetStage, Superseded, RESET_FILE, USAGE_NEXT_FILE,
};
use super::forget::covers_forgotten;
use super::state::{DeviceAck, ForgottenDevice, OwnState, PublishedState, ResetNotice, Usage};
use super::store::{Accepted, AppendResult, NextKey, SnapshotEndKey, FolderScan, OwnFileRef, ReadPage, RecordCursor, SnapshotCache, SnapshotWriter, StateRead, StateStatus, Store};
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

/// Point d'arrêt injectable (Y-11 : arrêt brutal simulé avant une étape de la bascule ou de la perte) ; `true` : l'étape nommée échoue
/// (`io`) avant toute écriture. N'existe que dans les tests (fonctionnalité cargo `test-hooks`, revue 8) : absent du binaire livré.
#[cfg(feature = "test-hooks")]
pub type Interrupt = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Réglages du service.
#[derive(Clone)]
pub struct SyncOptions {
    /// Dossier de configuration de l'app (`app_config_dir`) : `sync/` y est créé.
    pub base_dir: PathBuf,
    /// Plateforme publiée (`windows` ou `ios`).
    pub platform: &'static str,
    /// Seuils du budget de nonces (injectables dans les tests).
    pub nonce_warn: u64,
    pub nonce_max: u64,
    /// Y-11 : arrêts simulés des tests (fonctionnalité `test-hooks` seulement).
    #[cfg(feature = "test-hooks")]
    pub interrupt: Option<Interrupt>,
}

impl std::fmt::Debug for SyncOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncOptions").field("platform", &self.platform).field("nonce_warn", &self.nonce_warn).field("nonce_max", &self.nonce_max).finish_non_exhaustive()
    }
}

impl SyncOptions {
    pub fn new(base_dir: PathBuf) -> Self {
        let platform = if cfg!(target_os = "ios") { "ios" } else { "windows" };
        Self {
            base_dir,
            platform,
            nonce_warn: NONCE_WARN_RECORDS,
            nonce_max: NONCE_MAX_RECORDS,
            #[cfg(feature = "test-hooks")]
            interrupt: None,
        }
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
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub present: bool,
    pub kid: Option<String>,
    /// Y-11 : `kid` de l'entrée `circletasks.sync.key.next` (nouvelle clé d'une réinitialisation), ou null ; fait foi pour le moteur.
    pub next_kid: Option<String>,
    /// Y-11 (§18 point 17) : dernier refus de `sync_key_import` pour ce dossier (`sync/import-failure.json`), ou null.
    pub import_failure: Option<ImportFailureView>,
}

/// Échec d'import persisté (§18 point 17) : code et instant ISO UTC, jamais de clé.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailureView {
    pub code: String,
    pub at: String,
}

/// `sync/import-failure.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportFailureFile {
    v: u32,
    folder_id: String,
    code: String,
    at: String,
    next: bool,
}

pub const IMPORT_FAILURE_FILE: &str = "import-failure.json";

/// Y-11 : réinitialisation vue par le moteur (`FolderScan.reset`) : jamais de clé, seulement des `kid`, époques et étapes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetView {
    pub role: &'static str,
    pub kid: String,
    pub epoch: String,
    pub by: String,
    /// Annonce à publier sous l'ancienne clé (appareil qui réinitialise) ; maître : Rust.
    pub notice: Option<ResetNotice>,
    pub stage: &'static str,
    /// Époque de l'état qui porte l'annonce (`n`) : le moteur n'arrive par fusion que depuis elle (§18 point 16, complément 2).
    pub notice_epoch: Option<String>,
    pub superseded: Option<SupersededView>,
    /// Registre `superseded` clos par ce scan (gagnant oublié, §18 point 15) : « Réinitialisation interrompue : relancez-la ».
    pub closed: bool,
    /// Bascule commencée (reprise par Rust au scan, quelles que soient les conditions).
    pub switching: bool,
    /// Bascule terminée par ce scan : l'ancienne clé est effacée, la nouvelle est sous `.v1`.
    pub switched: bool,
    /// Bascule interrompue (arrêt brutal) reprise par ce scan.
    pub resumed: bool,
    /// Appareil qui réinitialise : appareils connus pas encore réassociés (ni oubliés), triés.
    pub waiting: Vec<String>,
}

/// Perte d'une réinitialisation (§18 point 2) : époque et auteur de l'annonce gagnante (aucune : réinitialisation interrompue).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersededView {
    pub epoch: Option<String>,
    pub by: Option<String>,
    /// Le gagnant est une époque restaurée sous l'ancienne clé (§18 point 16).
    pub restore: bool,
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
    /// Fins d'instantané déjà lues (`tail`, §18 point 11) par (`kid`, appareil, époque, numéro) : un numéro n'est jamais réécrit sous un
    /// état authentifié ; gardées toute la session (vidées seulement au changement de dossier ou de clé), l'annonce restant contrôlée à
    /// chaque appel (Y-10, troisième revue point 1).
    snapshot_ends: HashMap<SnapshotEndKey, String>,
    /// Y-11 : nouvelle clé active (registre `reset.json` actif et entrée `.next` de même `kid`) et époque visée ; `None` : pas encore lue.
    /// Vidée à chaque changement du registre, du coffre, du dossier ou de l'appareil.
    next: Option<Option<(Arc<MasterKey>, String)>>,
    /// Dernière synchro (`lastSyncHlc`, ms) de chaque appareil vue au dernier scan de la session : un appareil expiré (180 jours) dont
    /// l'état attend iCloud ne bloque pas le don de la clé (seconde revue, point 2).
    last_seen: HashMap<String, u64>,
    /// Remarques finales (sécurité basse) : anti-rejeu des `state.ctx` sous l'ancienne clé relus pour la coupure pendant une
    /// réinitialisation (appareils déjà réassociés), et derniers accusés acceptés : une copie plus ancienne remise n'abaisse jamais la
    /// coupure.
    k_accepted: HashMap<String, Accepted>,
    k_acks: HashMap<String, BTreeMap<String, DeviceAck>>,
}

/// Construit l'accès au dossier avec la clé locale et, pendant une réinitialisation, la nouvelle clé de l'époque visée.
fn store_for<'a>(bound: &'a Bound, key: &'a MasterKey, next: &'a Option<(Arc<MasterKey>, String)>, pin: bool) -> Store<'a> {
    Store { fs: bound.fs.as_ref(), key, pin, next: next.as_ref().map(|(k, e)| NextKey { key: k.as_ref(), epoch: e.as_str() }) }
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
        inner.snapshot_ends.clear();
        inner.next = None;
        self.ensure_loaded(&mut inner);
        let folder_id = checked.folder_id();
        let previous_id = inner.record.as_ref().map(|r| CheckedFolder { path: PathBuf::from(&r.path), kind: FolderKind::Unknown, pinned: false }.folder_id());
        if previous_id.as_deref() != Some(folder_id.as_str()) {
            remove_config_file(&self.path(super::service::OWN_FILE))?;
            remove_config_file(&self.path(FORGOTTEN_FILE))?;
            // Y-11 : une réinitialisation est liée à son dossier ; un autre dossier l'abandonne (la clé `.v1` reste valide).
            self.abandon_reset()?;
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
            // Audit 7 : la nouvelle clé d'une réinitialisation est effacée sans condition (registre présent ou non).
            if self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)? {
                self.vault.delete(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?;
            }
        }
        let mut inner = self.lock();
        inner.snapshot_ends.clear();
        remove_config_file(&self.path(FOLDER_FILE))?;
        remove_config_file(&self.path(OWN_FILE))?;
        // Y-10 : les déclarations sont liées au dossier et à l'appareil ; reconstruites depuis son `state.ctx` si le même dossier est
        // repris sous la même identité, jamais héritées par une nouvelle identité (« Associer de nouveau »).
        remove_config_file(&self.path(FORGOTTEN_FILE))?;
        // Y-11 : réinitialisation liée au dossier : abandonnée (nouvelle clé effacée, `.v1` gardée sauf `erase_key`) ; échec d'import
        // effacé (§18 point 17).
        self.abandon_reset()?;
        remove_config_file(&self.path(IMPORT_FAILURE_FILE))?;
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

    /// `sync_key_status` : présence et `kid`, jamais la clé ; Y-11 : `kid` de l'entrée `.next`.
    pub fn key_status(&self) -> SyncResult<KeyStatus> {
        let key = self.read_vault_key()?;
        let next = self.read_vault_next()?;
        let import_failure = self.import_failure();
        Ok(KeyStatus { present: key.is_some(), kid: key.map(|k| k.kid().to_owned()), next_kid: next.map(|k| k.kid().to_owned()), import_failure })
    }

    /// Identifiant du dossier lié d'après `folder.json` (sans contrôle du dossier) ; `None` sans dossier.
    fn recorded_folder_id(&self) -> Option<String> {
        let mut inner = self.lock();
        self.ensure_loaded(&mut inner);
        if let Some(bound) = &inner.folder {
            return Some(bound.folder_id.clone());
        }
        inner.record.as_ref().map(|r| CheckedFolder { path: PathBuf::from(&r.path), kind: FolderKind::Unknown, pinned: false }.folder_id())
    }

    /// Échec d'import du dossier lié (§18 point 17) : un fichier illisible donne `None` et un journal, jamais une erreur.
    fn import_failure(&self) -> Option<ImportFailureView> {
        let file = match read_config_file::<ImportFailureFile>(&self.path(IMPORT_FAILURE_FILE)) {
            Ok(file) => file?,
            Err(()) => {
                log::event("import-failure-unreadable", "ignored");
                return None;
            }
        };
        if file.v != 1 || SyncCode::ALL.iter().all(|c| c.as_str() != file.code) {
            log::event("import-failure-unreadable", "ignored");
            return None;
        }
        (Some(file.folder_id.as_str()) == self.recorded_folder_id().as_deref()).then_some(ImportFailureView { code: file.code, at: file.at })
    }

    /// Persiste un refus de `sync_key_import` (§18 point 17) ; un échec d'écriture est journalisé et ne remplace jamais le code rendu.
    pub fn record_import_failure(&self, code: SyncCode) {
        if matches!(code, SyncCode::WrongWindow | SyncCode::WrongMode | SyncCode::NotForeground | SyncCode::ConsentDenied) {
            return;
        }
        let Some(folder_id) = self.recorded_folder_id() else {
            log::event("import-failure-unrecorded", "no-folder");
            return;
        };
        let next = self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap_or(false) || read_config_file::<serde_json::Value>(&self.path(RESET_FILE)).ok().flatten().is_some();
        let file = ImportFailureFile { v: 1, folder_id, code: code.as_str().to_owned(), at: iso_ms(self.now()), next };
        if write_config_file(&self.path(IMPORT_FAILURE_FILE), &serde_json::to_vec(&file).unwrap_or_default()).is_err() {
            log::event("import-failure-unrecorded", code.as_str());
        }
    }

    /// Entrée `.next` du coffre (Y-11) : nouvelle clé d'une réinitialisation ; une valeur illisible vaut `vault-unavailable`.
    fn read_vault_next(&self) -> SyncResult<Option<MasterKey>> {
        let Some(value) = self.vault.get(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?.map(Zeroizing::new) else { return Ok(None) };
        MasterKey::from_vault_value(&value).map(Some).ok_or(SyncError::new(SyncCode::VaultUnavailable))
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
        let next = self.active_next(inner)?;
        let Inner { folder, accepted, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, key, &next, false);
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

    /// Y-11 : budget de nonces de la nouvelle clé pendant la transition (`usage.next.json`, repart de zéro, §2).
    fn usage_next(&self, kid: &str) -> Usage {
        match read_config_file::<Usage>(&self.path(USAGE_NEXT_FILE)) {
            Ok(Some(usage)) if usage.kid == kid => usage,
            _ => Usage { kid: kid.to_owned(), sealed: 0 },
        }
    }

    /// Budget de la clé qui chiffre `epoch` : la nouvelle clé pour l'époque visée d'une réinitialisation, sinon la clé locale.
    fn usage_for(&self, inner: &mut Inner, key: &MasterKey, next: &Option<(Arc<MasterKey>, String)>, epoch: &str) -> (Usage, bool) {
        match next {
            Some((k, e)) if e == epoch => (self.usage_next(k.kid()), true),
            _ => (self.usage(inner, key.kid()), false),
        }
    }

    fn save_usage_for(&self, inner: &mut Inner, usage: Usage, is_next: bool) -> SyncResult<()> {
        if !is_next {
            return self.save_usage(inner, usage);
        }
        write_config_file(&self.path(USAGE_NEXT_FILE), &serde_json::to_vec(&usage).unwrap_or_default())?;
        if usage.sealed > self.options.nonce_warn {
            log::event("nonce-budget-warning", &usage.sealed.to_string());
        }
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

    /// Alerte du budget de nonces de la clé locale ou, pendant une réinitialisation, de la nouvelle clé (rendue par `sync_scan`).
    fn nonce_warning_for(&self, inner: &mut Inner, key: &MasterKey, next: &Option<(Arc<MasterKey>, String)>) -> bool {
        let sealed = self.usage(inner, key.kid()).sealed;
        let sealed_next = next.as_ref().map_or(0, |(k, _)| self.usage_next(k.kid()).sealed);
        sealed.max(sealed_next) > self.options.nonce_warn
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
        // Début de cycle : le cache des octets d'instantané est vidé (revue B3) ; les fins lues restent pour la session (troisième revue
        // Y-10, point 1 : sinon chaque cycle relirait en entier l'instantané annoncé de chaque actif).
        inner.snapshot_cache = None;
        self.require_folder(&mut inner)?;
        let key = self.load_key(&mut inner)?;
        let self_id = Self::bound_device(&inner);
        // Y-10 (§18 points 3 et 7) : registre lu (anti-rejeu persistant versé avant la lecture des états) ou reconstruit.
        if let Some(id) = self_id.as_deref() {
            self.registry(&mut inner, &key, id)?;
        }
        // Y-11 (§14.3, §18 point 2) : perte constatée, bascule (et sa reprise) faites avant la lecture du dossier, dont le résultat
        // reflète alors les clés en vigueur.
        let reset = match self_id.as_deref() {
            Some(id) => self.reset_pass(&mut inner, id)?,
            None => None,
        };
        let key = self.load_key(&mut inner)?;
        let next = self.active_next(&mut inner)?;
        let mut scan = {
            let Inner { folder, accepted, .. } = &mut *inner;
            let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
            let store = store_for(bound, &key, &next, bound.checked.kind == FolderKind::Icloud);
            store.scan(self_id.as_deref(), keep, accepted)?
        };
        if let Some(id) = self_id.as_deref() {
            scan.forgotten = self.merge_scan(&mut inner, &key, id, &scan)?;
        }
        for device in &scan.devices {
            if let Some(ms) = device.state.as_ref().filter(|_| device.state_status == "ok").and_then(|s| hlc_ms(&s.last_sync_hlc)) {
                inner.last_seen.insert(device.device_id.clone(), ms);
            }
        }
        scan.reset = reset;
        // Y-TECH-02 : alerte du budget de nonces rendue au moteur (avertissement de `SyncStatus`), plus seulement journalisée.
        scan.nonce_warning = self.nonce_warning_for(&mut inner, &key, &next);
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
        let next = self.active_next(&mut inner)?;
        let Inner { folder, accepted, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        store_for(bound, &key, &next, false).read_journal(device_id, epoch, from, max_bytes, accepted)
    }

    /// `sync_read_snapshot` ; `tail` : dernier enregistrement seul de l'instantané annoncé (§18 point 11).
    pub fn read_snapshot(&self, device_id: &str, epoch: &str, seq: u64, from_record: u64, max_bytes: Option<u64>) -> SyncResult<ReadPage> {
        self.read_snapshot_with(device_id, epoch, seq, from_record, max_bytes, false)
    }

    pub fn read_snapshot_with(&self, device_id: &str, epoch: &str, seq: u64, from_record: u64, max_bytes: Option<u64>, tail: bool) -> SyncResult<ReadPage> {
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        let key = self.load_key(&mut inner)?;
        let next = self.active_next(&mut inner)?;
        let Inner { folder, accepted, snapshot_cache, snapshot_ends, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        if tail {
            return store.read_snapshot_tail(device_id, epoch, seq, accepted, snapshot_ends, Some(snapshot_cache));
        }
        store.read_snapshot(device_id, epoch, seq, from_record, max_bytes, accepted, snapshot_cache)
    }

    /// Condition (h) (§18 point 11) : fin de l'instantané annoncé par son propre état authentifié, lue par Rust (même lecture que `tail`).
    fn own_snapshot_end(
        store: &Store<'_>,
        self_id: &str,
        own: Option<&PublishedState>,
        current_epoch: Option<&str>,
        accepted: &mut HashMap<String, Accepted>,
        ends: &mut HashMap<SnapshotEndKey, String>,
    ) -> SnapshotEndRead {
        let Some(state) = own else { return SnapshotEndRead::None };
        let Some(announced) = &state.snapshot else { return SnapshotEndRead::None };
        // Troisième revue, point 2 : seul un instantané de l'époque courante compte (même filtre que le moteur).
        if current_epoch.is_some_and(|e| e != state.epoch) {
            return SnapshotEndRead::None;
        }
        match store.read_snapshot_tail(self_id, &state.epoch, announced.seq, accepted, ends, None) {
            Ok(page) if page.status == "complete" => match page.records.first().and_then(|json| parse_snapshot_end(json, &state.epoch)) {
                Some(covers) => SnapshotEndRead::End(SnapshotEnd { author: self_id.to_owned(), epoch: state.epoch.clone(), seq: announced.seq, end_hlc: announced.end_hlc.clone(), covers }),
                None => SnapshotEndRead::Unreadable,
            },
            Ok(page) if page.status == "cloud-pending" => SnapshotEndRead::CloudPending,
            Err(error) if error.code == SyncCode::CloudPending => SnapshotEndRead::CloudPending,
            _ => SnapshotEndRead::Unreadable,
        }
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Écriture
    // --------------------------------------------------------------------------------------------------------------------------

    /// Dossier, clé, appareil lié, `own.json` valide.
    fn writable(&self, inner: &mut Inner) -> SyncResult<(Arc<MasterKey>, String, OwnState, Usage)> {
        self.require_folder(inner)?;
        let key = self.load_key(inner)?;
        let self_id = Self::bound_device(inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        self.refuse_if_self_forgotten(inner, &self_id)?;
        let own = self.valid_own(inner, &key, &self_id)?;
        let own = self.apply_pending(inner, own)?;
        let usage = self.usage(inner, key.kid());
        Ok((key, self_id, own, usage))
    }

    /// `sync_append_journal`.
    pub fn append_journal(&self, request: &AppendRequest) -> SyncResult<AppendResult> {
        let mut inner = self.lock();
        let (key, self_id, mut own, _) = self.writable(&mut inner)?;
        // Y-11 : l'ancienne époque est figée dès l'annonce (ou l'import de la nouvelle clé) : seule l'époque visée reçoit des ajouts.
        self.refuse_frozen_epoch(&mut inner, &self_id, &request.epoch)?;
        self.refuse_epoch_open(&mut inner, &key, &self_id, &own, &request.epoch)?;
        let next = self.active_next(&mut inner)?;
        let (mut usage, is_next) = self.usage_for(&mut inner, &key, &next, &request.epoch);
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
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
            self.save_usage_for(&mut inner, usage, is_next)?;
            self.save_own(&mut inner, own)?;
        }
        result
    }

    /// `sync_write_state` (état en forme JSON, analysé strictement).
    pub fn write_state(&self, sv: u64, state: serde_json::Value) -> SyncResult<()> {
        let state: PublishedState = serde_json::from_value(state).map_err(|_| SyncError::new(SyncCode::BadName))?;
        let mut inner = self.lock();
        let (key, self_id, mut own, _) = self.writable(&mut inner)?;
        // Y-10 (section 1.4, §18 point 3) : Rust est maître de `forgotten`. La liste du moteur doit être la liste maître du registre, ou
        // son préfixe (Rust complète, comme `pairedBy`) ; sinon refus. Registre illisible : `io` ; non reconstructible : refus.
        let master = self.registry(&mut inner, &key, &self_id)?.entries;
        let Some(forgotten) = completed_forgotten(&state.forgotten, &master) else {
            log::event("write-state-refused", "forgotten");
            return fail(SyncCode::StateMismatch);
        };
        let state = PublishedState { forgotten, ..state };
        // Y-11 (§18 point 16) : aucune autre époque que celle de la réinitialisation (ou de la restauration gagnante).
        self.refuse_epoch_open(&mut inner, &key, &self_id, &own, &state.epoch)?;
        // Y-11 (§14.3 étapes 3 et 4, §11.1) : Rust est maître de `reset`. Sous l'ancienne clé, l'appareil qui réinitialise publie son
        // annonce, tout autre état publie `reset: null` ; sous la nouvelle clé (`state.next.ctx`), `reset` est toujours nul ; aucune
        // donnée de l'époque visée avant l'annonce.
        let record = self.reset_record(&mut inner, &self_id)?;
        let next = self.active_next(&mut inner)?;
        let to_next = next.as_ref().is_some_and(|(_, e)| *e == state.epoch);
        let active = record.as_ref().filter(|r| r.active());
        if to_next {
            if state.reset.is_some() || active.is_some_and(|r| r.role == ResetRole::Initiator && r.stage < ResetStage::Announced) {
                log::event("write-state-refused", "reset");
                return fail(SyncCode::StateMismatch);
            }
        } else {
            let expected = active.filter(|r| r.role == ResetRole::Initiator).and_then(|r| r.notice.as_ref());
            if state.reset.as_ref() != expected || active.is_some_and(|r| r.role == ResetRole::Joined) {
                log::event("write-state-refused", "reset");
                return fail(SyncCode::StateMismatch);
            }
        }
        let (mut usage, is_next) = self.usage_for(&mut inner, &key, &next, &state.epoch);
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        let digest = store.write_state(&mut own, &mut usage, self.options.nonce_max, &self_id, self.options.platform, sv, &state)?;
        self.save_usage_for(&mut inner, usage, is_next)?;
        self.save_own(&mut inner, own)?;
        if let Some(epoch) = EpochId::parse(&state.epoch) {
            let head = RecordCursor { segment: state.head.segment, record: state.head.record };
            inner.accepted.insert(self_id.clone(), Accepted { epoch, seq: state.state_seq, digest: digest.clone(), head });
        }
        // Y-11 : étapes de l'appareil qui réinitialise, constatées sur ce qu'il vient de publier.
        if let Some(mut record) = record.filter(|r| r.active() && r.role == ResetRole::Initiator) {
            let mut changed = false;
            if !to_next {
                // Audit 5 : dernier état écrit sous l'ancienne clé, seul que l'anti-rejeu de soi peut reprendre en cas de perte.
                record.k_state = Some(KState { state_seq: state.state_seq, digest: digest.clone() });
                changed = true;
            }
            if !to_next && record.stage == ResetStage::Created && state.reset.is_some() {
                record.stage = ResetStage::Announced;
                record.base = Some(ResetBase { epoch: Some(state.epoch.clone()), segment: state.head.segment, record: state.head.record, max_hlc: state.head.hlc.clone() });
                record.notice_seq = Some(state.state_seq);
                log::event("reset-announced", &record.epoch);
            }
            if to_next && record.stage == ResetStage::Announced && state.snapshot.is_some() {
                record.stage = ResetStage::Opened;
                changed = true;
                log::event("reset-opened", &record.epoch);
            }
            if changed {
                self.save_reset(&record)?;
            }
        }
        Ok(())
    }

    /// `sync_snapshot_begin` : renvoie un numéro de handle.
    pub fn snapshot_begin(&self, epoch: &str, seq: u64, sv: u64) -> SyncResult<u32> {
        let mut inner = self.lock();
        let (key, self_id, own, _) = self.writable(&mut inner)?;
        self.refuse_frozen_epoch(&mut inner, &self_id, epoch)?;
        self.refuse_epoch_open(&mut inner, &key, &self_id, &own, epoch)?;
        // Instantané de même époque et même numéro déjà en cours d'écriture : même code qu'un numéro pris (revue 5).
        if inner.snapshots.values().any(|w| w.epoch == epoch && u64::from(w.seq) == seq) {
            return fail(SyncCode::SegmentMismatch);
        }
        let next = self.active_next(&mut inner)?;
        let Inner { folder, snapshots, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
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
        let (key, _, _, _) = self.writable(&mut inner)?;
        let Some(mut writer) = inner.snapshots.remove(&handle) else { return fail(SyncCode::BadName) };
        let next = self.active_next(&mut inner)?;
        let (mut usage, is_next) = self.usage_for(&mut inner, &key, &next, &writer.epoch);
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        match store.snapshot_append(&mut writer, &mut usage, self.options.nonce_max, records) {
            Ok(()) => {
                inner.snapshots.insert(handle, writer);
                self.save_usage_for(&mut inner, usage, is_next)
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
        let next = self.active_next(&mut inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        store.snapshot_commit(&writer).inspect_err(|_| store.snapshot_discard(&writer))
    }

    /// `sync_delete_own`.
    pub fn delete_own(&self, files: &[OwnFileRef]) -> SyncResult<u64> {
        let mut inner = self.lock();
        let (key, self_id, own, _) = self.writable(&mut inner)?;
        // Y-11 : pendant une réinitialisation, l'époque de l'annonce n'est supprimée que par la bascule (si la réinitialisation perd,
        // `own.json` y revient et ses segments doivent rester lisibles).
        if let Some(base) = self.reset_record(&mut inner, &self_id)?.filter(|r| r.active()).and_then(|r| r.base).and_then(|b| b.epoch) {
            if files.iter().any(|f| f.epoch == base) {
                return fail(SyncCode::StateMismatch);
            }
        }
        let next = self.active_next(&mut inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        store_for(bound, &key, &next, false).delete_own(&own, &self_id, files)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Appairage
    // --------------------------------------------------------------------------------------------------------------------------

    /// Préconditions de `sync_pairing_open` : dossier ; en mode `show`, clé et appareil lié. Y-11 (D1) : jamais l'ancienne clé quand une
    /// réinitialisation d'un autre appareil est annoncée (ou que celle de cet appareil a perdu) : `state-mismatch`.
    pub fn pairing_preconditions(&self, show: bool) -> SyncResult<()> {
        let mut inner = self.lock();
        self.require_folder(&mut inner)?;
        if show {
            let key = self.load_key(&mut inner)?;
            let self_id = Self::bound_device(&inner).ok_or(SyncError::new(SyncCode::NotBound))?;
            if self.active_next(&mut inner)?.is_none() && self.old_key_withdrawn(&mut inner, &key, &self_id)? {
                log::event("pairing-refused", "reset-announced");
                return fail(SyncCode::StateMismatch);
            }
        }
        Ok(())
    }

    /// Y-11 : l'ancienne clé ne doit plus être donnée : registre perdu non réassocié, ou annonce valide d'un autre appareil déjà lisible
    /// qui l'emporte. Échoue fermé (audit 6) : registre illisible, liste coupée (`state-mismatch`) ou état dans le nuage (`cloud-pending`)
    /// refusent, jamais « rien d'annoncé ».
    fn old_key_withdrawn(&self, inner: &mut Inner, key: &MasterKey, self_id: &str) -> SyncResult<bool> {
        // Perte face à une autre réinitialisation : sa nouvelle clé l'emporte ; face à une restauration (§18 point 16), K reste la clé.
        if self.reset_record(inner, self_id)?.is_some_and(|r| r.superseded.as_ref().is_some_and(|s| s.epoch.is_some() && !s.restore)) {
            return Ok(true);
        }
        let entries = self.registry(inner, key, self_id)?.entries;
        let forgotten: BTreeSet<String> = forget_order(&entries).into_keys().collect();
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store::new(bound.fs.as_ref(), key, false);
        let Some(reads) = Self::read_all_states(&store, &mut inner.accepted)? else {
            log::event("pairing-refused", "listing");
            return fail(SyncCode::StateMismatch);
        };
        // Seconde revue, point 2 : seul un actif (ni oublié, ni expiré d'après le dernier scan) dont l'état attend iCloud bloque ; le
        // message invite à réessayer.
        let now = self.now();
        let expired = |id: &str| inner.last_seen.get(id).is_some_and(|ms| ms.saturating_add(DEVICE_EXPIRY_MS) < now);
        if reads.iter().any(|(id, r)| id != self_id && r.status == StateStatus::CloudPending && !forgotten.contains(id) && !expired(id)) {
            log::event("pairing-refused", "cloud-pending");
            return fail(SyncCode::CloudPending);
        }
        Ok(reset_winner(&Self::contenders(&reads, self_id), &forgotten).is_some_and(|w| !w.restore))
    }

    /// Annonces lues dans les états authentifiés des autres appareils (sous la clé locale).
    fn announcements(reads: &BTreeMap<String, StateRead>, self_id: &str) -> Vec<ResetCandidate> {
        reads
            .iter()
            .filter(|(id, r)| id.as_str() != self_id && r.status == StateStatus::Ok)
            .filter_map(|(id, r)| {
                r.state.as_ref().and_then(|s| s.reset.as_ref().map(|n| ResetCandidate { by: id.clone(), state_epoch: s.epoch.clone(), notice: n.clone(), restore: false }))
            })
            .collect()
    }

    /// Concurrents (§18 point 16) : annonces des autres appareils et époques ouvertes sous la clé locale (soi compris).
    fn contenders(reads: &BTreeMap<String, StateRead>, self_id: &str) -> Vec<ResetCandidate> {
        let mut out = Self::announcements(reads, self_id);
        let opened: Vec<OpenedEpoch> = Self::ok_states(reads)
            .into_iter()
            .map(|(id, s)| OpenedEpoch { by: id.to_owned(), epoch: s.epoch.clone(), snapshot: s.snapshot.is_some(), notice: s.reset.is_some() })
            .collect();
        let restores = restore_candidates(&opened, &out);
        out.extend(restores);
        out
    }

    /// Contenu du QR et clé de secours (`sync_pairing_payload`, après les contrôles de fenêtre et de jeton). Y-11 (D1) : pendant une
    /// réinitialisation, la **nouvelle** clé et l'époque visée (jamais l'ancienne clé).
    pub fn pairing_payload(&self, expires_at: u64) -> SyncResult<PairingPayload> {
        let mut inner = self.lock();
        let folder_id = self.require_folder(&mut inner)?.folder_id.clone();
        let key = self.load_key(&mut inner)?;
        let self_id = Self::bound_device(&inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        if let Some((next, epoch)) = self.active_next(&mut inner)? {
            let qr = qr_text_of(&next, &self_id, Some(&epoch), expires_at);
            let recovery = next.recovery_key();
            log::event("pairing-payload", "issued-next");
            return Ok(PairingPayload { qr_text: (*qr).clone(), recovery_key: (*recovery).clone(), expires_at });
        }
        if self.old_key_withdrawn(&mut inner, &key, &self_id)? {
            log::event("pairing-refused", "reset-announced");
            return fail(SyncCode::StateMismatch);
        }
        let epoch = inner.own.as_ref().filter(|o| o.folder_id == folder_id && o.kid == key.kid()).and_then(|o| o.epoch.clone()).or_else(|| {
            read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == key.kid()).and_then(|o| o.epoch)
        });
        let qr = qr_text_of(&key, &self_id, epoch.as_deref(), expires_at);
        let recovery = key.recovery_key();
        log::event("pairing-payload", "issued");
        Ok(PairingPayload { qr_text: (*qr).clone(), recovery_key: (*recovery).clone(), expires_at })
    }

    /// `sync_key_import` : dossier d'abord, clé ensuite (section 10.3). `owner` : fenêtre appelante (premier plan, boîte).
    ///
    /// Y-11 (§14.3 « Réassociation de B ») : un appareil déjà associé à ce dossier avec une autre clé (son propre état se déchiffre avec
    /// elle) qui importe la nouvelle clé d'une réinitialisation l'écrit sous `circletasks.sync.key.next`, jamais par-dessus `.v1` avant la
    /// bascule (confirmation native de remplacement de Y-08) ; `reset.json` passe au rôle `joined`.
    pub fn key_import(&self, input: KeyInput, owner: isize) -> SyncResult<KeyImportResult> {
        let result = self.key_import_inner(input, owner);
        match &result {
            Ok(_) => {
                if remove_config_file(&self.path(IMPORT_FAILURE_FILE)).is_err() {
                    log::event("import-failure-uncleared", "io");
                }
            }
            Err(error) => self.record_import_failure(error.code),
        }
        result
    }

    fn key_import_inner(&self, input: KeyInput, owner: isize) -> SyncResult<KeyImportResult> {
        self.consent.count_import(owner)?;
        let (key, paired_by, epoch, replace, joined) = {
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
            // Y-11 : la clé locale déjà retirée (réinitialisation en cours ici, ou annonce d'un autre appareil qui l'emporte) n'« associe »
            // rien : l'ancienne clé de secours est refusée comme une autre clé.
            if same {
                if let Some(self_id) = Self::bound_device(&inner) {
                    let withdrawn = self.active_next(&mut inner)?.is_some() || self.old_key_withdrawn(&mut inner, &key, &self_id)?;
                    if withdrawn {
                        log::event("key-import-refused", "withdrawn");
                        return fail(SyncCode::KeyMismatch);
                    }
                }
            }
            // Y-11 : réassociation après une réinitialisation (nouvelle clé sous `.next`) ? Déjà importée : sans effet.
            let joined = match &existing {
                Some(old) if replace => self.join_plan(&mut inner, old, &key, check.epoch.clone())?,
                _ => None,
            };
            if let Some(JoinPlan::Already) = joined {
                log::event("key-import-already-next", key.kid());
                return Ok(KeyImportResult { kid: key.kid().to_owned(), paired_by, epoch: check.epoch });
            }
            (key, paired_by, epoch, if same { None } else { Some(replace) }, joined)
        };
        if replace == Some(true) {
            self.consent.confirm(ConsentKind::ReplaceKey, owner)?;
        }
        let mut inner = self.lock();
        // Nouvelle clé : aucun instantané lu avec l'ancienne ne reste en cache (revue B3).
        inner.snapshot_cache = None;
        inner.snapshot_ends.clear();
        // Clé existante relue sous le verrou (revue 17) : une autre clé apparue pendant la boîte n'est jamais remplacée sans accord.
        let existing = self.read_vault_key()?;
        if replace != Some(true) && existing.as_ref().is_some_and(|e| !e.same_as(&key)) {
            return fail(SyncCode::ConsentDenied);
        }
        if let Some(JoinPlan::Join(record)) = joined {
            // Ordre : nouvelle clé sous `.next`, puis le registre ; `.v1` (ancienne clé) reste intacte jusqu'à la bascule.
            if !existing.as_ref().is_some_and(|e| e.kid() != record.kid) {
                return fail(SyncCode::ConsentDenied);
            }
            self.vault.set(SYNC_NEXT_KEY_ACCOUNT, &key.to_vault_value()).map_err(vault_error)?;
            self.save_reset(&record)?;
            remove_config_file(&self.path(USAGE_NEXT_FILE))?;
            inner.next = None;
            inner.own = None;
            if let Some(paired) = paired_by.clone() {
                let old = Arc::new(existing.ok_or(SyncError::new(SyncCode::KeyMissing))?);
                inner.key = Some(old.clone());
                if let Ok(mut own) = self.valid_own(&mut inner, &old, &record.device_id) {
                    own.paired_by = Some(paired);
                    self.save_own(&mut inner, own)?;
                }
            }
            log::event("key-imported-next", &record.kid);
            return Ok(KeyImportResult { kid: record.kid, paired_by, epoch: Some(record.epoch) });
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
        inner.next = None;
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
    fn rebuild_registry(&self, inner: &mut Inner, key: &MasterKey, folder_id: &str, self_id: &str) -> SyncResult<ForgottenRegistry> {
        let own_json = read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == key.kid());
        let next = self.active_next(inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, key, &next, false);
        let reads = Self::read_all_states(&store, &mut inner.accepted)?.ok_or(SyncError::new(SyncCode::StateMismatch))?;
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
        // Registre reconstruit : un appareil oublié par la liste reconstruite est de nouveau arrêté (§18 point 12).
        reg.note_self_forgotten();
        Ok(reg)
    }

    /// Époque courante du dossier vue par Rust : la plus grande époque annoncée par un état authentifié d'un appareil non oublié (section 9 ;
    /// un oublié ne fixe pas l'époque, comme chez le moteur).
    fn current_epoch(reads: &BTreeMap<String, StateRead>, order: &BTreeMap<String, super::forget::Verdict>) -> Option<String> {
        Self::ok_states(reads).into_iter().filter(|(id, _)| !order.contains_key(*id)).filter_map(|(_, s)| EpochId::parse(&s.epoch)).max().map(|e| e.name())
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
        if reg.note_self_forgotten() {
            log::event("self-forgotten", self_id);
            changed = true;
        }
        if changed {
            self.save_registry(&reg)?;
        }
        Ok(reg.view(overflow))
    }

    /// Réinitialisation en cours (section 14.3) : entrée `.next` au coffre (présence seule, secret jamais gardé), ou annonce `reset`
    /// lue dans un état authentifié. Suppression des fichiers d'un oublié (`sync_forgotten_delete`) : refusée pendant toute la
    /// transition.
    fn reset_in_progress(&self, reads: &BTreeMap<String, StateRead>) -> SyncResult<bool> {
        if self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)? {
            return Ok(true);
        }
        Ok(reads.values().any(|r| r.status == StateStatus::Ok && r.state.as_ref().is_some_and(|s| s.reset.is_some())))
    }

    /// Y-11 (§14.3 « Pas d'oubli d'office », §18 points 14 et 15) : pendant une réinitialisation en cours (registre, entrée `.next`, ou
    /// annonce lue), la déclaration d'un oubli (`sync_device_forget`) n'est permise que (i) à l'appareil qui réinitialise, bascule pas
    /// commencée, quelle que soit la cible, ou (ii) sur tout appareil quand la cible est l'auteur d'une annonce (lue dans un état `ok`
    /// sous la clé locale, valide ou non ; auteur de la réinitialisation rejointe ; gagnant d'une perte). Tout autre cas : refus.
    fn reset_blocks_forget(&self, inner: &mut Inner, reads: &BTreeMap<String, StateRead>, self_id: &str, target: &str) -> SyncResult<bool> {
        let record = self.reset_record(inner, self_id)?;
        let mut announcers: BTreeSet<String> = reads
            .iter()
            .filter(|(id, r)| id.as_str() != self_id && r.status == StateStatus::Ok && r.state.as_ref().is_some_and(|s| s.reset.is_some()))
            .map(|(id, _)| id.clone())
            .collect();
        let in_progress = record.is_some() || !announcers.is_empty() || self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?;
        if !in_progress {
            return Ok(false);
        }
        if record.as_ref().is_some_and(|r| r.active() && r.role == ResetRole::Initiator && r.switch_step == 0) {
            return Ok(false);
        }
        if let Some(r) = &record {
            if r.by != self_id {
                announcers.insert(r.by.clone());
            }
            if let Some(by) = r.superseded.as_ref().and_then(|s| s.by.clone()) {
                announcers.insert(by);
            }
        }
        Ok(!announcers.contains(target))
    }

    /// États de tous les dossiers d'appareils de `devices/` (liste complète exigée, 10 000 entrées ; le plafond de 16 dossiers ne
    /// s'applique pas) : anti-rejeu de `accepted` ; chaque état authentifié lu y est **retenu** (Y-TECH-01 : toute lecture authentifiée qui
    /// fonde une décision met l'anti-rejeu à jour, sinon un ancien état remis ensuite passerait pour `ok`). `None` : liste coupée.
    fn read_all_states(store: &Store<'_>, accepted: &mut HashMap<String, Accepted>) -> SyncResult<Option<BTreeMap<String, StateRead>>> {
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
            let read = store.read_state(&entry.name, accepted);
            Store::remember(&entry.name, &read, accepted);
            reads.insert(entry.name.clone(), read);
        }
        Ok(Some(reads))
    }

    /// Préconditions communes : dossier, clé, appareil lié ; renvoie la clé et l'appareil local.
    fn forget_context(&self, inner: &mut Inner) -> SyncResult<(Arc<MasterKey>, String)> {
        let bound = self.require_folder(inner)?;
        bound.fs.start_cycle().map_err(|e| SyncError::new(e.code()))?;
        let key = self.load_key(inner)?;
        let self_id = Self::bound_device(inner).ok_or(SyncError::new(SyncCode::NotBound))?;
        self.refuse_if_self_forgotten(inner, &self_id)?;
        Ok((key, self_id))
    }

    /// Arrêt définitif (§18 point 12) : appareil qui s'est vu oublié (`selfForgotten` du registre) → toute écriture refusée
    /// (`state-mismatch`), même si le verdict a changé depuis ; seuls `sync_folder_forget` et une nouvelle identité en sortent.
    fn refuse_if_self_forgotten(&self, inner: &mut Inner, self_id: &str) -> SyncResult<()> {
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        if self.load_registry(&folder_id, self_id)?.is_some_and(|reg| reg.self_forgotten.is_some()) {
            log::event("self-forgotten-refused", self_id);
            return fail(SyncCode::StateMismatch);
        }
        Ok(())
    }

    /// Contrôles de `sync_device_forget`, avant puis après la boîte (sous le verrou) : `Ok(None)` si l'appareil est déjà oublié
    /// (idempotent, aucune boîte), sinon le registre avec la déclaration ajoutée et le détail de la boîte.
    fn forget_declaration(&self, inner: &mut Inner, device_id: &str) -> SyncResult<Option<(ForgottenRegistry, String)>> {
        let (key, self_id) = self.forget_context(inner)?;
        if device_id == self_id {
            return fail(SyncCode::BadName);
        }
        let mut reg = self.registry(inner, &key, &self_id)?;
        let next = self.active_next(inner)?;
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        let reads = Self::read_all_states(&store, &mut inner.accepted)?.ok_or(SyncError::new(SyncCode::StateMismatch))?;
        if self.reset_blocks_forget(inner, &reads, &self_id, device_id)? {
            log::event("forget-refused", "reset");
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
        let next = self.active_next(&mut inner)?;
        let Inner { folder, accepted, snapshot_ends, .. } = &mut *inner;
        let bound = folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = store_for(bound, &key, &next, false);
        let Some(reads) = Self::read_all_states(&store, accepted)? else {
            log::event("forgotten-delete-refused", "listing");
            return fail(SyncCode::StateMismatch);
        };
        // Y-TECH-01 : les états qui fondent la suppression entrent dans l'anti-rejeu persistant avant toute suppression (un ancien état
        // remis ensuite, même après un redémarrage, est `rollback`).
        if Self::absorb_accepted(&mut reg, accepted) {
            self.save_registry(&reg)?;
        }
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
        let own_state = reads.get(&self_id).filter(|r| r.status == StateStatus::Ok).and_then(|r| r.state.as_ref());
        let current_epoch = Self::current_epoch(&reads, &order);
        let own_snapshot = snapshot_in_epoch(Self::own_snapshot_end(&store, &self_id, own_state, current_epoch.as_deref(), accepted, snapshot_ends), current_epoch.as_deref());
        match forgotten_delete_check(device_id, &self_id, &reg.entries, &reg.done, &known, &own_snapshot) {
            DeleteCheck::Ready { .. } => {}
            DeleteCheck::Waiting { device, code, reason } => {
                log::event("forgotten-delete-waiting", &format!("{device} {}", reason.as_str()));
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
    // Réinitialisation avec une nouvelle clé (Y-11 ; ADR 0011 sections 2.2, 9.1, 11.1, 14.3 et 18 point 2)
    // --------------------------------------------------------------------------------------------------------------------------

    /// Point d'arrêt simulé des tests (`io` avant l'étape nommée) ; absent hors de la fonctionnalité `test-hooks`.
    #[cfg(feature = "test-hooks")]
    fn interrupt(&self, step: &str) -> SyncResult<()> {
        if self.options.interrupt.as_ref().is_some_and(|stop| stop(step)) {
            log::event("reset-interrupted", step);
            return fail(SyncCode::Io);
        }
        Ok(())
    }

    #[cfg(not(feature = "test-hooks"))]
    #[inline(always)]
    fn interrupt(&self, _step: &str) -> SyncResult<()> {
        Ok(())
    }

    /// Registre lu : absent (aucun fichier, autre dossier, autre identité) → `None` ; illisible ou mal formé → `io` (jamais absent).
    fn load_reset(&self, folder_id: &str, self_id: &str) -> SyncResult<Option<ResetRecord>> {
        match read_config_file::<ResetRecord>(&self.path(RESET_FILE)) {
            Ok(None) => Ok(None),
            Ok(Some(record)) if record.is_valid() => Ok((record.folder_id == folder_id && record.device_id == self_id).then_some(record)),
            Ok(Some(_)) | Err(()) => {
                log::event("reset-registry-unreadable", "io");
                fail(SyncCode::Io)
            }
        }
    }

    fn reset_record(&self, inner: &mut Inner, self_id: &str) -> SyncResult<Option<ResetRecord>> {
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        self.load_reset(&folder_id, self_id)
    }

    fn save_reset(&self, record: &ResetRecord) -> SyncResult<()> {
        write_config_file(&self.path(RESET_FILE), &serde_json::to_vec(record).unwrap_or_default())
    }

    /// Nouvelle clé active (registre non perdu et entrée `.next` de même `kid`) et époque visée, mise en cache jusqu'au prochain
    /// changement du registre ou du coffre.
    fn active_next(&self, inner: &mut Inner) -> SyncResult<Option<(Arc<MasterKey>, String)>> {
        if let Some(cached) = &inner.next {
            return Ok(cached.clone());
        }
        let Some(self_id) = Self::bound_device(inner) else { return Ok(None) };
        let value = match self.reset_record(inner, &self_id)? {
            Some(record) if record.active() => self.read_vault_next()?.filter(|k| k.kid() == record.kid).map(|k| (Arc::new(k), record.epoch)),
            _ => None,
        };
        inner.next = Some(value.clone());
        Ok(value)
    }

    /// Abandon d'une réinitialisation liée au dossier délié ou remplacé : registre et budget supprimés, nouvelle clé effacée ; `.v1`
    /// reste (jamais d'instant sans clé valide).
    fn abandon_reset(&self) -> SyncResult<()> {
        // Revue 10 : la nouvelle clé est effacée même sans registre valide (orpheline d'un arrêt pendant `sync_reset_key`).
        if self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)? {
            self.vault.delete(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?;
        }
        remove_config_file(&self.path(RESET_FILE))?;
        remove_config_file(&self.path(USAGE_NEXT_FILE))?;
        log::event("reset-abandoned", "folder");
        Ok(())
    }

    /// Y-11 : l'ancienne époque est figée dès l'annonce (appareil qui réinitialise) ou l'import (appareil réassocié) : aucun ajout ni
    /// instantané hors de l'époque visée (`own.json` doit pouvoir revenir à la position de l'annonce si la réinitialisation perd).
    fn refuse_frozen_epoch(&self, inner: &mut Inner, self_id: &str, epoch: &str) -> SyncResult<()> {
        let Some(record) = self.reset_record(inner, self_id)? else { return Ok(()) };
        let frozen = record.active() && (record.role == ResetRole::Joined || record.stage >= ResetStage::Announced);
        if frozen && epoch != record.epoch {
            log::event("reset-frozen-epoch", epoch);
            return fail(SyncCode::StateMismatch);
        }
        Ok(())
    }

    /// Garde d'époque (§18 point 16, audit 8) : (0) rien dans l'époque visée avant l'annonce ; une époque supérieure à celle de
    /// `own.json` est refusée (i) si `reset.json` existe et qu'elle n'est pas la sienne (époque visée, ou gagnante d'une perte), ou (ii)
    /// sans registre, si une annonce valide d'un autre appareil est lue et l'emporte (sauf l'époque restaurée gagnante). `state-mismatch`,
    /// rien n'est écrit.
    fn refuse_epoch_open(&self, inner: &mut Inner, key: &MasterKey, self_id: &str, own: &OwnState, epoch: &str) -> SyncResult<()> {
        let record = self.reset_record(inner, self_id)?;
        if let Some(r) = record.as_ref().filter(|r| r.active() && r.role == ResetRole::Initiator && r.stage < ResetStage::Announced) {
            if epoch == r.epoch {
                log::event("epoch-open-refused", "not-announced");
                return fail(SyncCode::StateMismatch);
            }
        }
        let (Some(target), Some(current)) = (EpochId::parse(epoch), own.epoch.as_deref().and_then(EpochId::parse)) else { return Ok(()) };
        if target <= current {
            return Ok(());
        }
        let allowed = record.as_ref().and_then(|r| if r.active() { Some(r.epoch.clone()) } else { r.superseded.as_ref().and_then(|s| s.epoch.clone()) });
        if let Some(allowed) = allowed {
            if allowed != epoch {
                log::event("epoch-open-refused", "reset");
                return fail(SyncCode::StateMismatch);
            }
            return Ok(());
        }
        let reg = self.registry(inner, key, self_id)?;
        let forgotten: BTreeSet<String> = forget_order(&reg.entries).into_keys().collect();
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store::new(bound.fs.as_ref(), key, false);
        let Some(reads) = Self::read_all_states(&store, &mut inner.accepted)? else {
            log::event("epoch-open-refused", "listing");
            return fail(SyncCode::StateMismatch);
        };
        let contenders = Self::contenders(&reads, self_id);
        if let Some(winner) = reset_winner(&contenders, &forgotten) {
            if !(winner.restore && winner.notice.epoch == epoch) {
                log::event("epoch-open-refused", "announced");
                return fail(SyncCode::StateMismatch);
            }
        }
        Ok(())
    }

    /// Appareils connus pour la précondition et la bascule (section 14.2 (c)) : dossiers, cités par les actifs, anti-rejeu du registre,
    /// cibles et auteurs de la liste maître.
    fn known_ids(reads: &BTreeMap<String, StateRead>, reg: &ForgottenRegistry) -> (BTreeSet<String>, BTreeSet<String>, BTreeSet<String>) {
        let ok: Vec<(&str, &PublishedState)> = Self::ok_states(reads);
        let seen = seen_devices(reg.accepted.keys(), ok.iter().map(|(id, s)| (*id, &s.acks)), &reg.entries);
        let authors: BTreeSet<String> = reg.entries.iter().filter_map(declaration_author).map(str::to_owned).collect();
        let mut ids: BTreeSet<String> = reads.keys().cloned().collect();
        ids.extend(seen.iter().cloned());
        ids.extend(reg.entries.iter().map(|f| f.device_id.clone()));
        (ids, seen, authors)
    }

    /// `sync_reset_key` : refus avant toute boîte, reprise d'une réinitialisation interrompue (même `K2`, sans boîte), puis confirmation
    /// native (« Annuler » par défaut), puis `K2` créée par Rust sous `circletasks.sync.key.next` et `sync/reset.json`. Ne rend que le
    /// `kid` : la clé ne traverse jamais la WebView.
    pub fn reset_key(&self, owner: isize) -> SyncResult<String> {
        if let ResetPlan::Resume(kid) = self.reset_plan(&mut self.lock())? {
            log::event("reset-resumed", &kid);
            return Ok(kid);
        }
        self.consent.confirm_reset(owner)?;
        let mut inner = self.lock();
        // Contrôles refaits après la boîte : l'état a pu changer pendant qu'elle était ouverte.
        let plan = match self.reset_plan(&mut inner)? {
            ResetPlan::Resume(kid) => return Ok(kid),
            ResetPlan::Create(plan) => plan,
        };
        // Une `K2` orpheline (arrêt entre l'écriture de la clé et celle du registre) est reprise, jamais remplacée : rien n'a été annoncé.
        let next = match self.read_vault_next()? {
            Some(orphan) => orphan,
            None => {
                let created = MasterKey::generate().map_err(|_| SyncError::new(SyncCode::Io))?;
                self.vault.set(SYNC_NEXT_KEY_ACCOUNT, &created.to_vault_value()).map_err(vault_error)?;
                created
            }
        };
        let kid = next.kid().to_owned();
        let record = ResetRecord {
            folder_id: plan.folder_id,
            device_id: plan.self_id.clone(),
            role: ResetRole::Initiator,
            kid: kid.clone(),
            epoch: plan.epoch.clone(),
            by: plan.self_id,
            notice: Some(ResetNotice { kid: kid.clone(), epoch: plan.epoch, at: plan.at }),
            notice_epoch: Some(plan.notice_epoch),
            notice_seq: None,
            k_state: None,
            author_at_import: None,
            stage: ResetStage::Created,
            base: None,
            superseded: None,
            switch_step: 0,
        };
        self.save_reset(&record)?;
        // Budget de nonces de la nouvelle clé : repart de zéro (§2).
        write_config_file(&self.path(USAGE_NEXT_FILE), &serde_json::to_vec(&Usage { kid: kid.clone(), sealed: 0 }).unwrap_or_default())?;
        inner.next = None;
        log::event("reset-created", &kid);
        Ok(kid)
    }

    /// Contrôles de `sync_reset_key` (avant et après la boîte) : reprise, ou plan de création ; sinon refus sans rien écrire.
    fn reset_plan(&self, inner: &mut Inner) -> SyncResult<ResetPlan> {
        let (key, self_id) = self.forget_context(inner)?;
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        let reg = self.registry(inner, &key, &self_id)?;
        match self.load_reset(&folder_id, &self_id)? {
            Some(record) if record.active() && record.role == ResetRole::Initiator => {
                // Reprise : même `K2`, jamais une autre.
                return match self.read_vault_next()? {
                    Some(next) if next.kid() == record.kid => Ok(ResetPlan::Resume(record.kid)),
                    _ => fail(SyncCode::StateMismatch),
                };
            }
            Some(record) if record.active() => {
                log::event("reset-refused", "joined");
                return fail(SyncCode::StateMismatch);
            }
            Some(record) if record.superseded.as_ref().is_some_and(|s| s.epoch.is_some() && !s.restore) => {
                log::event("reset-refused", "superseded");
                return fail(SyncCode::StateMismatch);
            }
            _ => {}
        }
        // Une entrée `.next` sans registre ne peut venir que d'un arrêt pendant `sync_reset_key` (adoptée à la création) ; avec un registre
        // perdu sans gagnant (« relancez-la »), il est remplacé à la création.
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store::new(bound.fs.as_ref(), &key, false);
        let Some(reads) = Self::read_all_states(&store, &mut inner.accepted)? else {
            log::event("reset-refused", "listing");
            return fail(SyncCode::StateMismatch);
        };
        let order = forget_order(&reg.entries);
        let forgotten: BTreeSet<String> = order.keys().cloned().collect();
        // Annonce valide d'un autre appareil déjà lue (et gagnante) : traité comme un appareil à réassocier (§14.3, deux
        // réinitialisations).
        if reset_winner(&Self::contenders(&reads, &self_id), &forgotten).is_some_and(|w| !w.restore) {
            log::event("reset-refused", "announced");
            return fail(SyncCode::StateMismatch);
        }
        let Some(own) = reads.get(&self_id).filter(|r| r.status == StateStatus::Ok).and_then(|r| r.state.as_ref()) else {
            log::event("reset-refused", "own-state");
            return fail(SyncCode::StateMismatch);
        };
        let (ids, seen, authors) = Self::known_ids(&reads, &reg);
        let now = self.now();
        let live: Vec<(&str, &PublishedState)> = Self::ok_states(&reads).into_iter().filter(|(id, _)| !order.contains_key(*id)).collect();
        let actives: Vec<PreconditionDevice> = ids
            .iter()
            .filter(|id| id.as_str() != self_id && !order.contains_key(id.as_str()))
            .map(|id| {
                let read = reads.get(id);
                let status = read.map_or(StateStatus::Missing, |r| r.status);
                let state = read.filter(|r| r.status == StateStatus::Ok).and_then(|r| r.state.as_ref());
                let expired = state.is_some_and(|s| hlc_ms(&s.last_sync_hlc).is_some_and(|ms| ms.saturating_add(DEVICE_EXPIRY_MS) < now));
                PreconditionDevice {
                    device_id: id.clone(),
                    status,
                    head: state.map(|s| s.head.clone()),
                    expired,
                    phantom: status != StateStatus::Ok && !seen.contains(id) && !authors.contains(id),
                }
            })
            .collect();
        let cuts: Vec<ForgottenCut> = order.keys().map(|target| ForgottenCut { device_id: target.clone(), cutoff: super::forget::cutoff(target, live.iter().map(|(id, s)| (*id, &s.acks))) }).collect();
        if let Some((device, reason)) = reset_precondition(&actives, &cuts, &own.acks) {
            log::event("reset-refused-lagging", &format!("{device} {}", reason.as_str()));
            return fail(SyncCode::StateMismatch);
        }
        let current = Self::current_epoch(&reads, &order).and_then(|e| EpochId::parse(&e));
        let base = EpochId::parse(&own.epoch).into_iter().chain(current).max().ok_or(SyncError::new(SyncCode::StateMismatch))?;
        if base.n >= super::names::MAX_EPOCH_NUMBER {
            return fail(SyncCode::TooLarge);
        }
        let epoch = EpochId { n: base.n + 1, opener: self_id.clone() }.name();
        let seen_hlcs = live.iter().flat_map(|(_, s)| state_hlcs(s));
        let at = next_declaration_hlc(now, seen_hlcs, &self_id, PAIRING_CLOCK_TOLERANCE_MS).ok_or(SyncError::new(SyncCode::HlcOrder))?;
        Ok(ResetPlan::Create(CreatePlan { folder_id, self_id, epoch, at, notice_epoch: own.epoch.clone() }))
    }

    /// Import d'une autre clé par un appareil associé (Y-11) : `None` si l'import ordinaire s'applique (appareil qui n'a jamais publié
    /// avec la clé locale dans ce dossier) ; sinon le registre `joined` à écrire, ou `Already` si cette clé est déjà la nouvelle clé.
    fn join_plan(&self, inner: &mut Inner, old: &MasterKey, candidate: &MasterKey, epoch: Option<String>) -> SyncResult<Option<JoinPlan>> {
        let Some(self_id) = Self::bound_device(inner) else { return Ok(None) };
        let folder_id = self.require_folder(inner)?.folder_id.clone();
        let record = self.load_reset(&folder_id, &self_id)?;
        if let Some(r) = record.as_ref().filter(|r| r.active()) {
            if r.kid == candidate.kid() {
                return Ok(Some(JoinPlan::Already));
            }
            // Une autre réinitialisation est déjà en cours ici (lancée ou rejointe) : jamais deux nouvelles clés.
            log::event("key-import-refused", "reset-in-progress");
            return fail(SyncCode::StateMismatch);
        }
        // Audit 2 : appartenance au dossier sur des preuves locales (son état sous l'ancienne clé, `own.json` lié au dossier et à
        // l'ancienne clé, anti-rejeu de soi au registre Y-10, fichiers déjà publiés) ; son état dans le nuage : `cloud-pending`. Jamais
        // l'import ordinaire, qui écraserait `.v1`, pour un appareil qui a publié sous l'ancienne clé.
        let own_json = read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == old.kid());
        let registered = matches!(self.load_registry(&folder_id, &self_id), Ok(Some(reg)) if reg.accepted.contains_key(&self_id));
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store::new(bound.fs.as_ref(), old, false);
        let own = store.read_state_file(&self_id, STATE_FILE, old, &HashMap::new());
        if own.status == StateStatus::CloudPending {
            log::event("key-import-refused", "own-state-cloud-pending");
            return fail(SyncCode::CloudPending);
        }
        let published = matches!(store.fs.list(&[DEVICES_DIR, &self_id], 1), Ok(Listing { entries, .. }) if !entries.is_empty());
        let member = matches!(own.status, StateStatus::Ok | StateStatus::Rollback)
            || record.is_some()
            || own_json.as_ref().is_some_and(|o| o.state_seq > 0 || o.epoch.is_some())
            || registered
            || published;
        if !member {
            return Ok(None);
        }
        let Some(epoch) = epoch.filter(|e| EpochId::parse(e).is_some()) else {
            log::event("key-import-refused", "epoch");
            return fail(SyncCode::KeyMismatch);
        };
        // Revue 2 : l'époque lue avec la clé candidate doit dépasser l'époque courante de cet appareil (ancienne clé de secours, copie
        // d'une époque antérieure : `key-mismatch`, rien n'est enregistré).
        let current = own_json.as_ref().and_then(|o| o.epoch.as_deref()).and_then(EpochId::parse).into_iter().chain(own.state.as_ref().and_then(|s| EpochId::parse(&s.epoch))).max();
        if current.is_some_and(|c| EpochId::parse(&epoch).map_or(true, |e| e <= c)) {
            log::event("key-import-refused", "epoch-not-newer");
            return fail(SyncCode::KeyMismatch);
        }
        let by = EpochId::parse(&epoch).map(|e| e.opener).unwrap_or_default();
        // Annonce de l'auteur lue sous l'ancienne clé (absente si l'auteur a déjà basculé).
        let announced = store.read_state_file(&by, STATE_FILE, old, &HashMap::new());
        let author_at_import = announced.state.as_ref().filter(|_| announced.status == StateStatus::Ok).map(|s| AuthorSeen { state_seq: s.state_seq, epoch: s.epoch.clone() });
        let (notice, notice_epoch, notice_seq) = match announced.state.filter(|_| announced.status == StateStatus::Ok) {
            Some(s) if s.reset.as_ref().is_some_and(|n| n.kid == candidate.kid() && n.epoch == epoch) => (s.reset.clone(), Some(s.epoch.clone()), Some(s.state_seq)),
            _ => (None, None, None),
        };
        // Audit 5 : son dernier état sous l'ancienne clé (seul repris par l'anti-rejeu de soi si la réinitialisation perd).
        let k_state = match (own.status, &own.state, &own.digest) {
            (StateStatus::Ok, Some(s), Some(d)) => Some(KState { state_seq: s.state_seq, digest: d.clone() }),
            _ => None,
        };
        let own_json = self.valid_own(inner, old, &self_id).ok();
        let base = own_json.map(|o| ResetBase { epoch: o.epoch, segment: o.segment, record: o.record, max_hlc: o.max_hlc });
        Ok(Some(JoinPlan::Join(Box::new(ResetRecord {
            folder_id,
            device_id: self_id,
            role: ResetRole::Joined,
            kid: candidate.kid().to_owned(),
            epoch,
            by,
            notice,
            notice_epoch,
            notice_seq,
            k_state,
            author_at_import,
            stage: ResetStage::Opened,
            base,
            superseded: None,
            switch_step: 0,
        }))))
    }

    /// Passage de la réinitialisation au scan (§14.3, §18 point 2) : reprise d'une bascule commencée ; étapes du perdant ; perte
    /// constatée (annonce valide plus grande, annonce de l'auteur retirée) ; bascule quand les conditions sont réunies (appareil qui
    /// réinitialise : chaque appareil connu réassocié ou oublié ; appareil réassocié : l'auteur a basculé). Chaque étape est idempotente
    /// et reprise au scan suivant.
    fn reset_pass(&self, inner: &mut Inner, self_id: &str) -> SyncResult<Option<ResetView>> {
        let Some(mut record) = self.reset_record(inner, self_id)? else { return Ok(None) };
        if record.switch_step > 0 {
            self.finish_switch(inner, &mut record)?;
            return Ok(Some(Self::view(&record, Vec::new(), true, true)));
        }
        if let Some(lost) = record.superseded.clone() {
            if !lost.done {
                self.supersede_steps(inner, &mut record)?;
            }
            // §18 point 16 : perdue face à une restauration, et l'époque restaurée est suivie (`own.json` y est) : registre clos (rien à
            // associer, K reste la clé) ; l'état « interrompue » reste affiché par le moteur jusqu'à « Fermer » ou une relance.
            if lost.restore && record.superseded.as_ref().is_some_and(|s| s.done) {
                let folder_id = self.require_folder(inner)?.folder_id.clone();
                let key = self.load_key(inner)?;
                let own = read_config_file::<OwnState>(&self.path(OWN_FILE)).ok().flatten().filter(|o| o.folder_id == folder_id && o.kid == key.kid());
                let reached = match (own.and_then(|o| o.epoch).as_deref().and_then(EpochId::parse), lost.epoch.as_deref().and_then(EpochId::parse)) {
                    (Some(own), Some(target)) => own >= target,
                    _ => false,
                };
                if reached {
                    remove_config_file(&self.path(RESET_FILE))?;
                    inner.next = None;
                    log::event("reset-superseded-followed", lost.epoch.as_deref().unwrap_or("none"));
                    return Ok(None);
                }
            }
            // §18 point 15 : gagnant oublié (son annonce, ou son époque restaurée, est sans effet) : registre clos ; les étapes déjà
            // faites ne sont pas défaites (`.next` effacée) et `sync_reset_key` redevient possible.
            if let Some(by) = lost.by.as_deref() {
                let key = self.load_key(inner)?;
                let entries = self.registry(inner, &key, self_id)?.entries;
                if forget_order(&entries).contains_key(by) {
                    remove_config_file(&self.path(RESET_FILE))?;
                    inner.next = None;
                    log::event("reset-superseded-void", by);
                    let mut view = Self::view(&record, Vec::new(), false, false);
                    view.closed = true;
                    return Ok(Some(view));
                }
            }
            return Ok(Some(Self::view(&record, Vec::new(), false, false)));
        }
        let key = self.load_key(inner)?;
        let Some(next) = self.read_vault_next()?.filter(|k| k.kid() == record.kid) else {
            // Nouvelle clé disparue du coffre : la réinitialisation ne peut plus aboutir ; perdue sans gagnant (« relancez-la »).
            log::event("reset-next-missing", &record.kid);
            record.superseded = Some(Superseded { epoch: None, by: None, done: false, restore: false });
            self.save_reset(&record)?;
            inner.next = None;
            self.supersede_steps(inner, &mut record)?;
            return Ok(Some(Self::view(&record, Vec::new(), false, false)));
        };
        let reg = self.registry(inner, &key, self_id)?;
        let order = forget_order(&reg.entries);
        let forgotten: BTreeSet<String> = order.keys().cloned().collect();
        let bound = inner.folder.as_ref().ok_or(SyncError::new(SyncCode::NotConfigured))?;
        let store = Store { fs: bound.fs.as_ref(), key: &key, pin: false, next: Some(NextKey { key: &next, epoch: &record.epoch }) };
        let Some(reads) = Self::read_all_states(&store, &mut inner.accepted)? else {
            log::event("reset-pass-deferred", "listing");
            return Ok(Some(Self::view(&record, Vec::new(), false, false)));
        };
        // Annonce de l'auteur (appareil réassocié) : lue sous l'ancienne clé si elle manque au registre.
        if record.role == ResetRole::Joined && record.notice.is_none() {
            let announced = store.read_state_file(&record.by, STATE_FILE, &key, &HashMap::new());
            if let Some(s) = announced.state.filter(|_| announced.status == StateStatus::Ok) {
                if s.reset.as_ref().is_some_and(|n| n.kid == record.kid && n.epoch == record.epoch) {
                    record.notice = s.reset.clone();
                    record.notice_epoch = Some(s.epoch.clone());
                    record.notice_seq = Some(s.state_seq);
                    self.save_reset(&record)?;
                }
            }
        }
        let mut candidates: Vec<ResetCandidate> = Vec::new();
        let mut opened: Vec<OpenedEpoch> = Vec::new();
        let mut author_switched = false;
        let mut author_withdrew = false;
        let mut author_seen = false;
        for (id, read) in &reads {
            if id == self_id || read.status != StateStatus::Ok {
                continue;
            }
            let Some(state) = &read.state else { continue };
            if read.kid.as_deref() == Some(record.kid.as_str()) {
                // État sous la nouvelle clé : un appareil de cette réinitialisation ; l'auteur, s'il est là, maintient l'annonce (ou a basculé).
                if *id == record.by {
                    author_seen = true;
                    author_switched |= !read.from_next_file && state.epoch == record.epoch;
                    candidates.extend(record.candidate());
                }
                continue;
            }
            if let Some(notice) = &state.reset {
                candidates.push(ResetCandidate { by: id.clone(), state_epoch: state.epoch.clone(), notice: notice.clone(), restore: false });
            }
            opened.push(OpenedEpoch { by: id.clone(), epoch: state.epoch.clone(), snapshot: state.snapshot.is_some(), notice: state.reset.is_some() });
            if *id == record.by {
                author_seen = true;
                // Revue 1 : retrait compté seulement si l'annonce a été vue et que l'état lu est strictement plus récent qu'elle.
                let newer_than_notice = record.notice.is_some() && record.notice_seq.is_some_and(|seq| state.state_seq > seq);
                // Seconde revue, point 3 : plus récent que l'état de l'auteur lu à l'import (stateSeq ou époque), même sans annonce lue.
                let newer_than_import = record.author_at_import.as_ref().is_some_and(|a| {
                    state.state_seq > a.state_seq || EpochId::parse(&state.epoch).zip(EpochId::parse(&a.epoch)).is_some_and(|(e, f)| e > f)
                });
                let newer = newer_than_notice || newer_than_import;
                author_withdrew |= newer && state.reset.as_ref().map(|n| n.kid.as_str()) != Some(record.kid.as_str());
            }
        }
        if record.role == ResetRole::Initiator || !author_seen {
            candidates.extend(record.candidate());
        }
        // §18 point 16 : les époques ouvertes sous l'ancienne clé (restaurations) concourent avec les annonces.
        let mut announced = candidates.clone();
        announced.extend(record.candidate());
        candidates.extend(restore_candidates(&opened, &announced));
        let winner = reset_winner(&candidates, &forgotten).cloned();
        let lost = !author_switched
            && match &winner {
                Some(w) => w.notice.epoch != record.epoch,
                None => record.role == ResetRole::Joined && (author_withdrew || forgotten.contains(&record.by)),
            };
        if lost {
            log::event("reset-superseded", winner.as_ref().map_or("none", |w| w.notice.epoch.as_str()));
            let restore = winner.as_ref().is_some_and(|w| w.restore);
            record.superseded = Some(Superseded { epoch: winner.as_ref().map(|w| w.notice.epoch.clone()), by: winner.map(|w| w.by), done: false, restore });
            self.save_reset(&record)?;
            inner.next = None;
            self.supersede_steps(inner, &mut record)?;
            return Ok(Some(Self::view(&record, Vec::new(), false, false)));
        }
        // Bascule ?
        let own = reads.get(self_id).filter(|r| r.status == StateStatus::Ok && r.from_next_file && r.kid.as_deref() == Some(record.kid.as_str()));
        let own_ready = own.and_then(|r| r.state.as_ref()).is_some_and(|s| s.epoch == record.epoch && (record.role == ResetRole::Joined || s.snapshot.is_some()));
        let (ids, seen, authors) = Self::known_ids(&reads, &reg);
        let known: Vec<ResetKnown> = ids
            .iter()
            .map(|id| {
                let read = reads.get(id);
                ResetKnown {
                    device_id: id.clone(),
                    status: read.map_or(StateStatus::Missing, |r| r.status),
                    epoch: read.filter(|r| r.status == StateStatus::Ok).and_then(|r| r.state.as_ref()).map(|s| s.epoch.clone()),
                    kid: read.and_then(|r| r.kid.clone()),
                    seen: seen.contains(id),
                    author: authors.contains(id),
                }
            })
            .collect();
        let mut waiting = if record.role == ResetRole::Initiator { reset_waiting(&known, self_id, &record.epoch, &record.kid, &forgotten) } else { Vec::new() };
        // §18 point 14 : l'instantané annoncé sous la nouvelle clé doit couvrir chaque oublié retenu (coupure sur les états des deux clés).
        if record.role == ResetRole::Initiator && own_ready && record.stage == ResetStage::Opened && waiting.is_empty() && !order.is_empty() {
            let own_state = own.and_then(|r| r.state.clone());
            for id in self.uncovered_forgotten(inner, &key, &next, &record, &reads, own_state.as_ref(), &reg.entries) {
                if !waiting.contains(&id) {
                    waiting.push(id);
                }
            }
            waiting.sort();
        }
        let ready = own_ready
            && match record.role {
                ResetRole::Initiator => record.stage == ResetStage::Opened && waiting.is_empty(),
                ResetRole::Joined => author_switched,
            };
        if !ready {
            return Ok(Some(Self::view(&record, waiting, false, false)));
        }
        log::event("reset-switch", &record.epoch);
        self.finish_switch(inner, &mut record)?;
        Ok(Some(Self::view(&record, Vec::new(), true, false)))
    }

    /// Oubliés retenus que l'instantané annoncé dans son `state.next.ctx` ne couvre pas (§18 point 14) : coupure calculée sur les
    /// accusés de chaque actif non oublié, lus dans son `state.ctx` sous l'ancienne clé et dans son état sous la nouvelle ; fin
    /// d'instantané lue sous la nouvelle clé (même lecture que `tail`). Fin illisible : chaque oublié retenu de coupure non nulle.
    #[allow(clippy::too_many_arguments)]
    fn uncovered_forgotten(
        &self,
        inner: &mut Inner,
        key: &MasterKey,
        next: &MasterKey,
        record: &ResetRecord,
        reads: &BTreeMap<String, StateRead>,
        own_state: Option<&PublishedState>,
        entries: &[ForgottenDevice],
    ) -> Vec<String> {
        let Inner { folder, accepted, snapshot_ends, k_accepted, k_acks, .. } = &mut *inner;
        let Some(bound) = folder.as_ref() else { return Vec::new() };
        let store = Store { fs: bound.fs.as_ref(), key, pin: false, next: Some(NextKey { key: next, epoch: &record.epoch }) };
        let mut acks: Vec<(String, BTreeMap<String, DeviceAck>)> = Vec::new();
        // Époque la plus récente où chaque appareil a publié un état (seconde revue, bloquant) : un accusé dans une époque postérieure
        // (« début de l'époque visée » sur un appareil qui n'y a rien publié) ne désigne rien et ne compte pas dans la coupure.
        let mut published: BTreeMap<String, EpochId> = BTreeMap::new();
        let mut note = |id: &str, state: &PublishedState| {
            if let Some(e) = EpochId::parse(&state.epoch) {
                if published.get(id).map_or(true, |p| e > *p) {
                    published.insert(id.to_owned(), e);
                }
            }
        };
        for (id, read) in reads {
            if let Some(state) = read.state.as_ref().filter(|_| read.status == StateStatus::Ok) {
                note(id, state);
                acks.push((id.clone(), state.acks.clone()));
            }
            if read.from_next_file || read.kid.as_deref() != Some(key.kid()) {
                let old = store.read_state_file(id, STATE_FILE, key, k_accepted);
                match (old.status, old.state, old.digest) {
                    (StateStatus::Ok, Some(state), Some(digest)) => {
                        note(id, &state);
                        if let Some(epoch) = EpochId::parse(&state.epoch) {
                            let head = RecordCursor { segment: state.head.segment, record: state.head.record };
                            k_accepted.insert(id.clone(), Accepted { epoch, seq: state.state_seq, digest, head });
                        }
                        k_acks.insert(id.clone(), state.acks.clone());
                        acks.push((id.clone(), state.acks));
                    }
                    // Rejeu, illisible ou absent : les derniers accusés acceptés comptent toujours.
                    _ => {
                        if let Some(kept) = k_acks.get(id) {
                            acks.push((id.clone(), kept.clone()));
                        }
                    }
                }
            }
        }
        without_stale_acks(&mut acks, &published);
        let ackers = || acks.iter().map(|(id, a)| (id.as_str(), a));
        let order = forget_order(entries);
        let end = Self::own_snapshot_end(&store, &record.device_id, own_state, Some(&record.epoch), accepted, snapshot_ends);
        match end {
            SnapshotEndRead::End(end) => covers_forgotten(&end.covers, entries, ackers()).into_iter().collect(),
            _ => order.keys().filter(|target| super::forget::cutoff(target, ackers().filter(|(id, _)| !order.contains_key(*id))).is_some()).cloned().collect(),
        }
    }

    fn view(record: &ResetRecord, waiting: Vec<String>, switched: bool, resumed: bool) -> ResetView {
        ResetView {
            role: record.role.as_str(),
            kid: record.kid.clone(),
            epoch: record.epoch.clone(),
            by: record.by.clone(),
            notice: if record.role == ResetRole::Initiator && record.active() { record.notice.clone() } else { None },
            stage: record.stage.as_str(),
            notice_epoch: record.notice_epoch.clone(),
            closed: false,
            superseded: record.superseded.as_ref().map(|s| SupersededView { epoch: s.epoch.clone(), by: s.by.clone(), restore: s.restore }),
            switching: record.switch_step > 0 && !switched,
            switched,
            resumed,
            waiting,
        }
    }

    /// Bascule (§14.3 étape 5) : (1) `state.ctx` ← état sous la nouvelle clé, (2) `state.next.ctx` supprimé, (3) ses fichiers des
    /// époques antérieures (ancienne clé) supprimés, (4) nouvelle clé écrite sous `.v1` (l'ancienne est remplacée : jamais d'instant sans
    /// clé valide), `own.json` et budget de nonces passés à la nouvelle clé, (5) entrée `.next` effacée, (6) registre supprimé. Chaque
    /// étape est mémorisée dans le registre ; reprise au scan suivant après un arrêt.
    fn finish_switch(&self, inner: &mut Inner, record: &mut ResetRecord) -> SyncResult<()> {
        let self_id = record.device_id.clone();
        if record.switch_step < 1 {
            self.interrupt("switch-1")?;
            let next = self.read_vault_next()?.filter(|k| k.kid() == record.kid).ok_or(SyncError::new(SyncCode::VaultUnavailable))?;
            let bound = self.require_folder(inner)?;
            let bytes = match bound.fs.read(&[DEVICES_DIR, &self_id, STATE_NEXT_FILE], MAX_STATE_FILE_BYTES, true) {
                Ok(bytes) => bytes,
                Err(error) => return Err(SyncError::new(error.code())),
            };
            // L'état copié doit se déchiffrer avec la nouvelle clé (sinon rien n'est remplacé).
            let probe = Store::new(bound.fs.as_ref(), &next, false);
            if probe.read_state_file(&self_id, STATE_NEXT_FILE, &next, &HashMap::new()).status != StateStatus::Ok {
                return fail(SyncCode::StateMismatch);
            }
            bound.fs.write_atomic(&[DEVICES_DIR, &self_id, STATE_FILE], &bytes).map_err(|e| SyncError::new(e.code()))?;
            record.switch_step = 1;
            self.save_reset(record)?;
        }
        // Audit 3 et audit bas de la seconde revue : avant d'effacer quoi que ce soit (étapes 2 à 5, dès la suppression de
        // `state.next.ctx`), son `state.ctx` doit se déchiffrer avec la nouvelle clé dans l'époque visée ; sinon la bascule s'arrête
        // (`state-mismatch`), l'ancienne clé et `state.next.ctx` restent.
        if record.switch_step < 5 {
            let next = match self.read_vault_next()?.filter(|k| k.kid() == record.kid) {
                Some(next) => next,
                None => self.read_vault_key()?.filter(|k| k.kid() == record.kid).ok_or(SyncError::new(SyncCode::VaultUnavailable))?,
            };
            let bound = self.require_folder(inner)?;
            let probe = Store::new(bound.fs.as_ref(), &next, false).read_state_file(&self_id, STATE_FILE, &next, &HashMap::new());
            if probe.status != StateStatus::Ok || probe.state.as_ref().map_or(true, |s| s.epoch != record.epoch) {
                log::event("reset-switch-refused", probe.status.as_str());
                return fail(SyncCode::StateMismatch);
            }
        }
        if record.switch_step < 2 {
            self.interrupt("switch-2")?;
            let bound = self.require_folder(inner)?;
            bound.fs.remove_file(&[DEVICES_DIR, &self_id, STATE_NEXT_FILE]).map_err(|e| SyncError::new(e.code()))?;
            record.switch_step = 2;
            self.save_reset(record)?;
        }
        if record.switch_step < 3 {
            self.interrupt("switch-3")?;
            let target = EpochId::parse(&record.epoch).ok_or(SyncError::new(SyncCode::Io))?;
            let bound = self.require_folder(inner)?;
            let listing = match bound.fs.list(&[DEVICES_DIR, &self_id], MAX_SCAN_ENTRIES_PER_FOLDER) {
                Ok(listing) => listing.entries,
                Err(super::files::FsError::NotFound) => Vec::new(),
                Err(error) => return Err(SyncError::new(error.code())),
            };
            for dir in listing.iter().filter(|e| e.is_dir) {
                let Some(epoch) = EpochId::parse(&dir.name) else { continue };
                if epoch >= target {
                    continue;
                }
                let files = bound.fs.list(&[DEVICES_DIR, &self_id, &dir.name], MAX_SCAN_ENTRIES_PER_FOLDER).map_err(|e| SyncError::new(e.code()))?;
                for file in files.entries.iter().filter(|f| !f.is_dir && matches!(parse_file_name(&f.name), Some(SyncFileName::Segment(_) | SyncFileName::Snapshot(_)))) {
                    bound.fs.remove_file(&[DEVICES_DIR, &self_id, &dir.name, &file.name]).map_err(|e| SyncError::new(e.code()))?;
                }
                bound.fs.remove_empty_dir(&[DEVICES_DIR, &self_id, &dir.name]).map_err(|e| SyncError::new(e.code()))?;
            }
            record.switch_step = 3;
            self.save_reset(record)?;
        }
        if record.switch_step < 4 {
            self.interrupt("switch-4")?;
            // La nouvelle clé remplace l'ancienne sous `.v1` (jamais d'instant sans clé valide : `.next` reste jusqu'à l'étape 5).
            let next = match self.read_vault_next()?.filter(|k| k.kid() == record.kid) {
                Some(next) => next,
                None => self.read_vault_key()?.filter(|k| k.kid() == record.kid).ok_or(SyncError::new(SyncCode::VaultUnavailable))?,
            };
            self.vault.set(SYNC_KEY_ACCOUNT, &next.to_vault_value()).map_err(vault_error)?;
            let folder_id = self.require_folder(inner)?.folder_id.clone();
            if let Ok(Some(mut own)) = read_config_file::<OwnState>(&self.path(OWN_FILE)) {
                if own.folder_id == folder_id && own.kid != record.kid {
                    own.kid = record.kid.clone();
                    self.save_own(inner, own)?;
                }
            }
            let usage = self.usage_next(&record.kid);
            write_config_file(&self.path(USAGE_FILE), &serde_json::to_vec(&usage).unwrap_or_default())?;
            remove_config_file(&self.path(USAGE_NEXT_FILE))?;
            inner.usage = Some(usage);
            inner.key = Some(Arc::new(next));
            inner.own = None;
            record.switch_step = 4;
            self.save_reset(record)?;
        }
        if record.switch_step < 5 {
            self.interrupt("switch-5")?;
            if self.vault.contains(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)? {
                self.vault.delete(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?;
            }
            record.switch_step = 5;
            self.save_reset(record)?;
        }
        self.interrupt("switch-6")?;
        remove_config_file(&self.path(RESET_FILE))?;
        record.switch_step = 6;
        inner.next = None;
        inner.snapshot_cache = None;
        inner.snapshot_ends.clear();
        log::event("reset-switched", &record.kid);
        Ok(())
    }

    /// Étapes du perdant (§18 point 2), chacune idempotente : (1) registre marqué `superseded` (fait par l'appelant), (2) son
    /// `state.next.ctx` supprimé, (3) entrée `.next` effacée (`nextKid` devient nul), (4) `own.json` ramené à la position de l'époque `n`
    /// (`stateSeq` garde son maximum). L'ancienne clé reste sous `.v1` pendant toute la perte.
    fn supersede_steps(&self, inner: &mut Inner, record: &mut ResetRecord) -> SyncResult<()> {
        let self_id = record.device_id.clone();
        self.interrupt("supersede-2")?;
        let bound = self.require_folder(inner)?;
        bound.fs.remove_file(&[DEVICES_DIR, &self_id, STATE_NEXT_FILE]).map_err(|e| SyncError::new(e.code()))?;
        self.own_state_back(inner, record)?;
        self.interrupt("supersede-3")?;
        if self.read_vault_next()?.is_some_and(|k| k.kid() == record.kid) {
            self.vault.delete(SYNC_NEXT_KEY_ACCOUNT).map_err(vault_error)?;
        }
        remove_config_file(&self.path(USAGE_NEXT_FILE))?;
        inner.next = None;
        self.interrupt("supersede-4")?;
        if let Some(base) = record.base.clone() {
            let key = self.load_key(inner)?;
            let folder_id = self.require_folder(inner)?.folder_id.clone();
            if let Ok(Some(mut own)) = read_config_file::<OwnState>(&self.path(OWN_FILE)) {
                if own.folder_id == folder_id && own.kid == key.kid() && own.epoch != base.epoch {
                    own.epoch = base.epoch.clone();
                    own.segment = base.segment;
                    own.record = base.record;
                    own.max_hlc = base.max_hlc.clone();
                    self.save_own(inner, own)?;
                }
            }
        }
        inner.own = None;
        if let Some(lost) = record.superseded.as_mut() {
            lost.done = true;
        }
        self.save_reset(record)?;
        log::event("reset-superseded-done", &record.kid);
        Ok(())
    }

    /// Perte (§18 point 2) : son état publié redevient celui de l'ancienne clé (`state.ctx`, plus ancien que ses états sous la nouvelle
    /// clé). L'anti-rejeu de **cet appareil seul** revient à cet état, à condition qu'il soit bien le sien : déchiffré avec la clé locale,
    /// et portant l'annonce de cette réinitialisation (appareil qui réinitialise) ou figé dans l'époque de l'import (appareil réassocié).
    /// Sans cela, son propre état serait vu comme un rejeu et il ne pourrait ni republier sans annonce, ni se réassocier.
    fn own_state_back(&self, inner: &mut Inner, record: &ResetRecord) -> SyncResult<()> {
        let key = self.load_key(inner)?;
        let self_id = record.device_id.clone();
        let read = {
            let bound = self.require_folder(inner)?;
            Store::new(bound.fs.as_ref(), &key, false).read_state_file(&self_id, STATE_FILE, &key, &HashMap::new())
        };
        let (Some(state), Some(digest)) = (read.state.filter(|_| read.status == StateStatus::Ok), read.digest) else { return Ok(()) };
        // Audit 5 : seule exception à l'anti-rejeu, le dernier état écrit sous l'ancienne clé (même `stateSeq`, même empreinte), base
        // exigée ; un état plus ancien rejoué reste un rejeu.
        let ours = record.base.is_some() && record.k_state.as_ref().is_some_and(|k| k.state_seq == state.state_seq && k.digest == digest);
        if !ours {
            log::event("reset-own-state-not-back", &state.state_seq.to_string());
        }
        let Some(epoch) = EpochId::parse(&state.epoch).filter(|_| ours) else { return Ok(()) };
        let head = RecordCursor { segment: state.head.segment, record: state.head.record };
        inner.accepted.insert(self_id.clone(), Accepted { epoch, seq: state.state_seq, digest: digest.clone(), head });
        let mut reg = self.registry(inner, &key, &self_id)?;
        reg.accepted.insert(self_id.clone(), AcceptedRecord { epoch: state.epoch.clone(), state_seq: state.state_seq, digest });
        self.save_registry(&reg)?;
        log::event("reset-own-state-back", &state.state_seq.to_string());
        Ok(())
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

/// Y-11 : issue des contrôles de `sync_reset_key`.
enum ResetPlan {
    /// Réinitialisation déjà lancée ici : reprise avec la même `K2`.
    Resume(String),
    Create(CreatePlan),
}

struct CreatePlan {
    folder_id: String,
    self_id: String,
    epoch: String,
    at: String,
    notice_epoch: String,
}

/// Y-11 : import d'une nouvelle clé par un appareil déjà associé.
enum JoinPlan {
    /// Cette clé est déjà la nouvelle clé (`.next`) : sans effet.
    Already,
    Join(Box<ResetRecord>),
}

/// Millisecondes d'un hlc strict (`<15 chiffres>-…`).
fn hlc_ms(hlc: &str) -> Option<u64> {
    hlc.get(..15).and_then(|ms| ms.parse().ok())
}

/// Instant ISO 8601 UTC à la milliseconde.
fn iso_ms(ms: u64) -> String {
    let seconds = crate::backup::iso_instant(ms / 1000);
    format!("{}.{:03}Z", &seconds[..seconds.len() - 5], ms % 1000)
}
