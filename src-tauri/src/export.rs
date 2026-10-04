//! Export de fichiers (H-03, PC) : « Enregistrer sous » système et écriture du seul fichier choisi, faites par Rust.
//!
//! La WebView n'a ni le plugin fs ni le plugin dialog : elle envoie les octets à `export_save_file`, qui ouvre la boîte système (modale
//! de la fenêtre principale), écrit le fichier choisi de façon atomique et mémorise ce chemin (le dernier). `reveal_exported_file` ne
//! prend aucun paramètre : il n'affiche que ce dernier chemin, et seulement s'il est sur un disque local.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Dernier fichier écrit par `export_save_file` (état géré par Tauri).
#[derive(Default)]
pub struct ExportState {
    last: Mutex<Option<PathBuf>>,
}

/// En-tête portant le nom proposé, encodé en base64 (UTF-8) : un en-tête HTTP ne contient pas d'accents.
pub const NAME_HEADER: &str = "x-file-name";
/// Taille maximale d'un export (64 Mio) : au-delà, la commande refuse avant toute autre opération.
pub const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
/// Longueur maximale de l'en-tête du nom (caractères, avant décodage).
pub const MAX_HEADER_LEN: usize = 1024;
/// Longueur maximale du nom de fichier proposé (extension comprise).
pub const MAX_NAME_LEN: usize = 200;
/// Extensions proposées comme filtre de la boîte (les formats de l'export).
pub const ALLOWED_EXTENSIONS: [&str; 4] = ["csv", "json", "pdf", "png"];

const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Extension autorisée d'un nom (minuscules), ou None.
pub fn allowed_extension(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
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
    if name.is_empty() {
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

/// Octets du corps de la requête : brut (`InvokeBody::Raw`) ou, en repli postMessage, tableau JSON d'octets. Refuse au-delà de
/// `MAX_EXPORT_BYTES` avant toute copie. La copie est nécessaire : la requête est empruntée et l'écriture se fait sur un autre fil.
pub fn body_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, &'static str> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() > MAX_EXPORT_BYTES {
                return Err("export trop volumineux");
            }
            Ok(bytes.clone())
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let items = value.as_array().ok_or("octets attendus")?;
            if items.len() > MAX_EXPORT_BYTES {
                return Err("export trop volumineux");
            }
            items.iter().map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok())).collect::<Option<Vec<u8>>>().ok_or("octets attendus")
        }
    }
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
        .ok_or("nom de fichier absent")?;
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
