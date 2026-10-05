//! Chiffrement de la synchronisation (ADR 0011, sections 1.2 et 2 ; Y-08).
//!
//! - Clé maîtresse `K` : 32 octets de `SystemRandom`, gardée dans un `Zeroizing`, sans `Debug` ni `Serialize`.
//! - `K_rec = HKDF-SHA256(K, sel "circletasks", info "ct/1 records")` chiffre tous les fichiers ; `kid = hex(HKDF(K, info "ct/1 kid")[0..8])`.
//! - AES-256-GCM par `RandomizedNonceKey` : le nonce de 96 bits est tiré par la bibliothèque, jamais fourni par ce code.
//! - Ligne `<sm>.<sv>.<base64url(nonce ‖ texte chiffré ‖ étiquette)>` ; texte clair bourré `u32 ‖ JSON ‖ zéros` au multiple de 4 Kio ;
//!   AAD = champs préfixés par leur longueur (u16 gros-boutiste), reconstruite par le lecteur depuis le chemin et la position.
//! - Clé de secours (base32 Crockford, `CT1-`, somme de contrôle) et texte du QR (`CTPAIR1.`) : codage et décodage en Rust seulement.
//!
//! Aucune fonction de ce module ne journalise ni ne renvoie dans une erreur une clé, un texte clair ou une entrée reçue.

use aws_lc_rs::aead::{self, Aad, Nonce, RandomizedNonceKey, AES_256_GCM};
use aws_lc_rs::{digest, hkdf, rand};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::limits::{
    padded_plaintext_bytes, MAX_HEADER_BYTES, MAX_PADDED_PLAINTEXT_BYTES, MAX_RECORD_LINE_BYTES, MAX_RECORD_PLAINTEXT_BYTES, NONCE_BYTES,
    PADDING_BLOCK_BYTES, PADDING_LENGTH_PREFIX_BYTES, TAG_BYTES,
};
use super::names::{is_epoch_id, is_file_number, is_kid, is_uuid_v4};

/// Version majeure du format (`sm`), égale à `SYNC_FORMAT_MAJOR` de `format.ts`.
pub const SYNC_FORMAT_MAJOR: u32 = 1;
/// Préfixe de version des AAD.
pub const AAD_VERSION: &str = "ct/1";
pub const KEY_BYTES: usize = 32;
pub const HKDF_SALT: &[u8] = b"circletasks";
pub const HKDF_INFO_RECORDS: &[u8] = b"ct/1 records";
pub const HKDF_INFO_KID: &[u8] = b"ct/1 kid";
pub const PAIRING_QR_PREFIX: &str = "CTPAIR1.";
pub const RECOVERY_KEY_PREFIX: &str = "CT1-";
/// Longueur maximale acceptée d'un texte de QR.
pub const MAX_QR_TEXT_BYTES: usize = 1024;

/// Échec d'une opération cryptographique (sans détail : rien de l'entrée n'est recopié).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Générateur aléatoire ou bibliothèque indisponible.
    Unavailable,
    /// Texte clair trop long (256 Kio au plus).
    TooLarge,
}

/// Échec d'ouverture d'une ligne.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// Ligne trop longue ou de forme invalide (préfixe, base64, longueur) : corruption, jamais décodée au-delà.
    Malformed,
    /// Étiquette, AAD, clé, bourrage ou UTF-8 refusés.
    Decrypt,
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_expand(key: &[u8; KEY_BYTES], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, HKDF_SALT).extract(key);
    let info = [info];
    prk.expand(&info, Len(out.len())).and_then(|okm| okm.fill(out)).map_err(|_| CryptoError::Unavailable)
}

/// Clé maîtresse `K` et ses dérivées. Volontairement sans `Debug`, `Clone` ni `Serialize` (test de compilation).
pub struct MasterKey {
    raw: Zeroizing<[u8; KEY_BYTES]>,
    record: RandomizedNonceKey,
    kid: String,
}

impl MasterKey {
    /// Nouvelle clé de 32 octets aléatoires (`SystemRandom`).
    pub fn generate() -> Result<Self, CryptoError> {
        let mut raw = Zeroizing::new([0u8; KEY_BYTES]);
        rand::fill(raw.as_mut()).map_err(|_| CryptoError::Unavailable)?;
        Self::from_raw(raw)
    }

    /// Clé à partir de 32 octets (import, coffre) ; `None` si la longueur est fausse.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        let raw: [u8; KEY_BYTES] = bytes.try_into().ok()?;
        Self::from_raw(Zeroizing::new(raw)).ok()
    }

    fn from_raw(raw: Zeroizing<[u8; KEY_BYTES]>) -> Result<Self, CryptoError> {
        let mut record = Zeroizing::new([0u8; KEY_BYTES]);
        hkdf_expand(&raw, HKDF_INFO_RECORDS, record.as_mut())?;
        let mut kid = Zeroizing::new([0u8; 8]);
        hkdf_expand(&raw, HKDF_INFO_KID, kid.as_mut())?;
        let record = RandomizedNonceKey::new(&AES_256_GCM, record.as_ref()).map_err(|_| CryptoError::Unavailable)?;
        Ok(Self { raw, record, kid: hex(kid.as_ref()) })
    }

    /// `kid` : 16 caractères hexadécimaux, ne révèle rien de `K`.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// Valeur gardée au coffre : `K` en base64 (standard).
    pub fn to_vault_value(&self) -> Zeroizing<String> {
        Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(self.raw.as_ref()))
    }

    /// Lecture de la valeur du coffre ; `None` si elle n'est pas une clé de 32 octets en base64.
    pub fn from_vault_value(value: &str) -> Option<Self> {
        let bytes = Zeroizing::new(base64::engine::general_purpose::STANDARD.decode(value.trim()).ok()?);
        Self::from_bytes(&bytes)
    }

    /// Même clé (comparaison sur les octets, en temps constant).
    pub fn same_as(&self, other: &MasterKey) -> bool {
        let mut diff = 0u8;
        for (a, b) in self.raw.iter().zip(other.raw.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    /// Octets de `K` (QR, clé de secours) : à garder dans un `Zeroizing` par l'appelant.
    pub(crate) fn raw(&self) -> &[u8; KEY_BYTES] {
        &self.raw
    }

    /// Clé de secours imprimable : `K ‖ SHA-256(K)[0..2]` en base32 Crockford, groupes de 5, préfixe `CT1-`.
    pub fn recovery_key(&self) -> Zeroizing<String> {
        recovery_key_of(&self.raw)
    }

    /// Chiffre un texte clair JSON à sa place. Renvoie la ligne, sans `\n`.
    pub fn seal(&self, place: &Place<'_>, json: &[u8], sm: u32, sv: u32) -> Result<String, CryptoError> {
        if json.len() > MAX_RECORD_PLAINTEXT_BYTES {
            return Err(CryptoError::TooLarge);
        }
        let mut in_out = pad(json);
        let aad = aad_bytes(&place.aad_fields(sm, sv));
        let nonce = self.record.seal_in_place_append_tag(Aad::from(aad.as_slice()), &mut *in_out).map_err(|_| CryptoError::Unavailable)?;
        let mut payload = Vec::with_capacity(NONCE_BYTES + in_out.len());
        payload.extend_from_slice(nonce.as_ref());
        payload.extend_from_slice(&in_out);
        Ok(format!("{sm}.{sv}.{}", URL_SAFE_NO_PAD.encode(&payload)))
    }

    /// Ouvre une ligne (sans `\n`) à sa place : longueur contrôlée avant le base64, AAD reconstruite, bourrage vérifié.
    pub fn open(&self, place: &Place<'_>, line: &str) -> Result<Opened, OpenError> {
        let prefix = parse_line_prefix(line).ok_or(OpenError::Malformed)?;
        let mut payload = Zeroizing::new(URL_SAFE_NO_PAD.decode(prefix.payload).map_err(|_| OpenError::Malformed)?);
        if payload.len() < NONCE_BYTES + TAG_BYTES {
            return Err(OpenError::Malformed);
        }
        let nonce = Nonce::try_assume_unique_for_key(&payload[..NONCE_BYTES]).map_err(|_| OpenError::Malformed)?;
        let aad = aad_bytes(&place.aad_fields(prefix.sm, prefix.sv));
        let plain = self.record.open_in_place(nonce, Aad::from(aad.as_slice()), &mut payload[NONCE_BYTES..]).map_err(|_| OpenError::Decrypt)?;
        let json = unpad(plain).ok_or(OpenError::Decrypt)?;
        let text = std::str::from_utf8(json).map_err(|_| OpenError::Decrypt)?.to_owned();
        Ok(Opened { sm: prefix.sm, sv: prefix.sv, json: text })
    }
}

/// Ligne ouverte : `sm`, `sv` (lus en clair, authentifiés par l'AAD) et texte clair JSON.
#[derive(Clone, PartialEq, Eq)]
pub struct Opened {
    pub sm: u32,
    pub sv: u32,
    pub json: String,
}

/// Place d'un enregistrement (AAD) : journal, instantané ou état.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place<'a> {
    Journal { dev: &'a str, epoch: &'a str, segment: u32, index: u64 },
    Snapshot { dev: &'a str, epoch: &'a str, seq: u32, index: u64 },
    State { dev: &'a str, epoch: &'a str, state_seq: u64 },
}

impl Place<'_> {
    /// Champs de l'AAD dans l'ordre de la section 2.
    pub fn aad_fields(&self, sm: u32, sv: u32) -> Vec<String> {
        match *self {
            Place::Journal { dev, epoch, segment, index } => {
                vec![AAD_VERSION.into(), "j".into(), dev.into(), epoch.into(), segment.to_string(), index.to_string(), sm.to_string(), sv.to_string()]
            }
            Place::Snapshot { dev, epoch, seq, index } => {
                vec![AAD_VERSION.into(), "s".into(), dev.into(), epoch.into(), seq.to_string(), index.to_string(), sm.to_string(), sv.to_string()]
            }
            Place::State { dev, epoch, state_seq } => {
                vec![AAD_VERSION.into(), "state".into(), dev.into(), epoch.into(), state_seq.to_string(), sm.to_string(), sv.to_string()]
            }
        }
    }
}

/// Chaque champ préfixé par sa longueur (u16 gros-boutiste), puis ses octets UTF-8.
pub fn aad_bytes(fields: &[String]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.iter().map(|f| f.len() + 2).sum());
    for field in fields {
        let len = u16::try_from(field.len()).unwrap_or(u16::MAX);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&field.as_bytes()[..usize::from(len)]);
    }
    out
}

/// `longueur (u32 gros-boutiste) ‖ JSON ‖ zéros` au multiple de 4 Kio supérieur (4 Kio au minimum).
pub fn pad(json: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(vec![0u8; padded_plaintext_bytes(json.len())]);
    out[..PADDING_LENGTH_PREFIX_BYTES].copy_from_slice(&(json.len() as u32).to_be_bytes());
    out[PADDING_LENGTH_PREFIX_BYTES..PADDING_LENGTH_PREFIX_BYTES + json.len()].copy_from_slice(json);
    out
}

/// Longueur annoncée, taille bourrée et nullité du bourrage contrôlées ; `None` : corruption.
pub fn unpad(padded: &[u8]) -> Option<&[u8]> {
    let head: [u8; 4] = padded.get(..PADDING_LENGTH_PREFIX_BYTES)?.try_into().ok()?;
    let length = u32::from_be_bytes(head) as usize;
    if length > padded.len() - PADDING_LENGTH_PREFIX_BYTES || padded_plaintext_bytes(length) != padded.len() {
        return None;
    }
    let end = PADDING_LENGTH_PREFIX_BYTES + length;
    padded[end..].iter().all(|&b| b == 0).then(|| &padded[PADDING_LENGTH_PREFIX_BYTES..end])
}

/// Préfixe d'une ligne chiffrée, lu avant tout déchiffrement (Y-07).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinePrefix<'a> {
    pub sm: u32,
    pub sv: u32,
    pub payload: &'a str,
}

fn canonical_number(text: &str) -> Option<u32> {
    let b = text.as_bytes();
    if b.is_empty() || b.len() > 6 || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    text.parse().ok()
}

/// Longueur base64url compatible avec `nonce ‖ multiple non nul de 4 Kio ‖ étiquette`.
pub fn is_sealed_payload_length(chars: usize) -> bool {
    if chars == 0 || chars % 4 == 1 {
        return false;
    }
    let bytes = chars * 3 / 4;
    let Some(padded) = bytes.checked_sub(NONCE_BYTES + TAG_BYTES) else { return false };
    padded >= PADDING_BLOCK_BYTES && padded % PADDING_BLOCK_BYTES == 0 && padded <= MAX_PADDED_PLAINTEXT_BYTES
}

/// `<sm>.<sv>.<base64url>` : longueur contrôlée d'abord, entiers canoniques, alphabet et longueur du base64.
pub fn parse_line_prefix(line: &str) -> Option<LinePrefix<'_>> {
    if line.len() > MAX_RECORD_LINE_BYTES {
        return None;
    }
    let mut parts = line.splitn(3, '.');
    let sm = canonical_number(parts.next()?)?;
    let sv = canonical_number(parts.next()?)?;
    let payload = parts.next()?;
    let alphabet = payload.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (alphabet && is_sealed_payload_length(payload.len())).then_some(LinePrefix { sm, sv, payload })
}

// ------------------------------------------------------------------------------------------------------------------------------
// En-tête en clair (section 1.2)
// ------------------------------------------------------------------------------------------------------------------------------

/// Nature d'un fichier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderKind {
    Journal,
    Snapshot,
    State,
}

impl HeaderKind {
    pub fn tag(self) -> &'static str {
        match self {
            HeaderKind::Journal => "ct-j",
            HeaderKind::Snapshot => "ct-s",
            HeaderKind::State => "ct-state",
        }
    }
}

/// En-tête JSON de la ligne 1 : exactement six clés, dans l'ordre `f`, `sm`, `kid`, `dev`, `e`, `n` à l'écriture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileHeader {
    pub f: String,
    pub sm: u32,
    pub kid: String,
    pub dev: String,
    pub e: String,
    pub n: u64,
}

impl FileHeader {
    pub fn new(kind: HeaderKind, kid: &str, dev: &str, epoch: &str, n: u64) -> Self {
        Self { f: kind.tag().to_owned(), sm: SYNC_FORMAT_MAJOR, kid: kid.to_owned(), dev: dev.to_owned(), e: epoch.to_owned(), n }
    }

    pub fn kind(&self) -> Option<HeaderKind> {
        match self.f.as_str() {
            "ct-j" => Some(HeaderKind::Journal),
            "ct-s" => Some(HeaderKind::Snapshot),
            "ct-state" => Some(HeaderKind::State),
            _ => None,
        }
    }

    /// Ligne d'en-tête, sans `\n`.
    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Analyse stricte (1 Kio au plus, clés exactes, types et expressions) ; `None` : `bad-header`.
    pub fn parse(line: &[u8]) -> Option<Self> {
        if line.len() > MAX_HEADER_BYTES {
            return None;
        }
        let header: FileHeader = serde_json::from_slice(line).ok()?;
        let kind = header.kind()?;
        let n_ok = match kind {
            HeaderKind::State => header.n >= 1 && header.n < (1u64 << 53),
            _ => is_file_number(header.n),
        };
        (header.sm >= 1 && is_kid(&header.kid) && is_uuid_v4(&header.dev) && is_epoch_id(&header.e) && n_ok).then_some(header)
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Clé de secours (section 2)
// ------------------------------------------------------------------------------------------------------------------------------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_BYTES: usize = KEY_BYTES + 2;
/// 55 caractères utiles.
pub const RECOVERY_CHARS: usize = (RECOVERY_BYTES * 8).div_ceil(5);

fn sha256(bytes: &[u8]) -> digest::Digest {
    digest::digest(&digest::SHA256, bytes)
}

fn recovery_key_of(key: &[u8; KEY_BYTES]) -> Zeroizing<String> {
    let mut data = Zeroizing::new([0u8; RECOVERY_BYTES]);
    data[..KEY_BYTES].copy_from_slice(key);
    data[KEY_BYTES..].copy_from_slice(&sha256(key).as_ref()[..2]);
    let mut chars = Zeroizing::new(String::with_capacity(RECOVERY_CHARS));
    let (mut bits, mut value) = (0u32, 0u32);
    for &byte in data.iter() {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            chars.push(char::from(CROCKFORD[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        chars.push(char::from(CROCKFORD[((value << (5 - bits)) & 31) as usize]));
    }
    let mut out = Zeroizing::new(String::with_capacity(RECOVERY_KEY_PREFIX.len() + RECOVERY_CHARS + 11));
    out.push_str(RECOVERY_KEY_PREFIX);
    for (i, c) in chars.chars().enumerate() {
        if i > 0 && i % 5 == 0 {
            out.push('-');
        }
        out.push(c);
    }
    out
}

/// Décodage tolérant (casse, espaces, tirets, `O`/`0`, `I`/`L`/`1`) et contrôle de la somme ; `None` : `invalid-pairing`.
pub fn key_from_recovery(input: &str) -> Option<MasterKey> {
    if input.len() > 256 {
        return None;
    }
    let mut text = Zeroizing::new(String::with_capacity(input.len()));
    for c in input.chars() {
        match c.to_ascii_uppercase() {
            ' ' | '\t' | '\n' | '\r' | '-' => {}
            'O' => text.push('0'),
            'I' | 'L' => text.push('1'),
            other => text.push(other),
        }
    }
    let prefix = RECOVERY_KEY_PREFIX.trim_end_matches('-');
    let body: &str = if text.len() == RECOVERY_CHARS + prefix.len() && text.starts_with(prefix) { &text[prefix.len()..] } else { &text };
    if body.len() != RECOVERY_CHARS {
        return None;
    }
    let mut data = Zeroizing::new([0u8; RECOVERY_BYTES]);
    let (mut bits, mut value, mut index) = (0u32, 0u32, 0usize);
    for c in body.bytes() {
        let digit = CROCKFORD.iter().position(|&d| d == c)? as u32;
        value = (value << 5) | digit;
        bits += 5;
        if bits >= 8 {
            if index < RECOVERY_BYTES {
                data[index] = ((value >> (bits - 8)) & 0xff) as u8;
            }
            index += 1;
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    if value != 0 {
        return None;
    }
    let digest = sha256(&data[..KEY_BYTES]);
    if digest.as_ref()[..2] != data[KEY_BYTES..] {
        return None;
    }
    MasterKey::from_bytes(&data[..KEY_BYTES])
}

// ------------------------------------------------------------------------------------------------------------------------------
// Texte du QR (section 10.3)
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct QrPayload {
    v: u8,
    k: String,
    d: String,
    e: Option<String>,
    x: u64,
}

impl Drop for QrPayload {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.k);
    }
}

/// Contenu d'un QR analysé (sans `Debug` : il porte la clé).
pub struct QrContent {
    pub key: MasterKey,
    pub device_id: String,
    pub epoch: Option<String>,
    pub expires_at: u64,
}

/// `CTPAIR1.<base64url(JSON { v:1, k, d, e, x })>`.
pub fn qr_text_of(key: &MasterKey, device_id: &str, epoch: Option<&str>, expires_at: u64) -> Zeroizing<String> {
    let payload = QrPayload { v: 1, k: URL_SAFE_NO_PAD.encode(key.raw()), d: device_id.to_owned(), e: epoch.map(str::to_owned), x: expires_at };
    let json = Zeroizing::new(serde_json::to_string(&payload).unwrap_or_default());
    Zeroizing::new(format!("{PAIRING_QR_PREFIX}{}", URL_SAFE_NO_PAD.encode(json.as_bytes())))
}

/// Analyse stricte du texte du QR ; `None` : `invalid-pairing`.
pub fn parse_qr_text(text: &str) -> Option<QrContent> {
    if text.len() > MAX_QR_TEXT_BYTES {
        return None;
    }
    let encoded = text.strip_prefix(PAIRING_QR_PREFIX)?;
    let json = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).ok()?);
    // Clés exactes (la clé `e` doit être présente, même nulle) ; une clé répétée ou inconnue est refusée par serde.
    let keys: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&json).ok()?;
    let mut names: Vec<&str> = keys.keys().map(String::as_str).collect();
    names.sort_unstable();
    if names != ["d", "e", "k", "v", "x"] {
        return None;
    }
    drop(keys);
    let payload: QrPayload = serde_json::from_slice(&json).ok()?;
    if payload.v != 1 || !is_uuid_v4(&payload.d) || payload.x > (1u64 << 53) - 1 {
        return None;
    }
    if payload.e.as_deref().is_some_and(|e| !is_epoch_id(e)) {
        return None;
    }
    let raw = Zeroizing::new(URL_SAFE_NO_PAD.decode(&payload.k).ok()?);
    let key = MasterKey::from_bytes(&raw)?;
    Some(QrContent { key, device_id: payload.d.clone(), epoch: payload.e.clone(), expires_at: payload.x })
}

/// Hexadécimal minuscule.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Condensé SHA-256 en hexadécimal (anti-rejeu, identifiant de dossier).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(sha256(bytes).as_ref())
}

/// Garde-fou de `aead` : l'algorithme a bien un nonce de 96 bits et une étiquette de 128 bits.
pub fn algorithm_shape() -> (usize, usize) {
    (aead::AES_256_GCM.nonce_len(), aead::AES_256_GCM.tag_len())
}
