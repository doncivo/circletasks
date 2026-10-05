//! Noms stricts du dossier de synchronisation (ADR 0011 section 1.1, audit B5). Mêmes expressions que `src/domain/sync/format.ts`.
//!
//! Tout nom de fichier ou paramètre de chemin est validé ici avant toute construction de chemin. Un nom non strict (copie de
//! conflit iCloud « state 2.ctx », `*.tmp`, `state.next.ctx` réservé, fichier étranger) est ignoré, jamais lu ni supprimé.

use std::cmp::Ordering;

pub const DEVICES_DIR: &str = "devices";
pub const STATE_FILE: &str = "state.ctx";
/// Réservé à la transition de Y-11 (section 14.3) : jamais écrit ni lu avant le lot Y4.
pub const STATE_NEXT_FILE: &str = "state.next.ctx";
pub const TEMP_SUFFIX: &str = ".tmp";

pub const MAX_EPOCH_NUMBER: u32 = 9_999;
pub const MAX_FILE_NUMBER: u32 = 99_999_999;

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `device_id` : UUID v4 en minuscules (`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`).
pub fn is_uuid_v4(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => c == b'4',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => is_lower_hex(c),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// `kid` : 16 caractères hexadécimaux minuscules.
pub fn is_kid(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(is_lower_hex)
}

/// hlc strict (ADR 0005) : `<15 chiffres>-<4 hexa>-<uuid v4>`.
pub fn is_strict_hlc(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 15 + 1 + 4 + 1 + 36
        && b[..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'-'
        && b[16..20].iter().all(|&c| is_lower_hex(c))
        && b[20] == b'-'
        && is_uuid_v4(&value[21..])
}

/// Époque `e<4 chiffres>-<uuid>` (numéro ≥ 1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EpochId {
    pub n: u32,
    pub opener: String,
}

impl EpochId {
    pub fn parse(value: &str) -> Option<Self> {
        let b = value.as_bytes();
        if b.len() != 1 + 4 + 1 + 36 || b[0] != b'e' || b[5] != b'-' || !b[1..5].iter().all(u8::is_ascii_digit) {
            return None;
        }
        let n: u32 = value[1..5].parse().ok()?;
        let opener = &value[6..];
        (n >= 1 && is_uuid_v4(opener)).then(|| Self { n, opener: opener.to_owned() })
    }

    pub fn name(&self) -> String {
        format!("e{:04}-{}", self.n, self.opener)
    }
}

impl Ord for EpochId {
    /// Ordre des époques (section 9) : numéro, puis UUID de l'ouvreur.
    fn cmp(&self, other: &Self) -> Ordering {
        self.n.cmp(&other.n).then_with(|| self.opener.cmp(&other.opener))
    }
}

impl PartialOrd for EpochId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn is_epoch_id(value: &str) -> bool {
    EpochId::parse(value).is_some()
}

pub fn is_file_number(n: u64) -> bool {
    (1..=u64::from(MAX_FILE_NUMBER)).contains(&n)
}

pub fn segment_name(n: u32) -> String {
    format!("j-{n:08}.ctj")
}

pub fn snapshot_name(n: u32) -> String {
    format!("s-{n:08}.cts")
}

/// Fichier reconnu dans un dossier d'appareil ou d'époque.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncFileName {
    State,
    Segment(u32),
    Snapshot(u32),
}

fn numbered(name: &str, prefix: &str, suffix: &str) -> Option<u32> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if digits.len() != 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    is_file_number(u64::from(n)).then_some(n)
}

/// Nom strict, sinon `None` (ignoré).
pub fn parse_file_name(name: &str) -> Option<SyncFileName> {
    if name == STATE_FILE {
        return Some(SyncFileName::State);
    }
    if let Some(n) = numbered(name, "j-", ".ctj") {
        return Some(SyncFileName::Segment(n));
    }
    numbered(name, "s-", ".cts").map(SyncFileName::Snapshot)
}

/// Version de l'app publiée : `[0-9A-Za-z.+-]{1,64}`.
pub fn is_app_version(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}
