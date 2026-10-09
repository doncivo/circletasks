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
    MAX_PLUGIN_CHUNK_BYTES, MAX_RECORD_LINE_BYTES, MAX_RECORD_PLAINTEXT_BYTES, MAX_SCAN_ENTRIES_PER_FOLDER, MAX_SEGMENT_BYTES, MAX_SNAPSHOT_BYTES, MAX_STATE_ACKS, MAX_STATE_FILE_BYTES,
    MAX_STATE_FORGOTTEN, SEGMENT_ROTATE_BYTES,
};
use super::names::{
    is_epoch_id, is_file_number, is_strict_hlc, is_uuid_v4, parse_file_name, segment_name, snapshot_name, EpochId, SyncFileName, DEVICES_DIR,
    STATE_FILE, STATE_NEXT_FILE, TEMP_SUFFIX,
};
use super::state::{OwnState, PublishedState, Usage};
use super::{fail, log, SyncCode, SyncError, SyncResult};

/// Écart maximal accepté entre le `stateSeq` lu en clair dans l'en-tête de son propre état remplacé et les sources authentifiées.
pub const MAX_UNAUTHENTICATED_SEQ_JUMP: u64 = 1_000_000;

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

/// En-tête d'un fichier lu en flux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamHeader {
    Ok(FileHeader),
    /// Aucun `\n` dans un fichier de 1 Kio au plus : en transfert (comme `ParseError::Partial`).
    Partial,
    /// En-tête invalide ou de plus de 1 Kio (comme `ParseError::BadHeader`).
    Bad,
}

/// Fin d'un fichier lu en flux : en-tête, nombre de lignes complètes, dernière ligne complète (None : ligne de plus de
/// `MAX_RECORD_LINE_BYTES`, jamais gardée en mémoire), dernière ligne incomplète présente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamTail {
    pub header: StreamHeader,
    pub lines: u64,
    pub last: Option<Vec<u8>>,
    pub partial_tail: bool,
}

/// Lecture en flux (ADR 0011 §22 point 4) par blocs de 1 Mio (`MAX_PLUGIN_CHUNK_BYTES`) : voir `stream_last_line_with`.
pub fn stream_last_line(fs: &dyn SyncFs, file: &[&str], limit: u64) -> Result<StreamTail, FsError> {
    stream_last_line_with(fs, file, limit, MAX_PLUGIN_CHUNK_BYTES)
}

/// En-tête, nombre de lignes et dernière ligne complète d'un fichier, lu par `read_from` en blocs de `chunk` octets (hydratation
/// demandée) ; mémoire bornée à un bloc et une ligne de `MAX_RECORD_LINE_BYTES`. Même découpage que `parse_file` (en-tête jusqu'au premier
/// `\n`, 1 Kio au plus ; lignes terminées par `\n`). Taille annoncée au-delà de `limit` : `TooLarge` ; un bloc vide avant la fin
/// annoncée (fichier en cours de transfert) : `CloudPending`.
pub fn stream_last_line_with(fs: &dyn SyncFs, file: &[&str], limit: u64, chunk: usize) -> Result<StreamTail, FsError> {
    let chunk = chunk.max(1);
    let mut offset = 0u64;
    let mut header_buf: Vec<u8> = Vec::new();
    let mut header: Option<StreamHeader> = None;
    let mut current: Vec<u8> = Vec::new();
    let mut overlong = false;
    let mut lines = 0u64;
    let mut last: Option<Vec<u8>> = None;
    loop {
        let block = fs.read_from(file, offset, chunk, true)?;
        if block.size > limit {
            return Err(FsError::TooLarge);
        }
        let mut rest: &[u8] = &block.bytes;
        if header.is_none() {
            match rest.iter().position(|&b| b == b'\n') {
                Some(pos) if header_buf.len() + pos <= MAX_HEADER_BYTES => {
                    header_buf.extend_from_slice(&rest[..pos]);
                    header = Some(FileHeader::parse(&header_buf).map_or(StreamHeader::Bad, StreamHeader::Ok));
                    rest = &rest[pos + 1..];
                }
                Some(_) => header = Some(StreamHeader::Bad),
                None => {
                    header_buf.extend_from_slice(rest);
                    if header_buf.len() > MAX_HEADER_BYTES {
                        header = Some(StreamHeader::Bad);
                    }
                    rest = &[];
                }
            }
            if header == Some(StreamHeader::Bad) {
                return Ok(StreamTail { header: StreamHeader::Bad, lines: 0, last: None, partial_tail: false });
            }
        }
        if header.is_some() {
            while let Some(pos) = rest.iter().position(|&b| b == b'\n') {
                let piece = &rest[..pos];
                if !overlong && current.len() + piece.len() <= MAX_RECORD_LINE_BYTES {
                    current.extend_from_slice(piece);
                    last = Some(std::mem::take(&mut current));
                } else {
                    last = None;
                    current.clear();
                }
                overlong = false;
                lines += 1;
                rest = &rest[pos + 1..];
            }
            if !overlong && current.len() + rest.len() <= MAX_RECORD_LINE_BYTES {
                current.extend_from_slice(rest);
            } else if !rest.is_empty() {
                overlong = true;
                current.clear();
            }
        }
        offset += block.bytes.len() as u64;
        if block.eof {
            break;
        }
        if block.bytes.is_empty() {
            return Err(FsError::CloudPending);
        }
    }
    let header = header.unwrap_or(StreamHeader::Partial);
    Ok(StreamTail { header, lines, last, partial_tail: overlong || !current.is_empty() })
}

/// En-tête analysé depuis les premiers octets d'un fichier (jusqu'au premier saut de ligne, 1 Kio au plus).
fn header_of(head: &[u8]) -> Option<FileHeader> {
    let end = head.iter().take(MAX_HEADER_BYTES + 1).position(|&b| b == b'\n')?;
    FileHeader::parse(&head[..end])
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
    /// Y-TECH-02 : dossier de plus de 1 Gio (`FOLDER_WARN_BYTES`) : avertissement montré à l'utilisateur, jamais un blocage.
    pub folder_large: bool,
    /// Y-TECH-02 : budget de nonces de la clé courante (ou de la nouvelle clé d'une réinitialisation) au-delà du seuil d'alerte ;
    /// rempli par `SyncCore::scan`.
    pub nonce_warning: bool,
    /// Y-10 : registre de l'oubli après fusion des déclarations lues (§11.1, §18) ; rempli par `SyncCore::scan`.
    pub forgotten: super::forget::ForgottenView,
    /// Y-11 : réinitialisation en cours sur cet appareil (rôle, étape, perte, bascule) ; rempli par `SyncCore::scan`.
    pub reset: Option<super::service::ResetView>,
}

/// Clé du cache des fins d'instantané : (kid, appareil, époque, numéro).
pub type SnapshotEndKey = (String, String, String, u64);

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

/// Lecture d'un `state.ctx` (ou, pendant une réinitialisation, de `state.next.ctx`, Y-11).
pub struct StateRead {
    pub kid: Option<String>,
    pub state: Option<PublishedState>,
    pub digest: Option<String>,
    pub status: StateStatus,
    /// Y-11 : état lu dans `state.next.ctx` (nouvelle clé publiée pendant la transition).
    pub from_next_file: bool,
}

impl StateRead {
    fn status(kid: Option<String>, status: StateStatus) -> Self {
        Self { kid, state: None, digest: None, status, from_next_file: false }
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
    /// Le dossier d'appareil existe.
    exists: bool,
    state: Option<FsEntry>,
    /// Y-11 : `state.next.ctx` (état sous la nouvelle clé pendant une réinitialisation).
    next_state: Option<FsEntry>,
    /// Dossiers d'époque présents (noms stricts), listés ou non.
    epoch_names: BTreeSet<EpochId>,
    /// Fichiers des époques listées (appareils retenus seulement, audit S2).
    epochs: BTreeMap<EpochId, EpochFiles>,
    ignored: u64,
    bytes: u64,
}

impl DeviceListing {
    /// Un fichier d'état est listé (`state.ctx`, ou `state.next.ctx` pendant une réinitialisation).
    fn has_state(&self) -> bool {
        self.state.is_some() || self.next_state.is_some()
    }
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

/// Y-11 : nouvelle clé d'une réinitialisation en cours (entrée `.next`) et époque qu'elle chiffre (`e<n+1>-<auteur>`).
#[derive(Clone, Copy)]
pub struct NextKey<'a> {
    pub key: &'a MasterKey,
    pub epoch: &'a str,
}

/// Contexte d'accès : dossier lié et clé locale. `pin` : épingler les fichiers annoncés (dossier iCloud). `next` (Y-11) : pendant une
/// réinitialisation, l'époque visée est lue et écrite avec la nouvelle clé, son état publié dans `state.next.ctx` ; tout le reste garde
/// la clé locale (`.v1`).
pub struct Store<'a> {
    pub fs: &'a dyn SyncFs,
    pub key: &'a MasterKey,
    pub pin: bool,
    pub next: Option<NextKey<'a>>,
}

fn device_dir(dev: &str) -> [&str; 2] {
    [DEVICES_DIR, dev]
}

impl<'a> Store<'a> {
    pub fn new(fs: &'a dyn SyncFs, key: &'a MasterKey, pin: bool) -> Self {
        Self { fs, key, pin, next: None }
    }

    /// Clé d'une époque : la nouvelle clé pour l'époque visée par une réinitialisation en cours, sinon la clé locale (Y-11).
    pub fn key_for(&self, epoch: &str) -> &'a MasterKey {
        match self.next {
            Some(next) if next.epoch == epoch => next.key,
            _ => self.key,
        }
    }

    /// Fichier d'état et clé d'un état publié par cet appareil dans `epoch` : `state.next.ctx` sous la nouvelle clé pour l'époque visée
    /// d'une réinitialisation en cours, sinon `state.ctx` sous la clé locale.
    pub fn state_target(&self, epoch: &str) -> (&'static str, &'a MasterKey) {
        match self.next {
            Some(next) if next.epoch == epoch => (STATE_NEXT_FILE, next.key),
            _ => (STATE_FILE, self.key),
        }
    }

    /// Premier niveau d'un dossier d'appareil : `state.ctx` et noms des dossiers d'époque (sans les lister).
    fn list_device_top(&self, dev: &str, budget: &Budget) -> Result<DeviceListing, FsError> {
        let mut out = DeviceListing::default();
        let listing = match budget.list(self.fs, &device_dir(dev)) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => return Ok(out),
            Err(error) => return Err(error),
        };
        out.exists = true;
        for entry in listing.entries {
            if !entry.is_dir && entry.name == STATE_FILE {
                out.bytes += entry.size;
                out.state = Some(entry);
                continue;
            }
            if !entry.is_dir && entry.name == STATE_NEXT_FILE {
                out.bytes += entry.size;
                out.next_state = Some(entry);
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
        let key = self.key_for(epoch);
        // Pré-filtre sur l'en-tête seul (1 Kio, sans hydratation ni déchiffrement, hors des 16 essais) : un faux segment d'en-tête
        // illisible, d'une autre clé ou d'un autre chemin ne consomme aucun essai (audit A4).
        let plausible = segments.filter(|&n| {
            self.fs
                .read_head(&[DEVICES_DIR, dev, epoch, &segment_name(n)], MAX_HEADER_BYTES + 1)
                .ok()
                .and_then(|head| header_of(&head))
                .is_some_and(|h| h.kind() == Some(HeaderKind::Journal) && h.dev == dev && h.e == epoch && h.n == u64::from(n) && h.kid == key.kid())
        });
        for n in plausible.take(16) {
            let Ok(bytes) = self.fs.read(&[DEVICES_DIR, dev, epoch, &segment_name(n)], MAX_SEGMENT_BYTES, false) else { continue };
            let Ok(file) = parse_file(&bytes) else { continue };
            let h = &file.header;
            if h.kind() != Some(HeaderKind::Journal) || h.dev != dev || h.e != epoch || h.n != u64::from(n) || h.kid != key.kid() {
                continue;
            }
            let Some(last) = file.lines.last().and_then(|l| line_str(l)) else { continue };
            let index = file.lines.len() as u64 - 1;
            if key.open(&Place::Journal { dev, epoch, segment: n, index }, last).is_ok() {
                return Some((n, file.lines.len() as u64));
            }
        }
        None
    }

    /// État présenté d'un appareil (Y-11, §14.3) : pendant une réinitialisation, `state.next.ctx` sous la nouvelle clé, puis `state.ctx`
    /// sous la nouvelle clé (appareil qui a déjà basculé) ; sinon `state.next.ctx` sous la clé locale (appareil associé pendant la
    /// transition, qui ne détient que la nouvelle clé) ; enfin `state.ctx` sous la clé locale (cas ordinaire). Un `state.next.ctx` d'une
    /// autre clé est ignoré (jamais `foreign` à la place de l'état ordinaire).
    pub fn read_state(&self, dev: &str, accepted: &HashMap<String, Accepted>) -> StateRead {
        if let Some(next) = self.next {
            let read = self.read_state_keys(dev, STATE_NEXT_FILE, &[next.key], accepted);
            if !matches!(read.status, StateStatus::Missing | StateStatus::Foreign) {
                return read;
            }
            // `state.ctx` lu une fois : clé choisie d'après l'en-tête (nouvelle clé d'un appareil qui a basculé, ou clé locale).
            return self.read_state_keys(dev, STATE_FILE, &[next.key, self.key], accepted);
        }
        let read = self.read_state_keys(dev, STATE_FILE, &[self.key], accepted);
        // `state.next.ctx` n'est lu que si `state.ctx` est d'une autre clé (appareil associé pendant une transition, qui ne détient
        // que la nouvelle clé) : aucun coût dans le cas ordinaire.
        if read.status == StateStatus::Foreign {
            let next = self.read_state_keys(dev, STATE_NEXT_FILE, &[self.key], accepted);
            if next.status == StateStatus::Ok {
                return next;
            }
        }
        read
    }

    /// Lecture d'un fichier d'état (`state.ctx` ou `state.next.ctx`) avec une clé : bornes, en-tête, clé, majeure, ligne unique,
    /// déchiffrement, analyse stricte, anti-rejeu.
    pub fn read_state_file(&self, dev: &str, file_name: &'static str, key: &MasterKey, accepted: &HashMap<String, Accepted>) -> StateRead {
        self.read_state_keys(dev, file_name, &[key], accepted)
    }

    /// Même lecture avec plusieurs clés possibles : celle dont le `kid` est celui de l'en-tête (sinon `foreign`).
    fn read_state_keys(&self, dev: &str, file_name: &'static str, keys: &[&MasterKey], accepted: &HashMap<String, Accepted>) -> StateRead {
        let mut read = self.read_state_inner(dev, file_name, keys, accepted);
        read.from_next_file = file_name == STATE_NEXT_FILE;
        read
    }

    fn read_state_inner(&self, dev: &str, file_name: &'static str, keys: &[&MasterKey], accepted: &HashMap<String, Accepted>) -> StateRead {
        let path = [DEVICES_DIR, dev, file_name];
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
        let Some(key) = keys.iter().find(|k| k.kid() == h.kid) else { return StateRead::status(kid, StateStatus::Foreign) };
        if h.kind() != Some(HeaderKind::State) || h.dev != dev {
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
        let Ok(opened) = key.open(&place, line) else { return StateRead::status(kid, StateStatus::Corrupt) };
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
        StateRead { kid, state: Some(state), digest: Some(digest), status: StateStatus::Ok, from_next_file: false }
    }

    /// Retient l'état lu comme accepté.
    pub(crate) fn remember(dev: &str, read: &StateRead, accepted: &mut HashMap<String, Accepted>) {
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
        self.scan_within(self_id, keep, accepted, None)
    }

    /// `sync_scan({ keep, hydrateBudgetMs })` : `budget` réduit le budget d'hydratation du cycle (ADR 0011 §22 point 4) ; None : 3 minutes.
    pub fn scan_within(&self, self_id: Option<&str>, keep: &[String], accepted: &mut HashMap<String, Accepted>, budget: Option<std::time::Duration>) -> SyncResult<FolderScan> {
        match budget {
            Some(budget) => self.fs.start_cycle_within(budget),
            None => self.fs.start_cycle(),
        }
        .map_err(fs_error)?;
        let budget = Budget::new();
        let protected: BTreeSet<&str> = keep.iter().map(String::as_str).chain(self_id).filter(|id| is_uuid_v4(id)).collect();
        let mut ignored = 0u64;
        let mut total = 0u64;
        let mut listings: BTreeMap<String, DeviceListing> = BTreeMap::new();
        // 1a. Soi et `keep` d'abord, premier niveau puis époques, avant tout dossier inconnu : le budget de 50 000 entrées leur est
        //     réservé, des dossiers hostiles ne peuvent pas les rendre incomplets (audit A1).
        for dev in &protected {
            let mut listing = self.list_device_top(dev, &budget).map_err(fs_error)?;
            if !listing.exists {
                continue;
            }
            self.list_epochs(dev, &mut listing, &budget).map_err(fs_error)?;
            total += listing.bytes;
            ignored += listing.ignored;
            listings.insert((*dev).to_owned(), listing);
        }
        // 1b. Les autres dossiers d'appareils, premier niveau seulement, avec le reste du budget.
        let root = match budget.list(self.fs, &[DEVICES_DIR]) {
            Ok(listing) => listing,
            Err(FsError::NotFound) => Default::default(),
            Err(error) => return Err(fs_error(error)),
        };
        for entry in root.entries {
            if protected.contains(entry.name.as_str()) {
                continue;
            }
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
        // 2. Choix des dossiers retenus (16 ; soi et `keep` jamais écartés). L'état est lu pour les appareils protégés et pour 64
        //    candidats au plus (audit S2), choisis d'abord par leur en-tête en clair (1 Kio : notre `kid` et le bon chemin), puis par
        //    la taille de leur `state.ctx` : des dossiers factices n'écartent pas un appareil en cours d'association (audit A3).
        let mut reads: BTreeMap<String, StateRead> = BTreeMap::new();
        for (dev, listing) in &listings {
            if protected.contains(dev.as_str()) && listing.has_state() {
                reads.insert(dev.clone(), self.read_state(dev, accepted));
            }
        }
        let mut candidates: Vec<(u8, u64, &String)> = listings
            .iter()
            .filter(|(dev, l)| !protected.contains(dev.as_str()) && l.has_state())
            .map(|(dev, l)| {
                let file = if l.state.is_some() { STATE_FILE } else { STATE_NEXT_FILE };
                let ours = |kid: &str| kid == self.key.kid() || self.next.is_some_and(|n| n.key.kid() == kid);
                let class = match self.fs.read_head(&[DEVICES_DIR, dev, file], MAX_HEADER_BYTES + 1) {
                    Ok(head) => match header_of(&head) {
                        Some(h) if h.kind() == Some(HeaderKind::State) && h.dev == *dev && ours(&h.kid) => 0,
                        _ => 2,
                    },
                    // Dans le nuage : en-tête inconnu, après les en-têtes vérifiés.
                    Err(FsError::CloudPending) => 1,
                    Err(_) => 2,
                };
                (class, l.state.as_ref().or(l.next_state.as_ref()).map_or(0, |s| s.size), dev)
            })
            .collect();
        candidates.sort();
        if candidates.len() > MAX_STATE_CANDIDATES {
            budget.cut.set(true);
        }
        for (_, _, dev) in candidates.into_iter().take(MAX_STATE_CANDIDATES) {
            reads.insert(dev.clone(), self.read_state(dev, accepted));
        }
        // Parmi les autres : d'abord ceux qui annoncent `pairedBy` = soi (association en cours), puis le plus récent `lastSyncHlc`.
        let mut others: Vec<&String> = listings.keys().filter(|dev| !protected.contains(dev.as_str())).collect();
        let state_of = |dev: &str| reads.get(dev).and_then(|r| r.state.as_ref());
        let pairing = |dev: &str| self_id.is_some() && state_of(dev).and_then(|s| s.paired_by.as_deref()) == self_id;
        let hlc_of = |dev: &str| state_of(dev).map(|s| s.last_sync_hlc.clone()).unwrap_or_default();
        others.sort_by(|a, b| pairing(b).cmp(&pairing(a)).then_with(|| hlc_of(b).cmp(&hlc_of(a))).then_with(|| a.cmp(b)));
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
            // Époques de soi et de keep déjà listées à l'étape 1a.
            if !protected.contains(dev.as_str()) {
                self.list_epochs(dev, &mut listing, &budget).map_err(fs_error)?;
            }
            total += listing.bytes - bytes_before;
            ignored += listing.ignored - ignored_before;
            let read = match reads.remove(dev) {
                Some(read) => read,
                None if listing.has_state() => self.read_state(dev, accepted),
                None => StateRead::status(None, StateStatus::Missing),
            };
            let (scan, cut) = self.scan_device(dev, &listing, read, accepted);
            incomplete |= cut;
            scans.push(scan);
        }
        Self::check_total(total)?;
        let folder_large = total > FOLDER_WARN_BYTES;
        if folder_large {
            log::event("folder-large", &total.to_string());
        }
        incomplete |= budget.cut.get();
        Ok(FolderScan {
            devices: scans,
            ignored: ignored + dropped,
            total_bytes: total,
            too_many_devices: dropped > 0,
            incomplete,
            folder_large,
            nonce_warning: false,
            forgotten: Default::default(),
            reset: None,
        })
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
        for (entry, name) in [(&listing.state, STATE_FILE), (&listing.next_state, STATE_NEXT_FILE)] {
            let Some(entry) = entry else { continue };
            // Y-11 : `state.next.ctx` n'est attendu que de l'appareil dont l'état présenté en vient (sinon une autre clé : jamais attendu).
            if name == STATE_NEXT_FILE && !read.from_next_file {
                continue;
            }
            if entry.availability != Availability::Local && read.status != StateStatus::Ok {
                push(&mut pending, &mut incomplete, name.to_owned(), entry.availability);
            }
            if self.pin && entry.availability != Availability::Error {
                self.pin_file(&[DEVICES_DIR, dev, name]);
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
        self.check_header(&file.header, kind, dev, epoch, n)?;
        Ok(file)
    }

    /// En-tête d'un fichier lu : `kid`, majeure et correspondance au chemin (mêmes règles pour la lecture complète et la lecture en flux).
    fn check_header(&self, header: &FileHeader, kind: HeaderKind, dev: &str, epoch: &str, n: u64) -> SyncResult<()> {
        if header.kid != self.key_for(epoch).kid() {
            return fail(SyncCode::KeyMismatch);
        }
        if header.sm > SYNC_FORMAT_MAJOR {
            return fail(SyncCode::NewerFormat);
        }
        if header.kind() != Some(kind) || header.dev != dev || header.e != epoch || header.n != n {
            return fail(SyncCode::BadHeader);
        }
        Ok(())
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
        // Y-TECH-02 (ADR 0011 §21 point 2) : nombre d'enregistrements annoncé de chaque segment clos (sans entrée : règle d'avant).
        let closed_count = |n: u64| if n < head.segment { state.closed.iter().find(|c| c.segment == n).map(|c| c.records) } else { None };
        'outer: loop {
            if (RecordCursor { segment, record }) >= head {
                break;
            }
            // Segment clos déjà lu jusqu'au nombre annoncé : segment suivant, sans lire le fichier (lignes en trop ignorées).
            if closed_count(segment).is_some_and(|c| record >= c) {
                segment += 1;
                record = 0;
                continue 'outer;
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
            let count = closed_count(segment);
            loop {
                if (RecordCursor { segment, record }) >= head {
                    break 'outer;
                }
                if count.is_some_and(|c| record >= c) {
                    segment += 1;
                    record = 0;
                    continue 'outer;
                }
                let Some(line) = file.lines.get(record as usize) else {
                    // Segment clos avec entrée : il en manque (version ancienne livrée par iCloud, troncature) → attente, jamais le suivant.
                    if count.is_none() && segment < head.segment && !file.partial_tail {
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
                let Ok(opened) = self.key_for(epoch).open(&Place::Journal { dev, epoch, segment: segment as u32, index: record }, line) else {
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
            let Ok(opened) = self.key_for(epoch).open(&Place::Snapshot { dev, epoch, seq: seq as u32, index }, line) else {
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

    /// `sync_read_snapshot` `tail` (§18 point 11) : dernier enregistrement seul de l'instantané **annoncé** (`seq` égal à celui de l'état
    /// authentifié, sinon `state-mismatch`) ; page `complete` à un enregistrement s'il se déchiffre, `cloud-pending` si la dernière ligne
    /// est incomplète ou absente (ou le fichier dans le nuage), `truncated` si elle ne se déchiffre pas. L'index de la ligne entre dans les
    /// données authentifiées (section 1.2) : les lignes sont comptées **en flux** (ADR 0011 §22 point 4, toutes plateformes) par
    /// `read_from`, blocs de 1 Mio, seule la dernière ligne complète gardée : mémoire bornée à un bloc et une ligne, quelle que soit la
    /// taille de l'instantané. `ends` garde le résultat par instantané (un numéro n'est jamais réécrit), pour ne lire chaque instantané
    /// qu'une fois par session ; le cache d'octets de la lecture par pages n'est plus rempli ici.
    pub fn read_snapshot_tail(
        &self,
        dev: &str,
        epoch: &str,
        seq: u64,
        accepted: &mut HashMap<String, Accepted>,
        ends: &mut HashMap<SnapshotEndKey, String>,
    ) -> SyncResult<ReadPage> {
        if !is_uuid_v4(dev) || !is_epoch_id(epoch) || !is_file_number(seq) {
            return fail(SyncCode::BadName);
        }
        let pending = ReadPage { records: Vec::new(), next: RecordCursor { segment: seq, record: 0 }, status: "cloud-pending" };
        let Some(state) = self.authenticated_state(dev, accepted)? else { return Ok(pending) };
        if state.epoch != epoch || state.snapshot.as_ref().map(|s| s.seq) != Some(seq) {
            return fail(SyncCode::StateMismatch);
        }
        let key = (self.key_for(epoch).kid().to_owned(), dev.to_owned(), epoch.to_owned(), seq);
        if let Some(json) = ends.get(&key) {
            return Ok(ReadPage { records: vec![json.clone()], next: RecordCursor { segment: seq, record: 0 }, status: "complete" });
        }
        let path = [DEVICES_DIR, dev, epoch, &snapshot_name(seq as u32)];
        let tail = match stream_last_line(self.fs, &path, MAX_SNAPSHOT_BYTES) {
            Ok(tail) => tail,
            Err(FsError::NotFound | FsError::CloudPending | FsError::ProviderStopped | FsError::CloudError) => return Ok(pending),
            Err(error) => return Err(fs_error(error)),
        };
        let header = match tail.header {
            StreamHeader::Partial => return Ok(pending),
            StreamHeader::Bad => return fail(SyncCode::BadHeader),
            StreamHeader::Ok(header) => header,
        };
        self.check_header(&header, HeaderKind::Snapshot, dev, epoch, seq)?;
        if tail.partial_tail || tail.lines == 0 {
            return Ok(pending);
        }
        let index = tail.lines - 1;
        let truncated = ReadPage { records: Vec::new(), next: RecordCursor { segment: seq, record: index }, status: "truncated" };
        let Some(line) = tail.last.as_deref().and_then(line_str) else { return Ok(truncated) };
        let Ok(opened) = self.key_for(epoch).open(&Place::Snapshot { dev, epoch, seq: seq as u32, index }, line) else { return Ok(truncated) };
        ends.insert(key, opened.json.clone());
        Ok(ReadPage { records: vec![opened.json], next: RecordCursor { segment: seq, record: index + 1 }, status: "complete" })
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
                if h.kind() != Some(HeaderKind::Journal) || h.dev != self_id || h.e != epoch || h.n != segment || h.kid != self.key_for(epoch).kid() {
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
        let key = self.key_for(epoch);
        let mut out = String::with_capacity(add_bytes as usize + 256);
        if existing.is_none() {
            out.push_str(&FileHeader::new(HeaderKind::Journal, key.kid(), self_id, epoch, segment).line());
            out.push('\n');
        }
        for (i, text) in records.iter().enumerate() {
            let place = Place::Journal { dev: self_id, epoch, segment: segment32, index: first_record + i as u64 };
            out.push_str(&key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, sv32).map_err(|_| SyncError::new(SyncCode::Io))?);
            out.push('\n');
        }
        self.fs.create_dir(&[DEVICES_DIR, self_id, epoch]).map_err(fs_error)?;
        let mode = if existing.is_some() { AppendMode::Existing } else { AppendMode::CreateNew };
        self.fs.append(&path, out.as_bytes(), mode).map_err(|e| match e {
            FsError::Exists => SyncError::new(SyncCode::SegmentMismatch),
            other => fs_error(other),
        })?;
        usage.sealed += records.len() as u64;
        // Y-TECH-02 (§21 point 2) : un ajout qui ouvre un segment plus grand dans la même époque ferme celui de la tête, avec ce que l'état
        // a pu en annoncer (`own.record`, jamais le nombre de lignes du fichier) ; une nouvelle époque repart d'une liste vide.
        if same_epoch && segment > own.segment && own.segment >= 1 && own.record > 0 {
            let (closed_segment, closed_records) = (own.segment, own.record);
            own.close_segment(closed_segment, closed_records);
        }
        if !same_epoch {
            own.closed.clear();
        }
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
        // Rust est maître de `pairedBy` (Y-06) : omis par le moteur, il est complété depuis `own.json` (clé importée par QR) ; une
        // valeur différente reste refusée plus bas.
        let completed;
        let state = if state.paired_by.is_none() && own.paired_by.is_some() {
            completed = PublishedState { paired_by: own.paired_by.clone(), ..state.clone() };
            &completed
        } else {
            state
        };
        // Y-TECH-02 (§21 point 2) : Rust est maître de `closed` : omis → complété depuis `own.json` (même époque) ; fourni → égal, sinon refus.
        let own_closed: &[super::state::ClosedSegment] = if own.epoch.as_deref() == Some(state.epoch.as_str()) { &own.closed } else { &[] };
        if !state.closed.is_empty() && state.closed != own_closed {
            log::event("write-state-refused", "closed");
            return fail(SyncCode::StateMismatch);
        }
        let with_closed;
        let state = if state.closed.is_empty() && !own_closed.is_empty() {
            with_closed = PublishedState { closed: own_closed.to_vec(), ..state.clone() };
            &with_closed
        } else {
            state
        };
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
        // `forgotten` (Y-10) et `reset` (Y-11) : comparés à ce que Rust sait par l'appelant (`SyncCore::write_state`).
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
        // Y-11 : l'état de l'époque visée par une réinitialisation va dans `state.next.ctx`, sous la nouvelle clé (§14.3 étape 4).
        let (file_name, key) = self.state_target(&state.epoch);
        let place = Place::State { dev: self_id, epoch: &state.epoch, state_seq: state.state_seq };
        let line = key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, sv as u32).map_err(|_| SyncError::new(SyncCode::Io))?;
        let header = FileHeader::new(HeaderKind::State, key.kid(), self_id, &state.epoch, state.state_seq).line();
        self.fs.create_dir(&device_dir(self_id)).map_err(fs_error)?;
        self.fs.write_atomic(&[DEVICES_DIR, self_id, file_name], format!("{header}\n{line}\n").as_bytes()).map_err(fs_error)?;
        usage.sealed += 1;
        if own.epoch.as_deref() != Some(state.epoch.as_str()) {
            own.epoch = Some(state.epoch.clone());
            own.segment = 0;
            own.record = 0;
            own.max_hlc = None;
            own.closed.clear();
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
        let header = format!("{}\n", FileHeader::new(HeaderKind::Snapshot, self.key_for(epoch).kid(), self_id, epoch, seq).line());
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
        let key = self.key_for(&writer.epoch);
        let mut out = String::new();
        for (i, text) in records.iter().enumerate() {
            let place = Place::Snapshot { dev: &writer.dev, epoch: &writer.epoch, seq: writer.seq, index: writer.records + i as u64 };
            out.push_str(&key.seal(&place, text.as_bytes(), SYNC_FORMAT_MAJOR, writer.sv).map_err(|_| SyncError::new(SyncCode::Io))?);
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
    pub fn delete_own(&self, own: &mut OwnState, self_id: &str, files: &[OwnFileRef]) -> SyncResult<u64> {
        for file in files {
            let valid_kind = matches!(file.kind.as_str(), "j" | "s" | "epoch");
            let valid_n = if file.kind == "epoch" { file.n.is_none() } else { file.n.is_some_and(is_file_number) };
            if !is_epoch_id(&file.epoch) || !valid_kind || !valid_n {
                return fail(SyncCode::BadName);
            }
            let current = own.epoch.as_deref() == Some(file.epoch.as_str());
            // Y-IOS-02 : époque orpheline (ouverte, ni état ni enregistrement jamais écrits) : supprimable ; `own.json` revient sans époque.
            let orphan = own.state_seq == 0 && own.segment == 0 && own.record == 0;
            if current && ((file.kind == "epoch" && !orphan) || (file.kind == "j" && file.n == Some(own.segment))) {
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
                    if own.epoch.as_deref() == Some(epoch) {
                        own.epoch = None;
                        own.max_hlc = None;
                    }
                }
                (kind, Some(n)) => {
                    let name = if kind == "j" { segment_name(n as u32) } else { snapshot_name(n as u32) };
                    if self.fs.remove_file(&[DEVICES_DIR, self_id, epoch, &name]).map_err(fs_error)? {
                        deleted += 1;
                    }
                    // Y-TECH-02 : l'entrée `closed` d'un segment supprimé de l'époque courante est retirée (partie avec l'état suivant).
                    if kind == "j" && own.epoch.as_deref() == Some(epoch) {
                        own.closed.retain(|c| c.segment != n);
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
            // Y-11 : la nouvelle clé d'une réinitialisation en cours n'est encore portée que par des `state.next.ctx`.
            for name in [STATE_FILE, STATE_NEXT_FILE] {
                let Ok(bytes) = fs.read(&[DEVICES_DIR, &dev.name, name], MAX_STATE_FILE_BYTES, true) else { continue };
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
                        let newer = check.epoch.as_deref().and_then(EpochId::parse).map_or(true, |e| EpochId::parse(&h.e).is_some_and(|f| f > e));
                        if newer {
                            check.epoch = Some(h.e.clone());
                        }
                    }
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
        // Son propre dossier d'abord (budget réservé, audit A1).
        let mut listing = self.list_device_top(self_id, &budget).map_err(fs_error)?;
        self.list_epochs(self_id, &mut listing, &budget).map_err(fs_error)?;
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
        // Son état est en transfert (dans le nuage, ligne incomplète) et rien ne borne : on attend, rien n'est retenu (revue 4).
        if mine.status == StateStatus::CloudPending && acks.is_empty() {
            log::event("own-rebuild-pending", mine.status.as_str());
            return fail(SyncCode::CloudPending);
        }
        // Son état vient d'une version plus récente du format : jamais réécrit par cette version (Y-07, « Mettez à jour l'app »).
        if mine.status == StateStatus::NewerFormat {
            log::event("own-rebuild-pending", mine.status.as_str());
            return fail(SyncCode::NewerFormat);
        }
        // Son état est remplacé ou illisible (étranger, corrompu, rejeu, trop grand) : reconstruction sans lui, `stateSeq` au moins égal
        // à l'état déjà accepté et au numéro lu en clair dans l'en-tête du fichier remplacé, pour pouvoir le réécrire aussitôt (§1.4,
        // revue B1). Ce numéro n'est pas authentifié : pris en compte seulement s'il dépasse d'au plus 1 000 000 le plus grand numéro
        // des sources authentifiées (accusés, état accepté) ; au-delà, un tiers pourrait l'approcher de 2^53 et interdire toute
        // réécriture : il est ignoré.
        let mut replaced_seq = 0;
        if !matches!(mine.status, StateStatus::Ok | StateStatus::Missing | StateStatus::CloudPending) {
            let authenticated = acks.iter().map(|a| a.state_seq).chain(accepted.get(self_id).map(|a| a.seq)).max().unwrap_or(0);
            replaced_seq = authenticated;
            if let Some(h) = self.fs.read_head(&[DEVICES_DIR, self_id, STATE_FILE], MAX_HEADER_BYTES + 1).ok().and_then(|head| header_of(&head)) {
                if h.kind() == Some(HeaderKind::State) && h.dev == self_id {
                    if h.n <= authenticated.saturating_add(MAX_UNAUTHENTICATED_SEQ_JUMP) {
                        replaced_seq = replaced_seq.max(h.n);
                    } else {
                        log::event("own-state-seq-ignored", "jump");
                    }
                }
            }
            log::event("own-state-replaced", mine.status.as_str());
        }
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
        let state_seq = acks.iter().map(|a| a.state_seq).chain(state.iter().map(|s| s.state_seq)).max().unwrap_or(0).max(replaced_seq);
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
        // Y-TECH-02 (§21 point 2) : entrées `closed` de son seul état authentifié de la même époque, sous la tête reconstruite, qu'aucun
        // accusé authentifié sur soi ne dépasse dans ce segment ; aucune autre entrée n'est inventée (en cas de doute : règle d'avant).
        if let Some(s) = state.as_ref().filter(|s| s.epoch == epoch_name) {
            own.closed = s
                .closed
                .iter()
                .filter(|c| c.segment < head.segment && !acks.iter().any(|a| a.epoch == epoch_name && a.segment == c.segment && a.record > c.records))
                .copied()
                .collect();
        }
        own.epoch = Some(epoch_name);
        own.segment = head.segment;
        own.record = head.record;
        own.max_hlc = max_hlc;
        Ok(own)
    }
}

/// Résultat de `folder_kids`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KidCheck {
    pub readable: usize,
    pub decrypts: bool,
    /// Y-11 : plus grande époque d'un état qui se déchiffre avec la clé candidate (époque visée d'une réinitialisation).
    pub epoch: Option<String>,
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
