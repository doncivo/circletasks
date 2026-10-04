//! Export de fichiers (H-03, PC) : « Enregistrer sous » système et écriture du seul fichier choisi, faites par Rust.
//!
//! La WebView n'a ni le plugin fs ni le plugin dialog : elle envoie les octets à `export_save_file`, qui ouvre la boîte système, écrit
//! le fichier choisi et mémorise ce chemin (le dernier). `reveal_exported_file` n'ouvre l'explorateur que sur ce dernier chemin, jamais
//! sur un chemin fourni librement, et refuse les chemins réseau (UNC, `\\serveur\…`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Dernier fichier écrit par `export_save_file` (état géré par Tauri).
#[derive(Default)]
pub struct ExportState {
    last: Mutex<Option<PathBuf>>,
}

/// En-tête portant le nom proposé, encodé en base64 (UTF-8) : un en-tête HTTP ne contient pas d'accents.
pub const NAME_HEADER: &str = "x-file-name";

/// Nom de fichier proposé, réduit à un nom simple (sans dossier ni caractère interdit sous Windows).
pub fn sanitize_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control()).collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

/// Décode l'en-tête du nom (base64 d'un texte UTF-8).
pub fn decode_name(header: &str) -> Option<String> {
    String::from_utf8(STANDARD.decode(header.trim()).ok()?).ok()
}

/// Un chemin réseau (UNC `\\serveur\partage`, `//serveur/…`, `\\?\UNC\…`) n'est jamais révélé.
pub fn is_unc(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// Le chemin demandé est-il exactement le dernier fichier exporté, et local ?
pub fn check_reveal(last: Option<&Path>, requested: &str) -> Result<PathBuf, &'static str> {
    if is_unc(requested) {
        return Err("chemin réseau refusé");
    }
    match last {
        Some(path) if path == Path::new(requested) => Ok(path.to_path_buf()),
        _ => Err("seul le dernier fichier exporté peut être affiché"),
    }
}

/// Ouvre « Enregistrer sous », écrit les octets reçus (corps brut de la requête) dans le fichier choisi et en renvoie le chemin ;
/// `None` si l'utilisateur annule. Un échec d'écriture est une erreur : le fichier existant n'est jamais supprimé (il peut avoir été
/// tronqué si l'utilisateur a choisi d'écraser un fichier existant).
#[tauri::command]
pub async fn export_save_file(app: AppHandle, state: State<'_, ExportState>, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_name)
        .map(|raw| sanitize_file_name(&raw))
        .ok_or("nom de fichier absent")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("octets attendus".into());
    };
    let data = bytes.clone();
    let extension = Path::new(&name).extension().and_then(|e| e.to_str()).map(str::to_owned);

    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&name);
        if let Some(ext) = &extension {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file) = chosen else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    *state.last.lock().map_err(|_| "état indisponible")? = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Affiche dans l'explorateur le dernier fichier exporté (et lui seul).
#[tauri::command]
pub fn reveal_exported_file(state: State<'_, ExportState>, path: String) -> Result<(), String> {
    let last = state.last.lock().map_err(|_| "état indisponible")?.clone();
    let target = check_reveal(last.as_deref(), &path).map_err(str::to_owned)?;
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
}
