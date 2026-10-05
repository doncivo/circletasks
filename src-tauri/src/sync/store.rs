//! Journaux, état publié et instantanés dans le dossier lié (ADR 0011, sections 1.1 à 1.6, 9 et 11.1 ; Y-01 critères 11 à 15).
//!
//! Même comportement que l'implémentation mémoire `src/platform/sync/memory.ts` (mêmes codes d'erreur, mêmes cas limites), avec le
//! vrai format sur disque : en-tête en clair, lignes chiffrées, bornes contrôlées avant toute allocation ou hydratation. Rust ne
//! lit jamais le texte clair qu'il chiffre, sauf `state.ctx` (contrôle de l'état publié) ; aucune règle de fusion ici.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde::Serialize;

use super::crypto::{parse_line_prefix, sha256_hex, FileHeader, HeaderKind, MasterKey, Place, SYNC_FORMAT_MAJOR};
use super::files::{AppendMode, Availability, FsEntry, FsError, Listing, SyncFs};
use super::limits::{
    encrypted_line_bytes, FOLDER_STOP_BYTES, FOLDER_WARN_BYTES, MAX_APPEND_CALL_BYTES, MAX_DEVICE_FOLDERS, MAX_EPOCHS_PER_DEVICE, MAX_SCAN_ENTRIES_TOTAL, MAX_STATE_CANDIDATES, MAX_HEADER_BYTES, MAX_IPC_PAGE_BYTES,
    MAX_RECORD_PLAINTEXT_BYTES, MAX_SCAN_ENTRIES_PER_FOLDER, MAX_SEGMENT_BYTES, MAX_SNAPSHOT_BYTES, MAX_STATE_ACKS, MAX_STATE_FILE_BYTES,
    MAX_STATE_FORGOTTEN, SEGMENT_ROTATE_BYTES,
};
use super::names::{
    is_epoch_id, is_file_number, is_strict_hlc, is_uuid_v4, parse_file_name, segment_name, snapshot_name, EpochId, SyncFileName, DEVICES_DIR,
    STATE_FILE, TEMP_SUFFIX,
};
use super::state::{OwnState, PublishedState, Usage};
use super::{fail, log, SyncCode, SyncError, SyncResult};

/// Plus grand `sv` accepté (6 chiffres, comme le préfixe de ligne).
pub const MAX_SV: u64 = 999_999;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

// ------------------------------------------------------------------------------------------------------------------------------
// Fichiers analysés
// ------------------------------------------------------------------------------------------------------------------------------

/// Fichier du dossier : en-tête, lignes complètes, dernière ligne incomplète éventuelle (iCloud en cours de transfert).
pub struct ParsedFile<'a> {
    pub header: FileHeader,
    pub lines: Vec<&'a [u8]>,
    pub partial_tail: bool,
}

/// Échec d'analyse d'un fichier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// En-tête sans `\n` dans un fichier de moins de 1 Kio : en transfert.
    Partial,
    /// En-tête invalide ou de plus de 1 Kio.
    BadHeader,
}

/// En-tête lu octet par octet jusqu'au premier `\n` (1 Kio au plus), puis lignes terminées par `\n`.
pub fn parse_file(bytes: &[u8]) -> Result<ParsedFile<'_>, ParseError> {
    let window = &bytes[..bytes.len().min(MAX_HEADER_BYTES + 1)];
    let Some(end) = window.iter().position(|&b| b == b'\n') else {
        return Err(if bytes.len() <= MAX_HEADER_BYTES { ParseError::Partial } else { ParseError::BadHeader });
    };
    let header = FileHeader::parse(&bytes[..end]).ok_or(ParseError::BadHeader)?;
    let mut lines = Vec::new();
    let mut rest = &bytes[end + 1..];
    while let Some(pos) = rest.iter().position(|&b| b == b'\n') {
        lines.push(&rest[..pos]);
        rest = &rest[pos + 1..];
    }
    Ok(ParsedFile { header, lines, partial_tail: !rest.is_empty() })
}

fn line_str(line: &[u8]) -> Option<&str> {
    std::str::from_utf8(line).ok()
}

// ------------------------------------------------------------------------------------------------------------------------------
// Types échangés (forme IPC, `src/platform/sync/types.ts`)
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
pub struct RecordCursor {
    pub segment: u64,
    pub record: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateStatus {
    Ok,
    Missing,
    CloudPending,
    Foreign,
    Corrupt,
    Rollback,
    TooLarge,
    NewerFormat,
}

impl StateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StateStatus::Ok => "ok",
            StateStatus::Missing => "missing",
            StateStatus::CloudPending => "cloud-pending",
            StateStatus::Foreign => "foreign",
            StateStatus::Corrupt => "corrupt",
            StateStatus::Rollback => "rollback",
            StateStatus::TooLarge => "too-large",
            StateStatus::NewerFormat => "newer-format",
        }
    }

    /// Erreur d'une lecture qui exige un état authentifié (`memory.ts`, `errorOfStatus`).
    fn error(self) -> Option<SyncCode> {
        match self {
            StateStatus::Ok | StateStatus::Missing | StateStatus::CloudPending => None,
            StateStatus::Foreign => Some(SyncCode::KeyMismatch),
            StateStatus::Corrupt => Some(SyncCode::DecryptFailed),
            StateStatus::Rollback => Some(SyncCode::Rollback),
            StateStatus::TooLarge => Some(SyncCode::TooLarge),
            StateStatus::NewerFormat => Some(SyncCode::NewerFormat),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpochListing {
    pub epoch: String,
    pub segments: Vec<u32>,
    pub snapshots: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingFile {
    pub file: String,
    pub availability: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceScan {
    pub device_id: String,
    pub kid: Option<String>,
    pub state: Option<PublishedState>,
    pub state_status: &'static str,
    pub epochs: Vec<EpochListing>,
    pub pending: Vec<PendingFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub devices: Vec<DeviceScan>,
    pub ignored: u64,
    pub total_bytes: u64,
    pub too_many_devices: bool,
    pub incomplete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadPage {
    pub records: Vec<String>,
    pub next: RecordCursor,
    pub status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendResult {
    pub first_record: u64,
    pub head: RecordCursor,
}

/// Fichier à supprimer (`sync_delete_own`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnFileRef {
    pub epoch: String,
    pub kind: String,
    #[serde(default)]
    pub n: Option<u64>,
}

/// Dernier état accepté d'un appareil (anti-rejeu, section 1.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    pub epoch: EpochId,
    pub seq: u64,
    pub digest: String,
    pub head: RecordCursor,
}

/// Époque qui recule ; `stateSeq` qui recule (toutes époques confondues) ; même `stateSeq` et autre contenu ; tête qui recule à
/// époque égale.
pub fn is_rollback(previous: &Accepted, current: &Accepted) -> bool {
    if current.epoch < previous.epoch || current.seq < previous.seq {
        return true;
    }
    if current.seq == previous.seq {
        return current.digest != previous.digest;
    }
    current.epoch == previous.epoch && current.head < previous.head
}

/// Lecture d'un `state.ctx`.
pub struct StateRead {
    pub kid: Option<String>,
    pub state: Option<PublishedState>,
    pub digest: Option<String>,
    pub status: StateStatus,
}

impl StateRead {
    fn status(kid: Option<String>, status: StateStatus) -> Self {
        Self { kid, state: None, digest: None, status }
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Listes
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct EpochFiles {
    segments: BTreeMap<u32, FsEntry>,
    snapshots: BTreeMap<u32, FsEntry>,
}

#[derive(Default)]
struct DeviceListing {
    state: Option<FsEntry>,
    /// Dossiers d'époque présents (noms stricts), listés ou non.
    epoch_names: BTreeSet<EpochId>,
    /// Fichiers des époques listées (appareils retenus seulement, audit S2).
    epochs: BTreeMap<EpochId, EpochFiles>,
    ignored: u64,
    bytes: u64,
}

fn fs_error(error: FsError) -> SyncError {
    SyncError::new(error.code())
}

/// Budget d'entrées listées pour une opération (audit S2) : 10 000 par dossier, 50 000 en tout ; au-delà, liste coupée et
/// `incomplete`.
struct Budget {
    left: Cell<usize>,
    cut: Cell<bool>,
}

impl Budget {
    fn new() -> Self {
        Self { left: Cell::new(MAX_SCAN_ENTRIES_TOTAL), cut: Cell::new(false) }
    }

    fn list(&self, fs: &dyn SyncFs, dir: &[&str]) -> Result<Listing, FsError> {
        let left = self.left.get();
        if left == 0 {
            self.cut.set(true);
            return Ok(Listing::default());
        }
        let listing = fs.list(dir, left.min(MAX_SCAN_ENTRIES_PER_FOLDER))?;
        self.left.set(left - listing.entries.len());
        if listing.truncated {
            self.cut.set(true);
        }
        Ok(listing)
    }
}

/// Contexte d'accès : dossier lié et clé locale. `pin` : épingler les fichiers annoncés (dossier iCloud).
pub struct Store<'a> {
    pub fs: &'a dyn SyncFs,
    pub key: &'a MasterKey,
    pub pin: bool,
}

fn device_dir(dev: &str) -> [&str; 2] {
    [DEVICES_DIR, dev]
}

impl Store<'_> {
    /// Premier niveau d'un dossier d'appareil : `state.ctx` et noms des dossiers d'époque (sans les lister).
    fn list_device_top(&self, dev: &str, budget: &Budget) -> Result<DeviceListing, FsError> {
        let mut out = DeviceListing::default();
        let listing = match budget.list(self.fs, &device_dir(dev)) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => return Ok(out),
            Err(error) => return Err(error),
        };
        for entry in listing.entries {
            if !entry.is_dir && entry.name == STATE_FILE {
                out.bytes += entry.size;
                out.state = Some(entry);
                continue;
            }
            match if entry.is_dir && entry.availability != Availability::Error { EpochId::parse(&entry.name) } else { None } {
                Some(epoch) => {
                    out.epoch_names.insert(epoch);
                }
                None => {
                    out.bytes += entry.size;
                    out.ignored += 1;
                    log::event("ignored-entry", dev);
                }
            }
        }
        Ok(out)
    }

    /// Liste les dossiers d'époque d'un appareil retenu : les 64 plus récents au plus (audit S2), budget commun.
    fn list_epochs(&self, dev: &str, listing: &mut DeviceListing, budget: &Budget) -> Result<(), FsError> {
        if listing.epoch_names.len() > MAX_EPOCHS_PER_DEVICE {
            budget.cut.set(true);
        }
        let names: Vec<EpochId> = listing.epoch_names.iter().rev().take(MAX_EPOCHS_PER_DEVICE).cloned().collect();
        for epoch in names {
            let name = epoch.name();
            let files = match budget.list(self.fs, &[DEVICES_DIR, dev, &name]) {
                Ok(files) => files,
                Err(FsError::NotFound) => continue,
                Err(error) => return Err(error),
            };
            let mut epoch_files = EpochFiles::default();
            for file in files.entries {
                listing.bytes += file.size;
                match (file.is_dir, parse_file_name(&file.name)) {
                    (false, Some(SyncFileName::Segment(n))) => {
                        epoch_files.segments.insert(n, file);
                    }
                    (false, Some(SyncFileName::Snapshot(n))) => {
                        epoch_files.snapshots.insert(n, file);
                    }
                    _ => {
                        listing.ignored += 1;
                        log::event("ignored-entry", &name);
                    }
                }
            }
            listing.epochs.insert(epoch, epoch_files);
        }
        Ok(())
    }

    /// `kid` d'un appareil dont l'état manque ou reste dans le nuage : en-tête du premier segment, sinon du premier instantané, présent
    /// sur le disque et de taille raisonnable (même règle que `memory.ts`, revue 16).
    fn any_kid(&self, dev: &str, listing: &DeviceListing) -> Option<String> {
        for (epoch, files) in &listing.epochs {
            let name = epoch.name();
            let candidates = files.segments.iter().map(|(n, e)| (segment_name(*n), e)).chain(files.snapshots.iter().map(|(n, e)| (snapshot_name(*n), e)));
            for (file, entry) in candidates {
                if entry.availability != Availability::Local || entry.size > MAX_SEGMENT_BYTES {
                    continue;
                }
                let Ok(bytes) = self.fs.read(&[DEVICES_DIR, dev, &name, &file], MAX_SEGMENT_BYTES, false) else { continue };
                if let Ok(parsed) = parse_file(&bytes) {
                    return Some(parsed.header.kid);
                }
            }
        }
        None
    }

    /// Dernier segment authentifié d'une époque de `dev` parmi `segments` (plus grand numéro d'abord) : en-tête qui correspond au
    /// chemin, à notre `kid`, et dernière ligne complète déchiffrée à sa place (audit S7). Un fichier déposé (`j-99999999.ctj`, en-tête
    /// illisible ou d'une autre clé) est ignoré. Rend (numéro, nombre d'enregistrements). 16 essais au plus.
    fn authenticated_tail(&self, dev: &str, epoch: &str, segments: impl Iterator<Item = u32>) -> Option<(u32, u64)> {
        for n in segments.take(16) {
            let Ok(bytes) = self.fs.read(&[DEVICES_DIR, dev, epoch, &segment_name(n)], MAX_SEGMENT_BYTES, false) else { continue };
            let Ok(file) = parse_file(&bytes) else { continue };
            let h = &file.header;
            if h.kind() != Some(HeaderKind::Journal) || h.dev != dev || h.e != epoch || h.n != u64::from(n) || h.kid != self.key.kid() {
                continue;
            }
            let Some(last) = file.lines.last().and_then(|l| line_str(l)) else { continue };
            let index = file.lines.len() as u64 - 1;
            if self.key.open(&Place::Journal { dev, epoch, segment: n, index }, last).is_ok() {
                return Some((n, file.lines.len() as u64));
            }
        }
        None
    }

    /// Lecture d'un `state.ctx` : bornes, en-tête, clé, majeure, ligne unique, déchiffrement, analyse stricte, anti-rejeu.
    pub fn read_state(&self, dev: &str, accepted: &HashMap<String, Accepted>) -> StateRead {
        let path = [DEVICES_DIR, dev, STATE_FILE];
        let bytes = match self.fs.read(&path, MAX_STATE_FILE_BYTES, true) {
            Ok(bytes) => bytes,
            Err(FsError::NotFound) => return StateRead::status(None, StateStatus::Missing),
            Err(FsError::CloudPending | FsError::ProviderStopped | FsError::CloudError) => return StateRead::status(None, StateStatus::CloudPending),
            Err(FsError::TooLarge) => return StateRead::status(None, StateStatus::TooLarge),
            Err(_) => return StateRead::status(None, StateStatus::Corrupt),
        };
        let file = match parse_file(&bytes) {
            Ok(file) => file,
            Err(ParseError::Partial) => return StateRead::status(None, StateStatus::CloudPending),
            Err(ParseError::BadHeader) => return StateRead::status(None, StateStatus::Foreign),
        };
        let h = &file.header;
        let kid = Some(h.kid.clone());
        if h.kind() != Some(HeaderKind::State) || h.dev != dev || h.kid != self.key.kid() {
            return StateRead::status(kid, StateStatus::Foreign);
        }
        if h.sm > SYNC_FORMAT_MAJOR {
            return StateRead::status(kid, StateStatus::NewerFormat);
        }
        // Ligne incomplète : iCloud livre encore le fichier, il sera relu au cycle suivant (section 1.2).
        if file.partial_tail {
            return StateRead::status(kid, StateStatus::CloudPending);
        }
        let [line] = file.lines.as_slice() else { return StateRead::status(kid, StateStatus::Corrupt) };
        let Some(line) = line_str(line) else { return StateRead::status(kid, StateStatus::Corrupt) };
        let place = Place::State { dev, epoch: &h.e, state_seq: h.n };
        let Ok(opened) = self.key.open(&place, line) else { return StateRead::status(kid, StateStatus::Corrupt) };
        let Some(state) = PublishedState::parse(&opened.json) else { return StateRead::status(kid, StateStatus::Corrupt) };
        if state.device_id != dev || state.epoch != h.e || state.state_seq != h.n || state.sm != u64::from(opened.sm) || state.sv != u64::from(opened.sv) {
            return StateRead::status(kid, StateStatus::Corrupt);
        }
        let digest = sha256_hex(opened.json.as_bytes());
        let Some(epoch) = EpochId::parse(&state.epoch) else { return StateRead::status(kid, StateStatus::Corrupt) };
        let current = Accepted { epoch, seq: state.state_seq, digest: digest.clone(), head: RecordCursor { segment: state.head.segment, record: state.head.record } };
        if accepted.get(dev).is_some_and(|previous| is_rollback(previous, &current)) {
            return StateRead::status(kid, StateStatus::Rollback);
        }
        StateRead { kid, state: Some(state), digest: Some(digest), status: StateStatus::Ok }
    }

    /// Retient l'état lu comme accepté.
    fn remember(dev: &str, read: &StateRead, accepted: &mut HashMap<String, Accepted>) {
        if let (Some(state), Some(digest)) = (&read.state, &read.digest) {
            if let Some(epoch) = EpochId::parse(&state.epoch) {
                accepted.insert(dev.to_owned(), Accepted { epoch, seq: state.state_seq, digest: digest.clone(), head: RecordCursor { segment: state.head.segment, record: state.head.record } });
            }
        }
    }

    /// Tête authentifiée d'un appareil pour une lecture ; `None` : rien de lisible pour l'instant.
    fn authenticated_state(&self, dev: &str, accepted: &mut HashMap<String, Accepted>) -> SyncResult<Option<PublishedState>> {
        let read = self.read_state(dev, accepted);
        if let Some(code) = read.status.error() {
            return fail(code);
        }
        Self::remember(dev, &read, accepted);
        Ok(read.state)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Scan
    // --------------------------------------------------------------------------------------------------------------------------

    /// `sync_scan({ keep })` : appareils, états (anti-rejeu), fichiers listés, fichiers en attente, plafonds.
    pub fn scan(&self, self_id: Option<&str>, keep: &[String], accepted: &mut HashMap<String, Accepted>) -> SyncResult<FolderScan> {
        self.fs.revalidate().map_err(fs_error)?;
        let budget = Budget::new();
        let root = match budget.list(self.fs, &[DEVICES_DIR]) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => Default::default(),
            Err(error) => return Err(fs_error(error)),
        };
        let mut ignored = 0u64;
        let mut total = 0u64;
        // 1. Premier niveau de chaque dossier d'appareil (budget commun de 50 000 entrées).
        let mut listings: BTreeMap<String, DeviceListing> = BTreeMap::new();
        for entry in root.entries {
            if !entry.is_dir || entry.availability == Availability::Error || !is_uuid_v4(&entry.name) {
                ignored += 1;
                total += entry.size;
                log::event("ignored-entry", "devices");
                continue;
            }
            let listing = self.list_device_top(&entry.name, &budget).map_err(fs_error)?;
            total += listing.bytes;
            ignored += listing.ignored;
            listings.insert(entry.name, listing);
        }
        // Taille connue avant toute hydratation : plus aucune au-delà de 4 Gio.
        Self::check_total(total)?;
        // 2. Choix des dossiers retenus (16 ; soi et `keep` jamais écartés). L'état n'est lu que pour les appareils protégés et pour
        //    64 candidats au plus qui ont un `state.ctx` (audit S2) ; les autres comptent comme « sans état valide ».
        let protected: BTreeSet<&str> = keep.iter().map(String::as_str).chain(self_id).collect();
        let mut reads: BTreeMap<String, StateRead> = BTreeMap::new();
        for (dev, listing) in &listings {
            if protected.contains(dev.as_str()) && listing.state.is_some() {
                reads.insert(dev.clone(), self.read_state(dev, accepted));
            }
        }
        let candidates: Vec<&String> = listings.iter().filter(|(dev, l)| !protected.contains(dev.as_str()) && l.state.is_some()).map(|(dev, _)| dev).collect();
        if candidates.len() > MAX_STATE_CANDIDATES {
            budget.cut.set(true);
        }
        for dev in candidates.into_iter().take(MAX_STATE_CANDIDATES) {
            reads.insert(dev.clone(), self.read_state(dev, accepted));
        }
        let mut others: Vec<&String> = listings.keys().filter(|dev| !protected.contains(dev.as_str())).collect();
        let hlc_of = |dev: &str| reads.get(dev).and_then(|r| r.state.as_ref()).map(|s| s.last_sync_hlc.clone()).unwrap_or_default();
        others.sort_by(|a, b| hlc_of(b).cmp(&hlc_of(a)).then_with(|| a.cmp(b)));
        let kept_protected = listings.keys().filter(|dev| protected.contains(dev.as_str())).count();
        let room = MAX_DEVICE_FOLDERS.saturating_sub(kept_protected);
        let dropped = others.len().saturating_sub(room) as u64;
        let kept: BTreeSet<String> =
            listings.keys().filter(|dev| protected.contains(dev.as_str())).cloned().chain(others.into_iter().take(room).cloned()).collect();
        // 3. Époques listées pour les seuls appareils retenus.
        let mut scans = Vec::with_capacity(kept.len());
        let mut incomplete = false;
        for dev in &kept {
            let Some(mut listing) = listings.remove(dev) else { continue };
            let (bytes_before, ignored_before) = (listing.bytes, listing.ignored);
            self.list_epochs(dev, &mut listing, &budget).map_err(fs_error)?;
            total += listing.bytes - bytes_before;
            ignored += listing.ignored - ignored_before;
            let read = match reads.remove(dev) {
                Some(read) => read,
                None if listing.state.is_some() => self.read_state(dev, accepted),
                None => StateRead::status(None, StateStatus::Missing),
            };
            let (scan, cut) = self.scan_device(dev, &listing, read, accepted);
            incomplete |= cut;
            scans.push(scan);
        }
        Self::check_total(total)?;
        if total > FOLDER_WARN_BYTES {
            log::event("folder-large", &total.to_string());
        }
        incomplete |= budget.cut.get();
        Ok(FolderScan { devices: scans, ignored: ignored + dropped, total_bytes: total, too_many_devices: dropped > 0, incomplete })
    }

    fn check_total(total: u64) -> SyncResult<()> {
        if total > FOLDER_STOP_BYTES {
            log::event("folder-too-large", &total.to_string());
            return fail(SyncCode::FolderTooLarge);
        }
        Ok(())
    }

    fn scan_device(&self, dev: &str, listing: &DeviceListing, read: StateRead, accepted: &mut HashMap<String, Accepted>) -> (DeviceScan, bool) {
        Self::remember(dev, &read, accepted);
        // `kid` d'un état absent ou resté dans le nuage : en-tête d'un autre fichier présent (revue 16, même règle que memory.ts).
        let kid = read.kid.clone().or_else(|| if matches!(read.status, StateStatus::Missing | StateStatus::CloudPending) { self.any_kid(dev, listing) } else { None });
        let mut incomplete = false;
        let epochs = listing
            .epochs
            .iter()
            .map(|(epoch, files)| EpochListing { epoch: epoch.name(), segments: files.segments.keys().copied().collect(), snapshots: files.snapshots.keys().copied().collect() })
            .collect();
        // Fichiers attendus et pas encore lisibles : `state.ctx`, puis ce que la tête authentifiée annonce (jamais au-delà), plafonnés à
        // 10 000 entrées (`incomplete` au-delà, dette de l'amorce).
        let mut pending = Vec::new();
        let push = |pending: &mut Vec<PendingFile>, incomplete: &mut bool, file: String, availability: Availability| {
            if pending.len() >= MAX_SCAN_ENTRIES_PER_FOLDER {
                *incomplete = true;
            } else {
                pending.push(PendingFile { file, availability: availability.as_str() });
            }
        };
        if let Some(entry) = &listing.state {
            if entry.availability != Availability::Local && read.status != StateStatus::Ok {
                push(&mut pending, &mut incomplete, STATE_FILE.to_owned(), entry.availability);
            }
            if self.pin && entry.availability != Availability::Error {
                self.pin_file(&[DEVICES_DIR, dev, STATE_FILE]);
            }
        }
        if let Some(state) = &read.state {
            let epoch = EpochId::parse(&state.epoch);
            let files = epoch.as_ref().and_then(|e| listing.epochs.get(e));
            let epoch_name = state.epoch.as_str();
            if state.head.segment >= 1 {
                let head = state.head.segment.min(u64::from(super::names::MAX_FILE_NUMBER)) as u32;
                let from = files.and_then(|f| f.segments.keys().next().copied()).unwrap_or(head).min(head);
                for n in from..=head {
                    let entry = files.and_then(|f| f.segments.get(&n));
                    let availability = entry.map_or(Availability::Cloud, |e| e.availability);
                    if availability != Availability::Local {
                        push(&mut pending, &mut incomplete, format!("{epoch_name}/{}", segment_name(n)), availability);
                        if incomplete {
                            break;
                        }
                    }
                    if self.pin && entry.is_some_and(|e| e.availability != Availability::Error) {
                        self.pin_file(&[DEVICES_DIR, dev, epoch_name, &segment_name(n)]);
                    }
                }
            }
            if let (Some(files), Some(snapshot)) = (files, &state.snapshot) {
                for (n, entry) in &files.snapshots {
                    if u64::from(*n) <= snapshot.seq {
                        if entry.availability != Availability::Local {
                            push(&mut pending, &mut incomplete, format!("{epoch_name}/{}", snapshot_name(*n)), entry.availability);
                        }
                        if self.pin && entry.availability != Availability::Error {
                            self.pin_file(&[DEVICES_DIR, dev, epoch_name, &snapshot_name(*n)]);
                        }
                    }
                }
            }
        }
        (DeviceScan { device_id: dev.to_owned(), kid, state: read.state, state_status: read.status.as_str(), epochs, pending }, incomplete)
    }

    fn pin_file(&self, path: &[&str]) {
        if let Err(error) = self.fs.pin(path) {
            log::event("pin-failed", error.code().as_str());
        }
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Lecture des journaux et instantanés
    // --------------------------------------------------------------------------------------------------------------------------

    /// Fichier lu pour une lecture : borne, `kid`, majeure et correspondance de l'en-tête au chemin.
    fn checked<'b>(&self, bytes: &'b [u8], kind: HeaderKind, dev: &str, epoch: &str, n: u64) -> SyncResult<ParsedFile<'b>> {
        let file = match parse_file(bytes) {
            Ok(file) => file,
            Err(ParseError::Partial) => return fail(SyncCode::CloudPending),
            Err(ParseError::BadHeader) => return fail(SyncCode::BadHeader),
        };
        if file.header.kid != self.key.kid() {
            return fail(SyncCode::KeyMismatch);
        }
        if file.header.sm > SYNC_FORMAT_MAJOR {
            return fail(SyncCode::NewerFormat);
        }
        if file.header.kind() != Some(kind) || file.header.dev != dev || file.header.e != epoch || file.header.n != n {
            return fail(SyncCode::BadHeader);
        }
        Ok(file)
    }

    /// Page de texte clair, jamais au-delà de la tête authentifiée (section 1.4, cas limites de l'avenant « Amorce »).
    pub fn read_journal(&self, dev: &str, epoch: &str, from: RecordCursor, max_bytes: Option<u64>, accepted: &mut HashMap<String, Accepted>) -> SyncResult<ReadPage> {
        if !is_uuid_v4(dev) || !is_epoch_id(epoch) || from.segment > MAX_SAFE_INTEGER || from.record > MAX_SAFE_INTEGER || (from.segment == 0 && from.record != 0) {
            return fail(SyncCode::BadName);
        }
        let limit = page_limit(max_bytes)?;
        let Some(state) = self.authenticated_state(dev, accepted)? else {
            return Ok(ReadPage { records: Vec::new(), next: from, status: "cloud-pending" });
        };
        let head = RecordCursor { segment: state.head.segment, record: state.head.record };
        if state.head.epoch != epoch {
            return Ok(ReadPage { records: Vec::new(), next: from, status: "cloud-pending" });
        }
        if from >= head {
            return Ok(ReadPage { records: Vec::new(), next: from, status: "complete" });
        }
        let mut records = Vec::new();
        let mut bytes_out = 0usize;
        let mut segment = from.segment.max(1);
        let mut record = if from.segment == 0 { 0 } else { from.record };
        let mut status = "complete";
        let mut current: Option<(u64, Vec<u8>)> = None;
        'outer: loop {
            if (RecordCursor { segment, record }) >= head {
                break;
            }
            if current.as_ref().map(|(n, _)| *n) != Some(segment) {
                let Ok(n32) = u32::try_from(segment) else { return fail(SyncCode::BadName) };
                // Segment annoncé absent ou dans le nuage : en attente d'iCloud, jamais sauté.
                match self.fs.read(&[DEVICES_DIR, dev, epoch, &segment_name(n32)], MAX_SEGMENT_BYTES, true) {
                    Ok(bytes) => current = Some((segment, bytes)),
                    Err(FsError::NotFound | FsError::CloudPending | FsError::ProviderStopped | FsError::CloudError) => {
                        status = "cloud-pending";
                        break;
                    }
                    Err(error) => return Err(fs_error(error)),
                }
            }
            let Some((_, bytes)) = &current else { break };
            let file = self.checked(bytes, HeaderKind::Journal, dev, epoch, segment)?;
            loop {
                if (RecordCursor { segment, record }) >= head {
                    break 'outer;
                }
                let Some(line) = file.lines.get(record as usize) else {
                    if segment < head.segment && !file.partial_tail {
                        segment += 1;
                        record = 0;
                        continue 'outer;
                    }
                    status = "cloud-pending";
                    break 'outer;
                };
                let Some(line) = line_str(line) else {
                    status = "truncated";
                    break 'outer;
                };
                if parse_line_prefix(line).is_some_and(|p| p.sm > SYNC_FORMAT_MAJOR) {
                    return fail(SyncCode::NewerFormat);
                }
                // Échec de déchiffrement d'un enregistrement que la tête annonce : corruption, rien au-delà (section 1.2).
                let Ok(opened) = self.key.open(&Place::Journal { dev, epoch, segment: segment as u32, index: record }, line) else {
                    status = "truncated";
                    break 'outer;
                };
                if !records.is_empty() && bytes_out + opened.json.len() > limit {
                    status = "more";
                    break 'outer;
                }
                bytes_out += opened.json.len();
                records.push(opened.json);
                record += 1;
            }
        }
        Ok(ReadPage { records, next: RecordCursor { segment, record }, status })
    }

    /// Page d'un instantané annoncé par l'état authentifié.
    /// Le fichier est gardé dans `cache` entre deux pages du même instantané (revue 15) : un instantané validé n'est jamais réécrit
    /// sous le même numéro ; le cache est vidé quand la lecture se termine ou change d'instantané.
    #[allow(clippy::too_many_arguments)]
    pub fn read_snapshot(
        &self,
        dev: &str,
        epoch: &str,
        seq: u64,
        from_record: u64,
        max_bytes: Option<u64>,
        accepted: &mut HashMap<String, Accepted>,
        cache: &mut Option<SnapshotCache>,
    ) -> SyncResult<ReadPage> {
        if !is_uuid_v4(dev) || !is_epoch_id(epoch) || !is_file_number(seq) || from_record > MAX_SAFE_INTEGER {
            return fail(SyncCode::BadName);
        }
        let limit = page_limit(max_bytes)?;
        let from = RecordCursor { segment: seq, record: from_record };
        let pending = ReadPage { records: Vec::new(), next: from, status: "cloud-pending" };
        let Some(state) = self.authenticated_state(dev, accepted)? else { return Ok(pending) };
        if state.epoch != epoch || state.snapshot.as_ref().is_none_or_greater(seq) {
            return Ok(pending);
        }
        let key = (dev.to_owned(), epoch.to_owned(), seq);
        let bytes = match cache.as_ref().filter(|c| c.key == key) {
            Some(cached) => cached.bytes.clone(),
            None => {
                *cache = None;
                match self.fs.read(&[DEVICES_DIR, dev, epoch, &snapshot_name(seq as u32)], MAX_SNAPSHOT_BYTES, true) {
                    Ok(bytes) => Arc::new(bytes),
                    Err(FsError::NotFound | FsError::CloudPending | FsError::ProviderStopped | FsError::CloudError) => return Ok(pending),
                    Err(error) => return Err(fs_error(error)),
                }
            }
        };
        let file = self.checked(&bytes, HeaderKind::Snapshot, dev, epoch, seq)?;
        let mut records = Vec::new();
        let mut bytes_out = 0usize;
        let mut index = from_record;
        let mut status = "complete";
        while let Some(line) = file.lines.get(index as usize) {
            let Some(line) = line_str(line) else {
                status = "truncated";
                break;
            };
            let Ok(opened) = self.key.open(&Place::Snapshot { dev, epoch, seq: seq as u32, index }, line) else {
                status = "truncated";
                break;
            };
            if !records.is_empty() && bytes_out + opened.json.len() > limit {
                status = "more";
                break;
            }
            bytes_out += opened.json.len();
            records.push(opened.json);
            index += 1;
        }
        if status == "complete" && file.partial_tail {
            status = "cloud-pending";
        }
        *cache = (status == "more").then(|| SnapshotCache { key, bytes: bytes.clone() });
        Ok(ReadPage { records, next: RecordCursor { segment: seq, record: index }, status })
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Écritures (seulement dans `devices/<appareil lié>/`)
    // --------------------------------------------------------------------------------------------------------------------------

    /// `sync_append_journal`. `own` et `usage` sont mis à jour en mémoire ; l'appelant les persiste.
    #[allow(clippy::too_many_arguments)]
    pub fn append_journal(
        &self,
        own: &mut OwnState,
        usage: &mut Usage,
        nonce_max: u64,
        self_id: &str,
        epoch: &str,
        segment: u64,
        expect_records: u64,
        sv: u64,
        max_hlc: &str,
        records: &[String],
    ) -> SyncResult<AppendResult> {
        if !is_epoch_id(epoch) || !is_file_number(segment) || expect_records > MAX_SAFE_INTEGER || !(1..=MAX_SV).contains(&sv) {
            return fail(SyncCode::BadName);
        }
        // Paramètres mal formés (hlc hors format strict, appel vide) : `bad-name` ; `hlc-order` est réservé à l'ordre des hlc valides.
        if !is_strict_hlc(max_hlc) || records.is_empty() {
            return fail(SyncCode::BadName);
        }
        let sv32 = sv as u32;
        let mut add_bytes = 0u64;
        for text in records {
            if text.len() > MAX_RECORD_PLAINTEXT_BYTES {
                return fail(SyncCode::TooLarge);
            }
            add_bytes += encrypted_line_bytes(text.len(), SYNC_FORMAT_MAJOR, sv32) as u64;
        }
        if add_bytes > MAX_APPEND_CALL_BYTES {
            return fail(SyncCode::TooLarge);
        }
        check_epoch_not_older(own, epoch)?;
        let same_epoch = own.epoch.as_deref() == Some(epoch);
        // Un numéro de segment n'est jamais réutilisé ni pris en arrière ; sur le segment de sa tête, l'ajout repart exactement de la
        // tête connue (un fichier tronqué sous une tête publiée ne fait jamais réutiliser un index annoncé).
        if same_epoch && segment < own.segment {
            return fail(SyncCode::SegmentMismatch);
        }
        if same_epoch && segment == own.segment && expect_records != own.record {
            return fail(SyncCode::SegmentMismatch);
        }
        // Plus grand segment listé **authentifié** (audit S7) : un fichier déposé par un tiers (`j-99999999.ctj`) ne bloque rien.
        let mut segments: Vec<u32> = match self.fs.list(&[DEVICES_DIR, self_id, epoch], MAX_SCAN_ENTRIES_PER_FOLDER) {
            Ok(listing) => listing
                .entries
                .iter()
                .filter_map(|e| match parse_file_name(&e.name) {
                    Some(SyncFileName::Segment(n)) if !e.is_dir && u64::from(n) > segment => Some(n),
                    _ => None,
                })
                .collect(),
            Err(FsError::NotFound) => Vec::new(),
            Err(error) => return Err(fs_error(error)),
        };
        segments.sort_unstable_by(|a, b| b.cmp(a));
        if self.authenticated_tail(self_id, epoch, segments.into_iter()).is_some() {
            return fail(SyncCode::SegmentMismatch);
        }
        let segment32 = segment as u32;
        let file_name = segment_name(segment32);
        let path = [DEVICES_DIR, self_id, epoch, file_name.as_str()];
        let existing = match self.fs.read(&path, MAX_SEGMENT_BYTES, false) {
            Ok(bytes) => Some(bytes),
            Err(FsError::NotFound) => None,
            Err(FsError::TooLarge) => return fail(SyncCode::SegmentMismatch),
            Err(error) => return Err(fs_error(error)),
        };
        let first_record = match &existing {
            Some(bytes) => {
                let file = parse_file(bytes).map_err(|_| SyncError::new(SyncCode::SegmentMismatch))?;
                let h = &file.header;
                if h.kind() != Some(HeaderKind::Journal) || h.dev != self_id || h.e != epoch || h.n != segment || h.kid != self.key.kid() {
                    return fail(SyncCode::SegmentMismatch);
                }
                if file.partial_tail || file.lines.len() as u64 != expect_records {
                    return fail(SyncCode::SegmentMismatch);
                }
                if !file.lines.is_empty() && bytes.len() as u64 + add_bytes > SEGMENT_ROTATE_BYTES {
                    return fail(SyncCode::SegmentFull);
                }
                file.lines.len() as u64
            }
            None if expect_records != 0 => return fail(SyncCode::SegmentMismatch),
            None => 0,
        };
        // Hlc strictement croissants d'un ajout à l'autre dans une époque ; le contrôle repart de zéro à chaque nouvelle époque.
        if same_epoch && own.max_hlc.as_deref().is_some_and(|m| max_hlc <= m) {
            return fail(SyncCode::HlcOrder);
        }
        check_budget(usage, nonce_max, records.len() as u64)?;
        let mut out = String::with_capacity(add_bytes as usize + 256);
        if existing.is_none() {
            out.push_str(&FileHeader::new(HeaderKind::Journal, self.key.kid(), self_id, epoch, segment).line());
            out.push('\n');
        }
        for (i, text) in records.iter().enumerate() {
            let place = Place::Journal { dev: self_id, epoch, segment: segment32, index: first_record + i as u64 };
            out.push_str(&self.key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, sv32).map_err(|_| SyncError::new(SyncCode::Io))?);
            out.push('\n');
        }
        self.fs.create_dir(&[DEVICES_DIR, self_id, epoch]).map_err(fs_error)?;
        let mode = if existing.is_some() { AppendMode::Existing } else { AppendMode::CreateNew };
        self.fs.append(&path, out.as_bytes(), mode).map_err(|e| match e {
            FsError::Exists => SyncError::new(SyncCode::SegmentMismatch),
            other => fs_error(other),
        })?;
        usage.sealed += records.len() as u64;
        own.epoch = Some(epoch.to_owned());
        own.segment = segment;
        own.record = first_record + records.len() as u64;
        own.max_hlc = Some(max_hlc.to_owned());
        Ok(AppendResult { first_record, head: RecordCursor { segment: own.segment, record: own.record } })
    }

    /// `sync_write_state` : contrôles de la section 1.4 (Rust maître de `head`, `pairedBy` et `forgotten`), puis écriture atomique.
    #[allow(clippy::too_many_arguments)]
    pub fn write_state(
        &self,
        own: &mut OwnState,
        usage: &mut Usage,
        nonce_max: u64,
        self_id: &str,
        platform: &str,
        sv: u64,
        state: &PublishedState,
    ) -> SyncResult<String> {
        if !(1..=MAX_SV).contains(&sv) {
            return fail(SyncCode::BadName);
        }
        if state.acks.len() > MAX_STATE_ACKS || state.forgotten.len() > MAX_STATE_FORGOTTEN {
            return fail(SyncCode::TooLarge);
        }
        let text = state.canonical_json();
        if text.len() > MAX_RECORD_PLAINTEXT_BYTES {
            return fail(SyncCode::TooLarge);
        }
        if !state.is_valid() {
            return fail(SyncCode::BadName);
        }
        if state.device_id != self_id || state.platform != platform || state.sm != u64::from(SYNC_FORMAT_MAJOR) || state.sv != sv {
            return fail(SyncCode::StateMismatch);
        }
        // Réservés jusqu'au lot Y4 (Y-10 et Y-11, section 14.4).
        if !state.forgotten.is_empty() || state.reset.is_some() {
            return fail(SyncCode::StateMismatch);
        }
        if state.paired_by != own.paired_by || state.state_seq <= own.state_seq {
            return fail(SyncCode::StateMismatch);
        }
        check_epoch_not_older(own, &state.epoch)?;
        let head = &state.head;
        if own.epoch.as_deref() == Some(state.epoch.as_str()) {
            if head.segment != own.segment || head.record != own.record || head.hlc != own.max_hlc {
                return fail(SyncCode::StateMismatch);
            }
        } else if head.segment != 0 || head.record != 0 || head.hlc.is_some() {
            // Nouvelle époque annoncée avant tout ajout : tête vide.
            return fail(SyncCode::StateMismatch);
        }
        check_budget(usage, nonce_max, 1)?;
        let place = Place::State { dev: self_id, epoch: &state.epoch, state_seq: state.state_seq };
        let line = self.key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, sv as u32).map_err(|_| SyncError::new(SyncCode::Io))?;
        let header = FileHeader::new(HeaderKind::State, self.key.kid(), self_id, &state.epoch, state.state_seq).line();
        self.fs.create_dir(&device_dir(self_id)).map_err(fs_error)?;
        self.fs.write_atomic(&[DEVICES_DIR, self_id, STATE_FILE], format!("{header}\n{line}\n").as_bytes()).map_err(fs_error)?;
        usage.sealed += 1;
        if own.epoch.as_deref() != Some(state.epoch.as_str()) {
            own.epoch = Some(state.epoch.clone());
            own.segment = 0;
            own.record = 0;
            own.max_hlc = None;
        }
        own.state_seq = state.state_seq;
        Ok(sha256_hex(text.as_bytes()))
    }

    /// `sync_snapshot_begin` : numéro libre dans l'époque, fichier `.tmp` créé avec son en-tête.
    pub fn snapshot_begin(&self, own: &OwnState, self_id: &str, epoch: &str, seq: u64, sv: u64) -> SyncResult<SnapshotWriter> {
        if !is_epoch_id(epoch) || !is_file_number(seq) || !(1..=MAX_SV).contains(&sv) {
            return fail(SyncCode::BadName);
        }
        check_epoch_not_older(own, epoch)?;
        let taken = match self.fs.list(&[DEVICES_DIR, self_id, epoch], MAX_SCAN_ENTRIES_PER_FOLDER) {
            Ok(listing) => listing.entries.iter().filter_map(|e| match parse_file_name(&e.name) {
                Some(SyncFileName::Snapshot(n)) if !e.is_dir => Some(n),
                _ => None,
            }).max().unwrap_or(0),
            Err(FsError::NotFound) => 0,
            Err(error) => return Err(fs_error(error)),
        };
        // Numéro d'instantané jamais réutilisé dans une époque.
        if seq <= u64::from(taken) {
            return fail(SyncCode::SegmentMismatch);
        }
        let name = snapshot_name(seq as u32);
        let temp = format!("{name}{TEMP_SUFFIX}");
        self.fs.create_dir(&[DEVICES_DIR, self_id, epoch]).map_err(fs_error)?;
        self.fs.remove_file(&[DEVICES_DIR, self_id, epoch, &temp]).map_err(fs_error)?;
        let header = format!("{}\n", FileHeader::new(HeaderKind::Snapshot, self.key.kid(), self_id, epoch, seq).line());
        self.fs.append(&[DEVICES_DIR, self_id, epoch, &temp], header.as_bytes(), AppendMode::CreateNew).map_err(fs_error)?;
        Ok(SnapshotWriter { dev: self_id.to_owned(), epoch: epoch.to_owned(), seq: seq as u32, sv: sv as u32, bytes: header.len() as u64, records: 0 })
    }

    /// `sync_snapshot_append` : borne de 256 Mio, budget de nonces, ajout au `.tmp`.
    pub fn snapshot_append(&self, writer: &mut SnapshotWriter, usage: &mut Usage, nonce_max: u64, records: &[String]) -> SyncResult<()> {
        let mut bytes = writer.bytes;
        for text in records {
            if text.len() > MAX_RECORD_PLAINTEXT_BYTES {
                return fail(SyncCode::TooLarge);
            }
            bytes += encrypted_line_bytes(text.len(), SYNC_FORMAT_MAJOR, writer.sv) as u64;
            if bytes > MAX_SNAPSHOT_BYTES {
                return fail(SyncCode::TooLarge);
            }
        }
        // Budget de nonces contrôlé avant tout chiffrement (revue 18).
        check_budget(usage, nonce_max, records.len() as u64)?;
        let mut out = String::new();
        for (i, text) in records.iter().enumerate() {
            let place = Place::Snapshot { dev: &writer.dev, epoch: &writer.epoch, seq: writer.seq, index: writer.records + i as u64 };
            out.push_str(&self.key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, writer.sv).map_err(|_| SyncError::new(SyncCode::Io))?);
            out.push('\n');
        }
        let temp = format!("{}{TEMP_SUFFIX}", snapshot_name(writer.seq));
        self.fs.append(&[DEVICES_DIR, &writer.dev, &writer.epoch, &temp], out.as_bytes(), AppendMode::Existing).map_err(fs_error)?;
        usage.sealed += records.len() as u64;
        writer.bytes = bytes;
        writer.records += records.len() as u64;
        Ok(())
    }

    /// `sync_snapshot_commit` : renommage atomique du `.tmp`.
    pub fn snapshot_commit(&self, writer: &SnapshotWriter) -> SyncResult<()> {
        let name = snapshot_name(writer.seq);
        let temp = format!("{name}{TEMP_SUFFIX}");
        self.fs.rename(&[DEVICES_DIR, &writer.dev, &writer.epoch], &temp, &name).map_err(fs_error)
    }

    /// Abandon d'un instantané (première erreur) : le `.tmp` est supprimé.
    pub fn snapshot_discard(&self, writer: &SnapshotWriter) {
        let temp = format!("{}{TEMP_SUFFIX}", snapshot_name(writer.seq));
        let _ = self.fs.remove_file(&[DEVICES_DIR, &writer.dev, &writer.epoch, &temp]);
    }

    /// `sync_delete_own` : jamais l'époque courante ni son segment de tête ; seuls les noms stricts sont supprimés.
    pub fn delete_own(&self, own: &OwnState, self_id: &str, files: &[OwnFileRef]) -> SyncResult<u64> {
        for file in files {
            let valid_kind = matches!(file.kind.as_str(), "j" | "s" | "epoch");
            let valid_n = if file.kind == "epoch" { file.n.is_none() } else { file.n.is_some_and(is_file_number) };
            if !is_epoch_id(&file.epoch) || !valid_kind || !valid_n {
                return fail(SyncCode::BadName);
            }
            let current = own.epoch.as_deref() == Some(file.epoch.as_str());
            if current && (file.kind == "epoch" || (file.kind == "j" && file.n == Some(own.segment))) {
                return fail(SyncCode::CurrentEpoch);
            }
        }
        let mut deleted = 0u64;
        for file in files {
            let epoch = file.epoch.as_str();
            match (file.kind.as_str(), file.n) {
                ("epoch", _) => {
                    let listing = match self.fs.list(&[DEVICES_DIR, self_id, epoch], MAX_SCAN_ENTRIES_PER_FOLDER) {
                        Ok(listing) => listing,
                        Err(FsError::NotFound) => continue,
                        Err(error) => return Err(fs_error(error)),
                    };
                    for entry in listing.entries.iter().filter(|e| !e.is_dir) {
                        if matches!(parse_file_name(&entry.name), Some(SyncFileName::Segment(_) | SyncFileName::Snapshot(_)))
                            && self.fs.remove_file(&[DEVICES_DIR, self_id, epoch, &entry.name]).map_err(fs_error)?
                        {
                            deleted += 1;
                        }
                    }
                    self.fs.remove_empty_dir(&[DEVICES_DIR, self_id, epoch]).map_err(fs_error)?;
                }
                (kind, Some(n)) => {
                    let name = if kind == "j" { segment_name(n as u32) } else { snapshot_name(n as u32) };
                    if self.fs.remove_file(&[DEVICES_DIR, self_id, epoch, &name]).map_err(fs_error)? {
                        deleted += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(deleted)
    }

    // --------------------------------------------------------------------------------------------------------------------------
    // Clé et dossier
    // --------------------------------------------------------------------------------------------------------------------------

    /// Le dossier contient-il des données CircleTasks ? Un dossier `devices/<uuid>/` avec un `state.ctx` ou un fichier de nom strict
    /// d'en-tête valide ; un fichier resté dans le nuage compte (son en-tête ne peut pas être lu sans hydratation). Budget commun de
    /// 50 000 entrées et 64 époques par appareil (audit S2) : au-delà, la recherche s'arrête sur « pas de données trouvées ».
    pub fn folder_has_data(fs: &dyn SyncFs) -> SyncResult<bool> {
        let budget = Budget::new();
        let root = match budget.list(fs, &[DEVICES_DIR]) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => return Ok(false),
            Err(error) => return Err(fs_error(error)),
        };
        let has_header = |path: &[&str], entry: &FsEntry| -> bool {
            match entry.availability {
                Availability::Cloud => true,
                Availability::Error => false,
                Availability::Local => entry.size <= MAX_SEGMENT_BYTES && fs.read(path, MAX_SEGMENT_BYTES, false).ok().is_some_and(|b| parse_file(&b).is_ok()),
            }
        };
        for dev in root.entries.iter().filter(|e| e.is_dir && is_uuid_v4(&e.name)) {
            let Ok(listing) = budget.list(fs, &device_dir(&dev.name)) else { continue };
            let mut epochs = 0;
            for entry in &listing.entries {
                if !entry.is_dir && entry.name == STATE_FILE && has_header(&[DEVICES_DIR, &dev.name, STATE_FILE], entry) {
                    return Ok(true);
                }
                if entry.is_dir && is_epoch_id(&entry.name) && epochs < MAX_EPOCHS_PER_DEVICE {
                    epochs += 1;
                    let Ok(files) = budget.list(fs, &[DEVICES_DIR, &dev.name, &entry.name]) else { continue };
                    for file in files.entries.iter().filter(|f| !f.is_dir && matches!(parse_file_name(&f.name), Some(SyncFileName::Segment(_) | SyncFileName::Snapshot(_)))) {
                        if has_header(&[DEVICES_DIR, &dev.name, &entry.name, &file.name], file) {
                            return Ok(true);
                        }
                    }
                }
            }
        }
        Ok(false)
    }

    /// Le dossier porte-t-il la clé `key` ? Lit les `state.ctx` (hydratés au besoin ; 64 au plus, audit S2) ; `only` : un seul appareil
    /// (QR). `readable` compte les états dont l'en-tête est lisible ; `decrypts` est vrai si l'un d'eux annonce le `kid` de la clé **et**
    /// se déchiffre avec elle (audit S4 : un `kid` recopié en clair ne suffit pas).
    pub fn folder_kids(fs: &dyn SyncFs, only: Option<&str>, key: &MasterKey) -> SyncResult<KidCheck> {
        let budget = Budget::new();
        let root = match budget.list(fs, &[DEVICES_DIR]) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => return Ok(KidCheck::default()),
            Err(error) => return Err(fs_error(error)),
        };
        let mut check = KidCheck::default();
        let devices = root.entries.iter().filter(|e| e.is_dir && is_uuid_v4(&e.name) && only.is_none_or_eq(&e.name));
        for dev in devices.take(MAX_STATE_CANDIDATES) {
            let Ok(bytes) = fs.read(&[DEVICES_DIR, &dev.name, STATE_FILE], MAX_STATE_FILE_BYTES, true) else { continue };
            let Ok(file) = parse_file(&bytes) else { continue };
            let h = &file.header;
            if h.kind() != Some(HeaderKind::State) || h.dev != dev.name {
                continue;
            }
            check.readable += 1;
            if h.kid != key.kid() || file.partial_tail {
                continue;
            }
            let place = Place::State { dev: &dev.name, epoch: &h.e, state_seq: h.n };
            if let [line] = file.lines.as_slice() {
                if line_str(line).is_some_and(|line| key.open(&place, line).is_ok()) {
                    check.decrypts = true;
                }
            }
        }
        Ok(check)
    }

    /// Reconstruction de `own.json` (règle 1, section 9 ; avenant « Amorce » point 2) : maximum, pour l'époque courante, de son
    /// `state.ctx` authentifié, des accusés `acks[self]` des autres et de ses segments listés **authentifiés** (audit S7 : un fichier
    /// déposé, d'en-tête illisible ou d'une autre clé, est ignoré) ; `stateSeq` toutes époques confondues.
    ///
    /// Son propre `state.ctx` présent mais illisible (dans le nuage, incomplet, remplacé) et aucun accusé qui borne : `cloud-pending`,
    /// rien n'est mis en cache (revue 4) ; l'appareil ne publie pas sur une tête qu'il ne connaît pas.
    pub fn rebuild_own(&self, folder_id: &str, self_id: &str, accepted: &HashMap<String, Accepted>) -> SyncResult<OwnState> {
        let mine = self.read_state(self_id, accepted);
        let state = if mine.status == StateStatus::Ok { mine.state } else { None };
        let mut acks = Vec::new();
        let budget = Budget::new();
        let root = match budget.list(self.fs, &[DEVICES_DIR]) {
            Ok(listing) => listing.entries,
            Err(FsError::NotFound) => Vec::new(),
            Err(error) => return Err(fs_error(error)),
        };
        let others = root.iter().filter(|e| e.is_dir && is_uuid_v4(&e.name) && e.name != self_id);
        for dev in others.take(MAX_STATE_CANDIDATES) {
            let read = self.read_state(&dev.name, accepted);
            if let Some(ack) = read.state.as_ref().and_then(|s| s.acks.get(self_id)) {
                acks.push(ack.clone());
            }
        }
        if !matches!(mine.status, StateStatus::Ok | StateStatus::Missing) && acks.is_empty() {
            log::event("own-rebuild-pending", mine.status.as_str());
            return fail(SyncCode::CloudPending);
        }
        let mut listing = self.list_device_top(self_id, &budget).map_err(fs_error)?;
        self.list_epochs(self_id, &mut listing, &budget).map_err(fs_error)?;
        // Époques des fichiers listés retenues seulement si l'une d'elles contient un segment authentifié.
        let mut listed: BTreeMap<EpochId, (u32, u64)> = BTreeMap::new();
        for (epoch, files) in listing.epochs.iter().rev() {
            if let Some(tail) = self.authenticated_tail(self_id, &epoch.name(), files.segments.keys().rev().copied()) {
                listed.insert(epoch.clone(), tail);
                break;
            }
        }
        let mut epochs: Vec<EpochId> = listed.keys().cloned().collect();
        epochs.extend(state.iter().filter_map(|s| EpochId::parse(&s.epoch)));
        epochs.extend(acks.iter().filter_map(|a| EpochId::parse(&a.epoch)));
        let epoch = epochs.into_iter().max();
        let state_seq = acks.iter().map(|a| a.state_seq).chain(state.iter().map(|s| s.state_seq)).max().unwrap_or(0);
        let mut own = OwnState::empty(folder_id, self.key.kid());
        own.state_seq = state_seq;
        own.paired_by = state.as_ref().and_then(|s| s.paired_by.clone());
        let Some(epoch) = epoch else { return Ok(own) };
        let epoch_name = epoch.name();
        let mut head = RecordCursor { segment: 0, record: 0 };
        let mut max_hlc: Option<String> = None;
        if let Some(&(n, lines)) = listed.get(&epoch) {
            head = RecordCursor { segment: u64::from(n), record: lines };
        }
        let mut sources: Vec<(RecordCursor, Option<String>)> = Vec::new();
        if let Some(s) = state.as_ref().filter(|s| s.epoch == epoch_name) {
            sources.push((RecordCursor { segment: s.head.segment, record: s.head.record }, s.head.hlc.clone()));
        }
        for ack in acks.iter().filter(|a| a.epoch == epoch_name) {
            sources.push((RecordCursor { segment: ack.segment, record: ack.record }, ack.hlc.clone()));
        }
        for (cursor, hlc) in sources {
            head = head.max(cursor);
            if let Some(hlc) = hlc {
                if max_hlc.as_ref().is_none_or_less(&hlc) {
                    max_hlc = Some(hlc);
                }
            }
        }
        own.epoch = Some(epoch_name);
        own.segment = head.segment;
        own.record = head.record;
        own.max_hlc = max_hlc;
        Ok(own)
    }
}

/// Résultat de `folder_kids`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KidCheck {
    pub readable: usize,
    pub decrypts: bool,
}

/// Instantané gardé entre deux pages de lecture.
pub struct SnapshotCache {
    key: (String, String, u64),
    bytes: Arc<Vec<u8>>,
}

/// Instantané en cours d'écriture.
#[derive(Debug, Clone)]
pub struct SnapshotWriter {
    pub dev: String,
    pub epoch: String,
    pub seq: u32,
    pub sv: u32,
    pub bytes: u64,
    pub records: u64,
}

fn page_limit(max_bytes: Option<u64>) -> SyncResult<usize> {
    match max_bytes {
        None => Ok(MAX_IPC_PAGE_BYTES),
        Some(0) => fail(SyncCode::BadName),
        Some(n) if n > MAX_SAFE_INTEGER => fail(SyncCode::BadName),
        Some(n) => Ok((n as usize).min(MAX_IPC_PAGE_BYTES)),
    }
}

/// Une époque antérieure à celle de `own.json` n'est plus écrite (`state-mismatch`).
fn check_epoch_not_older(own: &OwnState, epoch: &str) -> SyncResult<()> {
    let (Some(current), Some(requested)) = (own.epoch.as_deref().and_then(EpochId::parse), EpochId::parse(epoch)) else { return Ok(()) };
    if requested < current {
        return fail(SyncCode::StateMismatch);
    }
    Ok(())
}

/// Budget de nonces (audit B1) : refus de chiffrer au-delà du plafond (`key-exhausted`).
fn check_budget(usage: &Usage, nonce_max: u64, count: u64) -> SyncResult<()> {
    if usage.sealed.saturating_add(count) > nonce_max {
        return fail(SyncCode::KeyExhausted);
    }
    Ok(())
}

trait OptionExt<T> {
    fn is_none_or_greater(&self, seq: u64) -> bool;
}

impl OptionExt<super::state::SnapshotRef> for Option<&super::state::SnapshotRef> {
    /// Instantané non annoncé, ou numéro demandé au-delà du dernier annoncé.
    fn is_none_or_greater(&self, seq: u64) -> bool {
        self.map_or(true, |s| seq > s.seq)
    }
}

trait StrOptionExt {
    fn is_none_or_eq(&self, value: &str) -> bool;
    fn is_none_or_less(&self, value: &str) -> bool;
}

impl StrOptionExt for Option<&str> {
    fn is_none_or_eq(&self, value: &str) -> bool {
        self.map_or(true, |v| v == value)
    }
    fn is_none_or_less(&self, value: &str) -> bool {
        self.map_or(true, |v| v < value)
    }
}

impl StrOptionExt for Option<&String> {
    fn is_none_or_eq(&self, value: &str) -> bool {
        self.map_or(true, |v| v == value)
    }
    fn is_none_or_less(&self, value: &str) -> bool {
        self.map_or(true, |v| v.as_str() < value)
    }
}
