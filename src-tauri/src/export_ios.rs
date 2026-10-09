//! Export de fichiers sur iPhone (FILES-IOS-01, ADR 0009 avenant lot F point A3, décision du 2026-10-08) : même commande et même
//! permission qu'au PC (`export_save_file`, corps brut, en-tête `x-file-name`), mais le fichier est écrit par Rust dans un temporaire du
//! cache de l'app, puis remis au plugin Swift `ct-files`, qui présente le sélecteur « Enregistrer dans Fichiers »
//! (`UIDocumentPickerViewController(forExporting:asCopy: true)`, iCloud Drive compris). Le temporaire est **toujours** supprimé ensuite
//! (succès, annulation, rejet, erreur, `panic`) ; ce qui reste d'un arrêt brutal est purgé au démarrage (`purge_exports`).
//!
//! Compilé pour l'iPhone et sous `test-hooks` (tests Windows, faux transport) ; absent du binaire PC. La commande Tauri et le transport
//! réel n'existent que sous `cfg(target_os = "ios")`.
//!
//! Erreurs vers la WebView : `{ code }` seulement (`too-large`, `bad-name`, `busy`, `unsafe-folder`, `io`, `not-foreground`, `failed`),
//! jamais un message ni un chemin.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::export_common::{allowed_extension, body_bytes, decode_name, mime_for, sanitize_file_name};

/// Sous-dossier du cache de l'app qui reçoit les temporaires d'export.
pub const EXPORTS_DIR: &str = "exports";
/// Délai maximal d'une présentation du sélecteur (revue I4) : au-delà, `timeout` visible et le verrou d'enregistrement est rendu.
pub const PRESENT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Code de Rust quand Swift ne répond pas avant `PRESENT_DEADLINE`.
pub const TIMEOUT_CODE: &str = "timeout";
/// Codes de rejet du plugin Swift connus de Rust (fixture `tests/fixtures/files/files-contract.json`) ; tout autre code devient `failed`.
pub const PLUGIN_REJECT_CODES: [&str; 2] = ["not-foreground", "failed"];

/// Présentation du sélecteur « Enregistrer dans Fichiers » sur un fichier écrit par Rust : `Ok(true)` enregistré, `Ok(false)` annulé,
/// `Err(code)` rejet du plugin. Plugin Swift sur iPhone ; faux dans `tests/desktop/export_ios.rs`.
pub trait SaveTransport: Send + Sync {
    fn present(&self, path: &Path, mime: &str) -> Result<bool, String>;
}

/// Un seul enregistrement à la fois (état géré par Tauri).
#[derive(Default)]
pub struct ExportIosState {
    busy: Mutex<()>,
}

/// Erreur renvoyée à la WebView : un code, rien d'autre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExportIosError {
    pub code: &'static str,
}

const fn fail(code: &'static str) -> ExportIosError {
    ExportIosError { code }
}

/// Réponse de la commande : `completed` faux = annulation (ce n'est pas une erreur).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SaveOutcome {
    pub completed: bool,
}

/// Fichier préparé : nom proposé réduit, type dérivé de l'extension, octets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedExport {
    pub name: String,
    pub mime: &'static str,
    pub data: Vec<u8>,
}

/// Étapes 1 et 2 : taille avant toute copie (`too-large`), puis nom décodé et réduit (`bad-name` si l'en-tête manque ou est illisible).
pub fn prepare(name_header: Option<&str>, body: &tauri::ipc::InvokeBody) -> Result<PreparedExport, ExportIosError> {
    let data = body_bytes(body).map_err(|code| fail(if code == "too-large" { "too-large" } else { "io" }))?;
    let raw = name_header.and_then(decode_name).ok_or(fail("bad-name"))?;
    let name = sanitize_file_name(&raw);
    let mime = allowed_extension(&name).map_or("application/octet-stream", |ext| mime_for(&ext));
    Ok(PreparedExport { name, mime, data })
}

/// Ce que le nettoyage n'a pas pu faire (inscrit au journal par l'appelant, rattrapé par la purge au démarrage).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CleanupReport {
    pub remove_failed: bool,
}

/// Sous-dossier aléatoire `exports/<16 hex>/` et son fichier : supprimés à la fin, y compris pendant un `panic` (garde `Drop`).
struct TempExport {
    dir: PathBuf,
    done: bool,
}

impl TempExport {
    fn cleanup(&mut self) -> CleanupReport {
        self.done = true;
        match fs::symlink_metadata(&self.dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => CleanupReport::default(),
            // `remove_dir_all` ne suit pas les liens : seul le contenu du sous-dossier créé par Rust est supprimé.
            _ => CleanupReport { remove_failed: fs::remove_dir_all(&self.dir).is_err() },
        }
    }
}

impl Drop for TempExport {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.cleanup();
        }
    }
}

/// Dossier `exports/` du cache : créé au besoin ; un lien, un fichier ou toute autre chose qu'un dossier ordinaire rend `unsafe-folder` et
/// rien n'est écrit.
fn ensure_exports_dir(cache_dir: &Path) -> Result<PathBuf, ExportIosError> {
    let exports = cache_dir.join(EXPORTS_DIR);
    match fs::symlink_metadata(&exports) {
        Ok(meta) if meta.file_type().is_dir() => Ok(exports),
        Ok(_) => Err(fail("unsafe-folder")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(cache_dir).map_err(|_| fail("io"))?;
            match fs::create_dir(&exports) {
                Ok(()) => Ok(exports),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => match fs::symlink_metadata(&exports) {
                    Ok(meta) if meta.file_type().is_dir() => Ok(exports),
                    _ => Err(fail("unsafe-folder")),
                },
                Err(_) => Err(fail("io")),
            }
        }
        Err(_) => Err(fail("io")),
    }
}

/// Nom aléatoire de 16 caractères hexadécimaux.
fn random_hex() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// Étapes 3 à 7 : un seul enregistrement à la fois (`busy`), dossier contrôlé, sous-dossier aléatoire créé exclusivement, fichier créé en
/// `create_new`, écrit et `sync_all` (`io`), présentation par le transport, puis suppression du fichier et du sous-dossier **dans tous les
/// cas**. Le rapport de nettoyage est rendu avec le résultat (`temp-remove-failed` au journal par l'appelant).
pub fn save_prepared(state: &ExportIosState, cache_dir: &Path, prepared: &PreparedExport, transport: &dyn SaveTransport) -> (Result<SaveOutcome, ExportIosError>, CleanupReport) {
    let Ok(_guard) = state.busy.try_lock() else {
        return (Err(fail("busy")), CleanupReport::default());
    };
    let exports = match ensure_exports_dir(cache_dir) {
        Ok(dir) => dir,
        Err(error) => return (Err(error), CleanupReport::default()),
    };
    let dir = exports.join(random_hex());
    if fs::create_dir(&dir).is_err() {
        return (Err(fail("io")), CleanupReport::default());
    }
    let mut temp = TempExport { dir: dir.clone(), done: false };
    let path = dir.join(&prepared.name);
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| file.write_all(&prepared.data).and_then(|()| file.sync_all()));
    let result = match written {
        Err(_) => Err(fail("io")),
        Ok(()) => match transport.present(&path, prepared.mime) {
            Ok(completed) => Ok(SaveOutcome { completed }),
            Err(code) if code == TIMEOUT_CODE => Err(fail(TIMEOUT_CODE)),
            Err(code) => Err(fail(PLUGIN_REJECT_CODES.iter().copied().find(|known| *known == code).unwrap_or("failed"))),
        },
    };
    let report = temp.cleanup();
    (result, report)
}

/// Supprime une entrée qui n'est pas un dossier ordinaire sans suivre de lien : fichier, lien symbolique, ou lien vers un dossier (jonction
/// sous Windows, supprimée par `remove_dir`, qui retire le lien et jamais sa cible).
fn remove_link_or_file(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path).or_else(|error| if cfg!(windows) { fs::remove_dir(path) } else { Err(error) })
}

/// Purge au démarrage : tout le contenu de `exports/` est supprimé, sans suivre de lien (un lien est supprimé lui-même, jamais sa cible).
/// Un `exports` qui n'est pas un dossier ordinaire (lien, fichier) est supprimé lui-même. Rend le nombre d'entrées supprimées, ou `Err`
/// si une suppression a échoué (entrée `export` / `temp-purge-failed` au journal par l'appelant).
pub fn purge_exports(cache_dir: &Path) -> Result<usize, usize> {
    let exports = cache_dir.join(EXPORTS_DIR);
    let meta = match fs::symlink_metadata(&exports) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(0),
    };
    if !meta.file_type().is_dir() {
        return remove_link_or_file(&exports).map(|()| 1).map_err(|_| 0);
    }
    let Ok(entries) = fs::read_dir(&exports) else { return Err(0) };
    let mut removed = 0;
    let mut failed = false;
    for entry in entries {
        let Ok(entry) = entry else {
            failed = true;
            continue;
        };
        let path = entry.path();
        let outcome = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_dir() => fs::remove_dir_all(&path),
            Ok(_) => remove_link_or_file(&path),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(()) => removed += 1,
            Err(_) => failed = true,
        }
    }
    if failed {
        Err(removed)
    } else {
        Ok(removed)
    }
}

/// Transport réel : le plugin Swift `ct-files` (commande `present`), appelé par Rust seul.
#[cfg(target_os = "ios")]
pub struct PluginTransport(pub tauri_plugin_ct_files::CtFiles<tauri::Wry>);

#[cfg(target_os = "ios")]
impl SaveTransport for PluginTransport {
    fn present(&self, path: &Path, mime: &str) -> Result<bool, String> {
        let path = path.to_str().ok_or_else(|| "failed".to_owned())?;
        let plugin = self.0.clone();
        let args = serde_json::json!({ "path": path, "mime": mime });
        // Revue I4 : délai maximal ; une réponse tardive de Swift est ignorée, le temporaire est supprimé et le verrou rendu.
        let answer = crate::mobile_call::call_with_deadline(move || plugin.call("present", args), PRESENT_DEADLINE).map_err(|error| match error {
            crate::mobile_call::CallError::Timeout => TIMEOUT_CODE.to_owned(),
            crate::mobile_call::CallError::Rejected(code) => code,
        })?;
        answer.get("completed").and_then(serde_json::Value::as_bool).ok_or_else(|| "failed".to_owned())
    }
}

/// Enregistre le fichier reçu par le sélecteur « Enregistrer dans Fichiers » (iPhone). Corps brut et en-tête `x-file-name` comme au PC.
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn export_save_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<SaveOutcome, ExportIosError> {
    use tauri::Manager;
    let header = request.headers().get(crate::export_common::NAME_HEADER).and_then(|value| value.to_str().ok());
    let prepared = prepare(header, request.body())?;
    let cache_dir = app.path().app_cache_dir().map_err(|_| fail("io"))?;
    let plugin = app.try_state::<tauri_plugin_ct_files::CtFiles<tauri::Wry>>().ok_or(fail("failed"))?;
    let transport = PluginTransport(plugin.inner().clone());
    let handle = app.clone();
    let (result, report) = tauri::async_runtime::spawn_blocking(move || match handle.try_state::<ExportIosState>() {
        Some(state) => save_prepared(&state, &cache_dir, &prepared, &transport),
        None => (Err(fail("failed")), CleanupReport::default()),
    })
    .await
    .map_err(|_| fail("io"))?;
    note_cleanup(report);
    result
}

/// Échec de suppression du temporaire : inscrit au journal technique (I-04, ADR 0014), rattrapé par la purge au démarrage.
#[cfg(target_os = "ios")]
fn note_cleanup(report: CleanupReport) {
    if report.remove_failed {
        crate::applog::write("export", "temp-remove-failed");
    }
}
