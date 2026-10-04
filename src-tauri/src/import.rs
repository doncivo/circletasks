//! Import de fichier (P-07, PC) : boîte « Ouvrir » système et lecture du seul fichier choisi, faites par Rust.
//!
//! La WebView n'a ni le plugin fs ni le plugin dialog : elle appelle `import_open_file`, qui ouvre la boîte (modale de la fenêtre
//! principale, filtre CSV / TXT / TSV), vérifie le chemin choisi (lettre de lecteur seulement, comme l'export de H-03), ouvre le fichier,
//! contrôle sur le descripteur ouvert qu'il s'agit d'un fichier ordinaire de 2 Mo au plus, le lit avec un plafond (un fichier qui grossit
//! pendant la lecture est refusé aussi) et renvoie son nom et ses octets (base64). Aucun chemin ne vient de la WebView.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::export::is_local_disk_path;

/// Taille maximale d'un fichier d'import (2 Mo), la même que `IMPORT_MAX_BYTES` côté TypeScript.
pub const MAX_IMPORT_BYTES: usize = 2 * 1024 * 1024;
/// Extensions proposées par la boîte et acceptées.
pub const IMPORT_EXTENSIONS: [&str; 3] = ["csv", "txt", "tsv"];

/// Erreur renvoyée au front : `{ code, message }` (ADR 0001). Codes : `not-local`, `bad-type`, `not-a-file`, `too-large`, `unreadable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportError {
    pub code: &'static str,
    pub message: String,
}

impl ImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// Fichier lu : nom (sans dossier) et octets en base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportedFile {
    pub name: String,
    pub data: String,
}

/// Extension autorisée d'un chemin (insensible à la casse).
pub fn has_import_extension(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| IMPORT_EXTENSIONS.iter().any(|allowed| allowed.eq_ignore_ascii_case(e)))
}

/// Lit `path` avec un plafond de `max` octets. Contrôles dans l'ordre : disque local, extension, ouverture, fichier ordinaire (sur le
/// descripteur ouvert : ni dossier ni périphérique ni tube), taille annoncée, puis lecture bornée à `max + 1` octets.
pub fn read_import_file(path: &Path, max: usize) -> Result<Vec<u8>, ImportError> {
    if !is_local_disk_path(path) {
        return Err(ImportError::new("not-local", "chemin non local refusé"));
    }
    if !has_import_extension(path) {
        return Err(ImportError::new("bad-type", "type de fichier non pris en charge"));
    }
    let file = File::open(path).map_err(|e| ImportError::new("unreadable", e.to_string()))?;
    let meta = file.metadata().map_err(|e| ImportError::new("unreadable", e.to_string()))?;
    if !meta.is_file() {
        return Err(ImportError::new("not-a-file", "ce n'est pas un fichier ordinaire"));
    }
    if meta.len() > max as u64 {
        return Err(ImportError::new("too-large", format!("fichier de plus de {max} octets")));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|e| ImportError::new("unreadable", e.to_string()))?;
    if bytes.len() > max {
        return Err(ImportError::new("too-large", format!("fichier de plus de {max} octets")));
    }
    Ok(bytes)
}

/// Nom d'affichage du fichier choisi : dernier élément du chemin.
pub fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Ouvre « Ouvrir » (modale de la fenêtre principale) et lit le fichier choisi ; `None` si l'utilisateur annule.
#[tauri::command]
pub async fn import_open_file(app: AppHandle) -> Result<Option<ImportedFile>, ImportError> {
    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app.dialog().file().add_filter("CSV", &IMPORT_EXTENSIONS);
        if let Some(window) = dialog_app.get_webview_window(crate::desktop::MAIN_WINDOW) {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| ImportError::new("unreadable", e.to_string()))?;

    let Some(file) = chosen else { return Ok(None) };
    let path: PathBuf = file.into_path().map_err(|e| ImportError::new("unreadable", e.to_string()))?;
    let name = display_name(&path);
    let bytes = tauri::async_runtime::spawn_blocking(move || read_import_file(&path, MAX_IMPORT_BYTES))
        .await
        .map_err(|e| ImportError::new("unreadable", e.to_string()))??;
    Ok(Some(ImportedFile { name, data: STANDARD.encode(bytes) }))
}
