//! Vision sur iPhone derrière `ocr_status` et `ocr_recognize` (CAP-IOS-01, ADR 0015 section 1).
//!
//! Compilé partout : la logique (contrôle des entrées, appel du plugin avec délai, tri, confiance, codes) est testée sous Windows avec un
//! faux transport (`tests/desktop/ocr_vision.rs`) ; seul le transport de production, qui appelle le plugin Swift `vision`, est iOS.
//! Rust seul appelle le plugin (aucune permission `vision:` dans une capability).
//!
//! Sécurité : l'image reste en mémoire (octets, puis base64 le temps de l'appel) ; ce module n'écrit aucun fichier et ne parle à aucun
//! réseau. Les erreurs ne portent que des **codes** (jamais un texte reconnu, une image, un message système).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::{clean_text, pick_french, validate_for_vision, OcrCommandError, OcrError, OcrLine, OcrResult, OcrStatus, MAX_LINES, VISION_MAX_SIDE};
use crate::mobile_call::{call_with_deadline, shaped_code, CallError};

/// Langues demandées à Vision, par priorité (ADR 0015 §1.2, écart 1) : français d'abord, anglais pour les mots courants d'une liste mixte.
pub const VISION_LANGUAGES: [&str; 2] = ["fr-FR", "en-US"];
/// Délai de `status` (ADR 0015 §3.1).
pub const STATUS_DEADLINE: Duration = Duration::from_secs(5);
/// Délai de `recognize` : Swift se garde à 15 s, Rust attend 5 s de plus (ADR 0015 §3.1).
pub const RECOGNIZE_DEADLINE: Duration = Duration::from_secs(20);
/// Nombre de lignes demandé à Vision (et lu au plus dans sa réponse) : la coupe à `MAX_LINES` se fait APRÈS le tri de haut en bas, jamais avant
/// (Vision ne garantit aucun ordre : couper avant le tri pourrait perdre le haut de la page).
pub const MAX_RAW_LINES: usize = MAX_LINES * 4;
/// Largeur d'une bande de tri, en part de la hauteur de l'image : deux lignes dont le haut diffère de moins de 1 % se lisent de gauche à droite.
const BAND: f64 = 0.01;

/// Commandes du plugin Swift appelées par Rust (nom exact de la méthode Swift).
pub const PLUGIN_COMMANDS: [&str; 3] = ["status", "recognize", "cleanTemporaryUploads"];
/// Codes que Swift peut rejeter (contrat `tests/fixtures/capture/vision-contract.json`).
pub const PLUGIN_REJECT_CODES: [&str; 7] = ["invalid-argument", "unsupported-format", "dimensions", "language-missing", "busy", "timeout", "failed"];

/// Transport des commandes du plugin : réponse JSON, ou le code rejeté (`unavailable` si le plugin est absent).
pub trait VisionTransport: Send + Sync {
    fn status(&self) -> Result<Value, String>;
    fn recognize(&self, args: Value) -> Result<Value, String>;
    /// Supprime les copies temporaires des photos choisies par le sélecteur du système (WKFileUpload*).
    fn clean(&self) -> Result<Value, String>;
}

/// Une lecture à la fois (seconde lecture : `ocr-engine`, détail `busy`).
#[derive(Debug, Clone, Default)]
pub struct VisionState {
    busy: Arc<AtomicBool>,
    /// Dernière suppression des copies temporaires en échec (dit par `ocr_status`, jamais silencieux).
    cleanup_failed: Arc<AtomicBool>,
}

/// Drapeau « occupé » : rendu quand l'appel de Swift s'est réellement terminé (il est déplacé dans le fil de l'appel).
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl VisionState {
    fn acquire(&self) -> Option<BusyGuard> {
        self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| BusyGuard(self.busy.clone()))
    }

    /// Vrai si la dernière suppression des copies temporaires de photos a échoué.
    pub fn cleanup_failed(&self) -> bool {
        self.cleanup_failed.load(Ordering::SeqCst)
    }

    /// Vrai pendant une lecture (tests).
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// Code de rejet du plugin → erreur de lecture (ADR 0015 §1.1, table des codes). Seule la **forme** du code est conservée dans le détail.
pub fn error_of_code(code: &str) -> OcrError {
    match code {
        "unsupported-format" => OcrError::UnsupportedFormat,
        "dimensions" => OcrError::DimensionsTooLarge,
        "language-missing" => OcrError::LanguageMissing,
        "unavailable" => OcrError::Unavailable,
        "busy" => OcrError::Busy,
        "timeout" => OcrError::Timeout,
        other => OcrError::Engine(shaped_code(other).to_owned()),
    }
}

fn error_of_call(error: CallError) -> OcrError {
    match error {
        CallError::Timeout => OcrError::Timeout,
        CallError::Rejected(code) => error_of_code(&code),
    }
}

fn unavailable_status(reason: &'static str) -> OcrStatus {
    OcrStatus { available: false, languages: Vec::new(), reason: Some(reason), cleanup_failed: false }
}

/// État de Vision (bloquant, délai `deadline`) : français disponible, ou raison. N'échoue jamais.
pub fn status_with(transport: &Arc<dyn VisionTransport>, deadline: Duration) -> OcrStatus {
    let plugin = transport.clone();
    let Ok(response) = call_with_deadline(move || plugin.status(), deadline) else {
        return unavailable_status("plugin-unavailable");
    };
    let Some(items) = response.get("languages").and_then(Value::as_array) else {
        return unavailable_status("plugin-unavailable");
    };
    let languages: Vec<String> = items.iter().filter_map(|tag| tag.as_str().map(str::to_owned)).collect();
    let available = pick_french(&languages).is_some();
    OcrStatus { available, languages, reason: if available { None } else { Some("language-missing") }, cleanup_failed: false }
}

/// Confiance de Vision (0 à 1) ramenée à 0 à 100 ; absente, `NaN` ou hors de 0..1 : pas de confiance (l'heuristique du front s'applique).
fn percent(confidence: Option<f64>) -> Option<u8> {
    let value = confidence?;
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return None;
    }
    Some((value * 100.0).round().clamp(0.0, 100.0) as u8)
}

struct RawLine {
    text: String,
    confidence: Option<u8>,
    /// Bande horizontale (0 = haut de l'image).
    band: i64,
    x: f64,
}

/// Lit `{ lines: [{ text, confidence, x, y }] }` : triées de haut en bas (`y` décroissant par bandes de 1 %) puis de gauche à droite, nettoyées,
/// 500 au plus. `y` est le haut de la ligne (`boundingBox.maxY`, origine en bas à gauche) : Vision ne garantit aucun ordre.
pub fn read_lines(response: &Value) -> Result<Vec<OcrLine>, OcrError> {
    read_result(response).map(|result| result.lines)
}

/// Comme `read_lines`, avec l'indication `truncated` (plus de `MAX_LINES` lignes rendues, ou réponse au plafond demandé à Vision).
pub fn read_result(response: &Value) -> Result<OcrResult, OcrError> {
    let items = response.get("lines").and_then(Value::as_array).ok_or_else(|| OcrError::Engine("failed".to_owned()))?;
    let mut raw: Vec<RawLine> = items
        .iter()
        .take(MAX_RAW_LINES)
        .filter_map(|item| {
            let text = clean_text(item.get("text")?.as_str()?);
            if text.is_empty() {
                return None;
            }
            let y = item.get("y").and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0);
            let x = item.get("x").and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0);
            Some(RawLine { text, confidence: percent(item.get("confidence").and_then(Value::as_f64)), band: ((1.0 - y) / BAND).floor() as i64, x })
        })
        .collect();
    raw.sort_by(|a, b| a.band.cmp(&b.band).then(a.x.total_cmp(&b.x)));
    let truncated = raw.len() > MAX_LINES || items.len() >= MAX_RAW_LINES;
    let lines = raw.into_iter().take(MAX_LINES).map(|line| OcrLine { text: line.text, confidence: line.confidence }).collect();
    Ok(OcrResult { lines, truncated })
}

/// Délai de la suppression des copies temporaires.
pub const CLEAN_DEADLINE: Duration = Duration::from_secs(5);

/// Supprime les copies temporaires des photos (bloquant) et retient le résultat : un échec reste visible (`ocr_status`), un succès l'efface.
pub fn clean_with(transport: &Arc<dyn VisionTransport>, state: &VisionState, deadline: Duration) {
    let plugin = transport.clone();
    let failed = call_with_deadline(move || plugin.clean(), deadline).is_err();
    state.cleanup_failed.store(failed, Ordering::SeqCst);
}

/// Lecture d'une image (bloquant). Entrées contrôlées **avant** tout appel du plugin ; une seule lecture à la fois ; délai `deadline`.
pub fn recognize_with(transport: &Arc<dyn VisionTransport>, state: &VisionState, bytes: &[u8], deadline: Duration) -> Result<OcrResult, OcrCommandError> {
    validate_for_vision(bytes)?;
    let guard = state.acquire().ok_or(OcrError::Busy)?;
    let args = json!({ "image": STANDARD.encode(bytes), "languages": VISION_LANGUAGES, "maxSide": VISION_MAX_SIDE, "maxLines": MAX_RAW_LINES });
    let plugin = transport.clone();
    let response = call_with_deadline(
        move || {
            // Le drapeau suit l'appel de Swift jusqu'à sa vraie fin, même si Rust a cessé d'attendre.
            let _guard = guard;
            plugin.recognize(args)
        },
        deadline,
    )
    .map_err(error_of_call);
    // La photo ne reste pas dans le dossier temporaire de l'app, que la lecture ait réussi ou non.
    clean_with(transport, state, CLEAN_DEADLINE.min(deadline));
    Ok(read_result(&response?)?)
}

/// Transport de production : le plugin Swift `tauri-plugin-vision`.
#[cfg(target_os = "ios")]
struct PluginTransport<R: tauri::Runtime>(tauri_plugin_vision::Vision<R>);

#[cfg(target_os = "ios")]
impl<R: tauri::Runtime> VisionTransport for PluginTransport<R> {
    fn status(&self) -> Result<Value, String> {
        self.0.call("status", json!({}))
    }

    fn recognize(&self, args: Value) -> Result<Value, String> {
        self.0.call("recognize", args)
    }

    fn clean(&self) -> Result<Value, String> {
        self.0.call("cleanTemporaryUploads", json!({}))
    }
}

#[cfg(target_os = "ios")]
fn plugin_transport<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Arc<dyn VisionTransport>> {
    use tauri::Manager;
    let plugin = app.try_state::<tauri_plugin_vision::Vision<R>>()?;
    Some(Arc::new(PluginTransport(plugin.inner().clone())))
}

/// `ocr_status` sur iPhone. Plugin absent : indisponible avec la raison `plugin-unavailable`.
#[cfg(target_os = "ios")]
pub async fn status_on_device<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> OcrStatus {
    let Some(transport) = plugin_transport(app) else { return unavailable_status("plugin-unavailable") };
    let state = app.try_state::<VisionState>().map(|s| s.inner().clone()).unwrap_or_default();
    let mut status = tauri::async_runtime::spawn_blocking(move || status_with(&transport, STATUS_DEADLINE)).await.unwrap_or_else(|_| unavailable_status("plugin-unavailable"));
    status.cleanup_failed = state.cleanup_failed();
    status
}

/// Au lancement : supprime les copies temporaires laissées par une session précédente (fil dédié, jamais bloquant).
#[cfg(target_os = "ios")]
pub fn clean_on_launch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(transport) = plugin_transport(app) else { return };
    let state = app.try_state::<VisionState>().map(|s| s.inner().clone()).unwrap_or_default();
    std::thread::spawn(move || clean_with(&transport, &state, CLEAN_DEADLINE));
}

/// `ocr_recognize` sur iPhone.
#[cfg(target_os = "ios")]
pub async fn recognize_on_device<R: tauri::Runtime>(app: &tauri::AppHandle<R>, bytes: Vec<u8>) -> Result<OcrResult, OcrCommandError> {
    use tauri::Manager;
    // Les contrôles des entrées sont faits UNE fois, par `recognize_with` ; sans plugin, ils passent d'abord (entrée invalide = son code).
    let Some(transport) = plugin_transport(app) else {
        validate_for_vision(&bytes)?;
        return Err(OcrError::Unavailable.into());
    };
    let state = app.try_state::<VisionState>().map(|s| s.inner().clone()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || recognize_with(&transport, &state, &bytes, RECOGNIZE_DEADLINE))
        .await
        .map_err(|_| OcrCommandError::from(OcrError::Engine("failed".to_owned())))?
}
