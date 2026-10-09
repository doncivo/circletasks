//! Commandes de la dictée et des Réglages de l'iPhone (CAP-IOS-01, ADR 0015 §2.1) : transport du plugin Swift `speech`. La logique est dans
//! `super` (testée sous Windows) ; ici, seulement le branchement et les déclarations `#[tauri::command]`.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::{
    open_settings_with, request_permissions_with, status_with, stop_with, ListenOutcome, Limits, SettingsOutcome, SpeechCommandError, SpeechPermissions, SpeechState, SpeechStatus,
    SpeechTransport, StopOutcome,
};

/// Transport de production : le plugin Swift `tauri-plugin-speech`.
struct PluginTransport<R: Runtime>(tauri_plugin_speech::Speech<R>);

impl<R: Runtime> SpeechTransport for PluginTransport<R> {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.0.call(command, args)
    }
}

/// Plugin absent (non enregistré) : chaque appel rend `unavailable`, jamais un silence.
struct AbsentTransport;

impl SpeechTransport for AbsentTransport {
    fn call(&self, _command: &str, _args: Value) -> Result<Value, String> {
        Err("unavailable".to_owned())
    }
}

fn transport_of<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn SpeechTransport> {
    match app.try_state::<tauri_plugin_speech::Speech<R>>() {
        Some(plugin) => Arc::new(PluginTransport(plugin.inner().clone())),
        None => Arc::new(AbsentTransport),
    }
}

fn state_of<R: Runtime>(app: &AppHandle<R>) -> SpeechState {
    app.try_state::<SpeechState>().map(|state| state.inner().clone()).unwrap_or_default()
}

/// État du service de dictée et des deux autorisations, **lu** sans rien demander (aucune fenêtre d'iOS). N'échoue jamais.
#[tauri::command]
pub async fn speech_status<R: Runtime>(app: AppHandle<R>) -> SpeechStatus {
    let transport = transport_of(&app);
    tauri::async_runtime::spawn_blocking(move || status_with(&transport, &Limits::default()))
        .await
        .unwrap_or(SpeechStatus { available: false, on_device: false, microphone: "unknown", speech_recognition: "unknown", reason: Some("plugin-unavailable") })
}

/// Demande le micro puis la reconnaissance vocale (appelée seulement depuis « Continuer », I-05). Erreur : `speech-unavailable`.
#[tauri::command]
pub async fn speech_request_permissions<R: Runtime>(app: AppHandle<R>) -> Result<SpeechPermissions, SpeechCommandError> {
    let transport = transport_of(&app);
    tauri::async_runtime::spawn_blocking(move || request_permissions_with(&transport, &Limits::default()))
        .await
        .map_err(|_| SpeechCommandError { code: "speech-unavailable", message: "failed".to_owned() })?
}

/// Écoute en français, sur l'appareil, puis rend le texte. Erreurs : `speech-microphone-denied`, `speech-recognition-denied`,
/// `speech-on-device-unavailable`, `speech-busy`, `speech-audio-unavailable`, `speech-unavailable`, `speech-timeout`, `speech-failed`.
#[tauri::command]
pub async fn speech_listen<R: Runtime>(app: AppHandle<R>, locale: String) -> Result<ListenOutcome, SpeechCommandError> {
    super::listen_with(transport_of(&app), &state_of(&app), &locale, Limits::default()).await
}

/// Arrête l'écoute en cours (« Terminer », arrière-plan, verrou) ; sans écoute, aucun effet.
#[tauri::command]
pub async fn speech_stop<R: Runtime>(app: AppHandle<R>) -> StopOutcome {
    let transport = transport_of(&app);
    let state = state_of(&app);
    tauri::async_runtime::spawn_blocking(move || stop_with(&transport, &state, &Limits::default())).await.unwrap_or(StopOutcome { stopped: false })
}

/// Ouvre la page de l'app dans Réglages iOS. Erreur : `settings-open-failed`.
#[tauri::command]
pub async fn app_settings_open<R: Runtime>(app: AppHandle<R>) -> Result<SettingsOutcome, SpeechCommandError> {
    let transport = transport_of(&app);
    tauri::async_runtime::spawn_blocking(move || open_settings_with(&transport, &Limits::default()))
        .await
        .map_err(|_| SpeechCommandError { code: "settings-open-failed", message: "failed".to_owned() })?
}
