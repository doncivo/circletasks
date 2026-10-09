//! Dictée sur l'appareil (CAP-IOS-01, ADR 0015 section 2) : commandes `speech_*` et `app_settings_open` de l'iPhone.
//!
//! Compilé partout : la logique (une écoute à la fois, limite de 60 s tenue par Rust, correspondance des codes, délais) est testée sous
//! Windows avec un faux transport (`tests/desktop/speech.rs`) ; `ios.rs` (cible iOS) ne fait que brancher le plugin Swift `speech` et
//! déclarer les commandes. Rust seul appelle le plugin (aucune permission `speech:` dans une capability).
//!
//! Confidentialité : aucun texte reconnu, aucun état d'autorisation dans un message d'erreur ; aucun fichier créé, aucun réseau. La
//! reconnaissance est imposée **sur l'appareil** par le plugin (`requiresOnDeviceRecognition`) : sans modèle français, `listen` refuse
//! (`speech-on-device-unavailable`) et ne se replie jamais sur les serveurs d'Apple.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::mobile_call::{call_with_deadline, CallError};

#[cfg(target_os = "ios")]
pub mod ios;

/// Commandes du plugin Swift appelées par Rust (nom exact de la méthode Swift).
pub const PLUGIN_COMMANDS: [&str; 5] = ["status", "requestPermissions", "listen", "stop", "openAppSettings"];
/// Codes que Swift peut rejeter (contrat `tests/fixtures/capture/speech-contract.json`).
pub const PLUGIN_REJECT_CODES: [&str; 8] =
    ["invalid-argument", "microphone-denied", "speech-recognition-denied", "on-device-unavailable", "recognizer-unavailable", "busy", "audio-unavailable", "failed"];

/// Seule langue reconnue (PRD section 10).
pub const LOCALE: &str = "fr-FR";

/// Délais et limite de dictée (ADR 0015 §2.1 et §3.1).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Durée d'écoute au plus (60 s) : au-delà, Rust demande l'arrêt et rend le texte déjà reconnu.
    pub max_listen: Duration,
    /// Butée propre de Swift (filet), transmise à `listen`.
    pub swift_cap: Duration,
    /// Délai global de l'appel `listen` (60 s + 10 s).
    pub listen_deadline: Duration,
    pub status: Duration,
    /// Fenêtres d'iOS ouvertes : l'utilisateur prend son temps.
    pub request: Duration,
    pub stop: Duration,
    pub settings: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_listen: Duration::from_secs(60),
            swift_cap: Duration::from_secs(65),
            listen_deadline: Duration::from_secs(70),
            status: Duration::from_secs(5),
            request: Duration::from_secs(300),
            stop: Duration::from_secs(5),
            settings: Duration::from_secs(5),
        }
    }
}

/// Transport des commandes du plugin : réponse JSON, ou le code rejeté (`unavailable` si le plugin est absent).
pub trait SpeechTransport: Send + Sync {
    fn call(&self, command: &str, args: Value) -> Result<Value, String>;
}

/// Une écoute à la fois.
#[derive(Debug, Clone, Default)]
pub struct SpeechState {
    listening: Arc<AtomicBool>,
}

/// Drapeau « écoute en cours » : rendu quand l'appel de Swift s'est réellement terminé (il est déplacé dans le fil de l'appel).
struct ListeningGuard(Arc<AtomicBool>);

impl Drop for ListeningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl SpeechState {
    fn acquire(&self) -> Option<ListeningGuard> {
        self.listening.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| ListeningGuard(self.listening.clone()))
    }

    pub fn is_listening(&self) -> bool {
        self.listening.load(Ordering::SeqCst)
    }
}

/// Erreur de commande `{ code, message }` (ADR 0001). Le message ne porte que le code du plugin, jamais un texte système ou reconnu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SpeechCommandError {
    pub code: &'static str,
    pub message: String,
}

impl SpeechCommandError {
    fn new(code: &'static str, detail: &str) -> Self {
        Self { code, message: crate::mobile_call::shaped_code(detail).to_owned() }
    }
}

/// État du service de dictée, lu sans ouvrir aucune fenêtre d'iOS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub available: bool,
    pub on_device: bool,
    pub microphone: &'static str,
    pub speech_recognition: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPermissions {
    pub microphone: &'static str,
    pub speech_recognition: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenOutcome {
    pub text: String,
    pub stopped_by: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StopOutcome {
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsOutcome {
    pub opened: bool,
}

/// Texte reconnu : au plus 4 000 caractères (une minute de parole en tient largement moins).
const MAX_TEXT_CHARS: usize = 4000;

/// État d'autorisation du système, ramené aux cinq valeurs du contrat ; toute autre valeur (ou absence) est `unknown`.
pub fn permission_state(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("granted") => "granted",
        Some("denied") => "denied",
        Some("restricted") => "restricted",
        Some("prompt") => "prompt",
        _ => "unknown",
    }
}

fn stopped_by(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("user") => "user",
        Some("time-limit") => "time-limit",
        Some("background") => "background",
        Some("ended") => "ended",
        _ => "interrupted",
    }
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn unavailable_status() -> SpeechStatus {
    SpeechStatus { available: false, on_device: false, microphone: "unknown", speech_recognition: "unknown", reason: Some("plugin-unavailable") }
}

/// `speech_status` (bloquant) : n'échoue jamais ; un plugin muet donne `available: false` avec `reason: "plugin-unavailable"`.
pub fn status_with(transport: &Arc<dyn SpeechTransport>, limits: &Limits) -> SpeechStatus {
    let plugin = transport.clone();
    let Ok(response) = call_with_deadline(move || plugin.call("status", json!({})), limits.status) else {
        return unavailable_status();
    };
    let available = flag(&response, "recognizer");
    SpeechStatus {
        available,
        on_device: flag(&response, "onDevice"),
        microphone: permission_state(response.get("microphone")),
        speech_recognition: permission_state(response.get("speechRecognition")),
        reason: if available { None } else { Some("recognizer-unavailable") },
    }
}

/// `speech_request_permissions` (bloquant) : micro puis reconnaissance vocale, lus après coup. Erreur : `speech-unavailable`.
pub fn request_permissions_with(transport: &Arc<dyn SpeechTransport>, limits: &Limits) -> Result<SpeechPermissions, SpeechCommandError> {
    let plugin = transport.clone();
    let response = call_with_deadline(move || plugin.call("requestPermissions", json!({})), limits.request)
        .map_err(|error| SpeechCommandError::new("speech-unavailable", &detail_of(&error)))?;
    Ok(SpeechPermissions { microphone: permission_state(response.get("microphone")), speech_recognition: permission_state(response.get("speechRecognition")) })
}

fn detail_of(error: &CallError) -> String {
    match error {
        CallError::Timeout => "timeout".to_owned(),
        CallError::Rejected(code) => code.clone(),
    }
}

/// Code de rejet du plugin → code de la commande `speech_listen`.
pub fn listen_code_of(code: &str) -> &'static str {
    match code {
        "microphone-denied" => "speech-microphone-denied",
        "speech-recognition-denied" => "speech-recognition-denied",
        "on-device-unavailable" => "speech-on-device-unavailable",
        "busy" => "speech-busy",
        "audio-unavailable" => "speech-audio-unavailable",
        "recognizer-unavailable" | "unavailable" => "speech-unavailable",
        _ => "speech-failed",
    }
}

/// `speech_listen` : une seule écoute à la fois (la seconde est refusée `speech-busy`), limite de 60 s tenue ici (le plugin reçoit `stop`
/// avec la cause `time-limit` et rend le texte déjà reconnu), délai global puis `speech-timeout`.
pub async fn listen_with(transport: Arc<dyn SpeechTransport>, state: &SpeechState, locale: &str, limits: Limits) -> Result<ListenOutcome, SpeechCommandError> {
    if locale != LOCALE {
        return Err(SpeechCommandError::new("speech-failed", "invalid-argument"));
    }
    let guard = state.acquire().ok_or_else(|| SpeechCommandError::new("speech-busy", "busy"))?;

    // Minuteur de la limite : demande l'arrêt, ne rend rien lui-même (le texte arrive par la réponse de `listen`).
    let timer_transport = transport.clone();
    let timer = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(limits.max_listen).await;
        let _ = tauri::async_runtime::spawn_blocking(move || call_with_deadline(move || timer_transport.call("stop", json!({ "reason": "time-limit" })), limits.stop)).await;
    });

    let plugin = transport.clone();
    let args = json!({ "locale": locale, "maxDurationMs": limits.swift_cap.as_millis() as u64 });
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        call_with_deadline(
            move || {
                // Le drapeau suit l'appel de Swift jusqu'à sa vraie fin, même si Rust a cessé d'attendre.
                let _guard = guard;
                plugin.call("listen", args)
            },
            limits.listen_deadline,
        )
    })
    .await;
    timer.abort();

    let response = match outcome {
        Ok(Ok(value)) => value,
        Ok(Err(CallError::Timeout)) => return Err(SpeechCommandError::new("speech-timeout", "timeout")),
        Ok(Err(CallError::Rejected(code))) => return Err(SpeechCommandError::new(listen_code_of(&code), &code)),
        Err(_) => return Err(SpeechCommandError::new("speech-failed", "failed")),
    };
    let text: String = response.get("text").and_then(Value::as_str).unwrap_or("").chars().take(MAX_TEXT_CHARS).collect();
    Ok(ListenOutcome { text, stopped_by: stopped_by(response.get("stoppedBy")) })
}

/// `speech_stop` (bloquant) : sans écoute en cours, aucun effet (le plugin n'est pas appelé) ; n'échoue jamais.
pub fn stop_with(transport: &Arc<dyn SpeechTransport>, state: &SpeechState, limits: &Limits) -> StopOutcome {
    if !state.is_listening() {
        return StopOutcome { stopped: false };
    }
    let plugin = transport.clone();
    match call_with_deadline(move || plugin.call("stop", json!({ "reason": "user" })), limits.stop) {
        Ok(response) => StopOutcome { stopped: flag(&response, "stopped") },
        Err(_) => StopOutcome { stopped: false },
    }
}

/// `app_settings_open` (bloquant) : la page de l'app dans Réglages iOS. Erreur : `settings-open-failed` (délai compris).
pub fn open_settings_with(transport: &Arc<dyn SpeechTransport>, limits: &Limits) -> Result<SettingsOutcome, SpeechCommandError> {
    let plugin = transport.clone();
    let response = call_with_deadline(move || plugin.call("openAppSettings", json!({})), limits.settings)
        .map_err(|error| SpeechCommandError::new("settings-open-failed", &detail_of(&error)))?;
    Ok(SettingsOutcome { opened: flag(&response, "opened") })
}
