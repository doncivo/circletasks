//! Règles d'export communes au PC et à l'iPhone (H-03, FILES-IOS-01, ADR 0009 avenant lot F point A3) : taille, nom proposé, extension et
//! type MIME. Sans `cfg` : `export.rs` (PC) les réexporte, `export_ios.rs` (iPhone) les applique avant d'écrire le fichier temporaire.
//!
//! Les erreurs sont des **codes** stables (jamais un message ni un chemin vers la WebView).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};

/// En-tête portant le nom proposé, encodé en base64 (UTF-8) : un en-tête HTTP ne contient pas d'accents.
pub const NAME_HEADER: &str = "x-file-name";
/// Taille maximale d'un export (64 Mio) : au-delà, la commande refuse avant toute autre opération.
pub const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
/// Longueur maximale de l'en-tête du nom (caractères, avant décodage).
pub const MAX_HEADER_LEN: usize = 1024;
/// Longueur maximale du nom de fichier proposé (extension comprise).
pub const MAX_NAME_LEN: usize = 200;
/// Extensions des formats exportés : CSV, JSON, PDF, image (H-03) et texte (logs d'I-04, PC compris).
pub const ALLOWED_EXTENSIONS: [&str; 5] = ["csv", "json", "pdf", "png", "txt"];

const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Extension autorisée d'un nom (minuscules), ou None.
pub fn allowed_extension(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// Type MIME d'une extension autorisée (dérivé par Rust, jamais repris de la requête) ; `application/octet-stream` sinon.
pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Nom de fichier proposé, réduit à un nom simple : sans dossier, sans caractère interdit sous Windows, sans espaces ni points
/// finaux, au plus 200 caractères (extension conservée), préfixé de `_` s'il s'agit d'un nom réservé (CON, NUL, COM1…).
pub fn sanitize_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control()).collect();
    let mut name = cleaned.trim_start().trim_end_matches([' ', '.']).to_string();
    if name.chars().count() > MAX_NAME_LEN {
        let ext = Path::new(&name).extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
        let ext = if ext.chars().count() <= 16 { ext } else { String::new() };
        let stem_len = MAX_NAME_LEN - ext.chars().count();
        let stem: String = name.chars().take(stem_len).collect();
        let stem = stem.trim_end_matches([' ', '.']);
        name = format!("{stem}{ext}");
    }
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    if RESERVED_NAMES.iter().any(|reserved| reserved.eq_ignore_ascii_case(stem)) {
        name = format!("_{name}");
    }
    // Un nom réduit à des points (« . », « .. ») n'est jamais un nom de fichier.
    if name.is_empty() || name.chars().all(|c| c == '.') {
        "export".to_string()
    } else {
        name
    }
}

/// Décode l'en-tête du nom (base64 d'un texte UTF-8) ; refuse un en-tête de plus de 1 024 caractères.
pub fn decode_name(header: &str) -> Option<String> {
    if header.len() > MAX_HEADER_LEN {
        return None;
    }
    String::from_utf8(STANDARD.decode(header.trim()).ok()?).ok()
}

/// Octets du corps de la requête : brut (`InvokeBody::Raw`) ou, en repli postMessage, tableau JSON d'octets. Refuse au-delà de
/// `MAX_EXPORT_BYTES` avant toute copie (`too-large`) ; un corps qui n'est pas une suite d'octets rend `bad-body`. La copie est nécessaire :
/// la requête est empruntée et l'écriture se fait sur un autre fil.
pub fn body_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, &'static str> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() > MAX_EXPORT_BYTES {
                return Err("too-large");
            }
            Ok(bytes.clone())
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let items = value.as_array().ok_or("bad-body")?;
            if items.len() > MAX_EXPORT_BYTES {
                return Err("too-large");
            }
            items.iter().map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok())).collect::<Option<Vec<u8>>>().ok_or("bad-body")
        }
    }
}
