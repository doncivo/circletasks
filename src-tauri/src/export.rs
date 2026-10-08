//! Export de fichiers (H-03, PC) : « Enregistrer sous » système et écriture du seul fichier choisi, faites par Rust.
//!
//! La WebView n'a ni le plugin fs ni le plugin dialog : elle envoie les octets à `export_save_file`, qui ouvre la boîte système (modale
//! de la fenêtre principale), écrit le fichier choisi de façon atomique et mémorise ce chemin (le dernier). `reveal_exported_file` ne
//! prend aucun paramètre : il n'affiche que ce dernier chemin, et seulement s'il est sur un disque local.
//!
//! Taille, nom proposé et extensions : module commun `export_common` (PC et iPhone, ADR 0009 avenant lot F point A3), réexporté ici.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub use crate::export_common::{allowed_extension, body_bytes, decode_name, mime_for, sanitize_file_name, ALLOWED_EXTENSIONS, MAX_EXPORT_BYTES, MAX_HEADER_LEN, MAX_NAME_LEN, NAME_HEADER};

/// Dernier fichier écrit par `export_save_file` (état géré par Tauri).
#[derive(Default)]
pub struct ExportState {
    last: Mutex<Option<PathBuf>>,
}

/// Seul un chemin sur un disque local (`C:\…` ou `\\?\C:\…`) est écrit ou affiché. Refusés : chemins réseau (UNC, `\\?\UNC\…`), chemins
/// verbatim non disque (`\\?\GLOBALROOT\…`), périphériques (`\\.\…`), chemins sans lettre de lecteur (`\srv\…`, `/srv/…`).
pub fn is_local_disk_path(path: &Path) -> bool {
    matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

/// Écrit `bytes` dans `path` de façon atomique : fichier temporaire `.<nom>.ct-partial` dans le même dossier (création exclusive), écriture,
/// `sync_all`, puis `rename` vers la cible. Au moindre échec, le temporaire est supprimé ; un fichier existant à la cible n'est modifié qu'au
/// `rename` final (jamais tronqué).
pub fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomically_with(path, bytes, &|file, data| file.write_all(data))
}

/// Comme `write_atomically`, avec l'écriture injectée (pour tester un échec au milieu).
pub fn write_atomically_with(path: &Path, bytes: &[u8], write: &dyn Fn(&mut File, &[u8]) -> io::Result<()>) -> io::Result<()> {
    let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "nom de fichier absent"))?;
    let temp = path.with_file_name(format!(".{}.ct-partial", name.to_string_lossy()));
    let open = || OpenOptions::new().write(true).create_new(true).open(&temp);
    let mut file = match open() {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            // Reste d'un export interrompu : on le supprime, puis on recrée exclusivement.
            std::fs::remove_file(&temp)?;
            open()?
        }
        Err(error) => return Err(error),
    };
    let result = write(&mut file, bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Ouvre « Enregistrer sous » (modale de la fenêtre principale), écrit les octets reçus dans le fichier choisi et en renvoie le chemin ;
/// `None` si l'utilisateur annule. Écriture atomique : en cas d'échec, aucun fichier partiel et le fichier existant reste intact.
#[tauri::command]
pub async fn export_save_file(app: AppHandle, state: State<'_, ExportState>, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    // Contrôles de taille d'abord : avant toute autre opération.
    let data = body_bytes(request.body()).map_err(str::to_owned)?;
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_name)
        .map(|raw| sanitize_file_name(&raw))
        .ok_or("bad-name")?;
    let extension = allowed_extension(&name);

    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app.dialog().file().set_file_name(&name);
        if let Some(window) = dialog_app.get_webview_window(crate::desktop::MAIN_WINDOW) {
            dialog = dialog.set_parent(&window);
        }
        if let Some(ext) = &extension {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file) = chosen else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    if !is_local_disk_path(&path) {
        return Err("chemin non local refusé".into());
    }
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_atomically(&target, &data))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *state.last.lock().map_err(|_| "état indisponible")? = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Chemin à afficher : le dernier fichier exporté, s'il est sur un disque local.
pub fn reveal_target(last: Option<&Path>) -> Result<PathBuf, &'static str> {
    match last {
        Some(path) if is_local_disk_path(path) => Ok(path.to_path_buf()),
        Some(_) => Err("chemin non local refusé"),
        None => Err("aucun fichier exporté"),
    }
}

/// Affiche dans l'explorateur le dernier fichier exporté (et lui seul) ; aucun paramètre venant de la WebView.
#[tauri::command]
pub fn reveal_exported_file(state: State<'_, ExportState>) -> Result<(), String> {
    let last = state.last.lock().map_err(|_| "état indisponible")?.clone();
    let target = reveal_target(last.as_deref()).map_err(str::to_owned)?;
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string())
}
