//! Raccourci clavier global « Capture rapide » (D-04, ADR 0006) : validation d'une combinaison,
//! enregistrement auprès du système par `tauri-plugin-global-shortcut`, remplacement atomique.
//!
//! La combinaison est écrite dans la notation du registre du front (`Ctrl+Alt+Space`,
//! `Ctrl+Shift+Q`, `Alt+F9`) : un seul format entre le réglage, l'aide (P-08) et ce module.
//! Aucun texte d'interface ici : le front traduit les codes d'erreur.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Combinaison d'origine de la capture rapide (PRD section 5).
pub const DEFAULT_QUICK_CAPTURE: &str = "Ctrl+Alt+Space";

/// Raisons d'un refus ; le front associe un message français à chaque code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutError {
    /// Chaîne illisible, touche inconnue ou modificateur répété.
    Syntax,
    /// Ni Ctrl ni Alt (Maj seule ne suffit pas).
    NoModifier,
    /// Touche Windows : réservée au système.
    WindowsKey,
    /// Combinaison réservée par Windows ou raccourci universel (copier, coller…).
    Reserved,
    /// Déjà prise par une autre application.
    InUse,
    /// Le système refuse l'enregistrement pour une autre raison.
    Unavailable,
}

impl ShortcutError {
    /// Code stable renvoyé au front.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Syntax => "shortcut-syntax",
            Self::NoModifier => "shortcut-no-modifier",
            Self::WindowsKey => "shortcut-windows-key",
            Self::Reserved => "shortcut-reserved",
            Self::InUse => "shortcut-in-use",
            Self::Unavailable => "shortcut-unavailable",
        }
    }
}

/// Combinaison analysée : modificateurs et touche principale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Touche en notation du registre : `A`, `1`, `F5`, `Space`, `Enter`, `ArrowUp`…
    pub key: String,
}

impl Chord {
    fn with_key(&self, ctrl: &'static str, key: &str) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if self.ctrl {
            parts.push(ctrl);
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        parts.push(key);
        parts.join("+")
    }

    /// Notation canonique : `Ctrl+Alt+Shift+Touche`.
    pub fn canonical(&self) -> String {
        self.with_key("Ctrl", &self.key)
    }

    /// Chaîne comprise par le plugin (`Control+Alt+KeyA`, `Control+Digit1`, `Alt+F9`).
    fn plugin_string(&self) -> String {
        let key = match self.key.as_str() {
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_uppercase()) => format!("Key{k}"),
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_digit()) => format!("Digit{k}"),
            k => k.to_owned(),
        };
        self.with_key("Control", &key)
    }
}

const NAMED_KEYS: &[&str] = &[
    "Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp",
    "ArrowDown", "ArrowLeft", "ArrowRight",
];

const WINDOWS_KEYS: &[&str] = &["Super", "Win", "Windows", "Meta", "Cmd", "Command"];

fn is_valid_key(key: &str) -> bool {
    if key.len() == 1 {
        return key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    }
    if NAMED_KEYS.contains(&key) {
        return true;
    }
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n))
}

/// Combinaisons réservées (notation canonique) : fonctions du système et raccourcis universels
/// qu'un raccourci global casserait dans toutes les applications.
const RESERVED: &[&str] = &[
    "Ctrl+Alt+Delete",
    "Ctrl+Shift+Escape",
    "Ctrl+Escape",
    "Alt+Escape",
    "Alt+Tab",
    "Alt+Shift+Tab",
    "Ctrl+Alt+Tab",
    "Alt+F4",
    "Alt+Space",
    "Alt+Enter",
    "Ctrl+Shift+Delete",
    "Ctrl+C",
    "Ctrl+X",
    "Ctrl+V",
    "Ctrl+A",
    "Ctrl+Z",
    "Ctrl+Y",
];

/// Analyse et valide une combinaison globale (D-04, critères 6 et 11).
///
/// Refus : syntaxe, aucun Ctrl ni Alt, touche Windows, combinaison réservée. Les conflits avec les
/// raccourcis de l'application sont contrôlés par le front, qui détient le registre.
pub fn parse_chord(text: &str) -> Result<Chord, ShortcutError> {
    let mut parts: Vec<&str> = text.split('+').collect();
    let key = parts.pop().filter(|k| !k.is_empty()).ok_or(ShortcutError::Syntax)?;
    let mut chord = Chord { ctrl: false, alt: false, shift: false, key: key.to_owned() };
    for modifier in parts {
        let flag = match modifier {
            "Ctrl" => &mut chord.ctrl,
            "Alt" => &mut chord.alt,
            "Shift" => &mut chord.shift,
            m if WINDOWS_KEYS.contains(&m) => return Err(ShortcutError::WindowsKey),
            _ => return Err(ShortcutError::Syntax),
        };
        if *flag {
            return Err(ShortcutError::Syntax);
        }
        *flag = true;
    }
    if WINDOWS_KEYS.contains(&key) {
        return Err(ShortcutError::WindowsKey);
    }
    if !is_valid_key(key) {
        return Err(ShortcutError::Syntax);
    }
    if !chord.ctrl && !chord.alt {
        return Err(ShortcutError::NoModifier);
    }
    if RESERVED.contains(&chord.canonical().as_str()) {
        return Err(ShortcutError::Reserved);
    }
    Ok(chord)
}

/// Combinaison actuellement enregistrée auprès du système (état géré par Tauri).
#[derive(Default)]
pub struct QuickCaptureShortcut {
    current: Mutex<Option<Chord>>,
}

impl QuickCaptureShortcut {
    fn lock(&self) -> MutexGuard<'_, Option<Chord>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Erreur de commande `{ code, message }` (ADR 0001).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<ShortcutError> for ShortcutCommandError {
    fn from(error: ShortcutError) -> Self {
        Self { code: error.code(), message: format!("{error:?}") }
    }
}

fn to_shortcut(chord: &Chord) -> Result<Shortcut, ShortcutError> {
    chord.plugin_string().parse::<Shortcut>().map_err(|_| ShortcutError::Syntax)
}

/// Cause d'un échec d'enregistrement : `InUse` seulement si le système dit la combinaison déjà enregistrée, sinon `Unavailable`.
pub fn classify_register_error(message: &str) -> ShortcutError {
    if message.to_lowercase().contains("already registered") {
        ShortcutError::InUse
    } else {
        ShortcutError::Unavailable
    }
}

/// Enregistre `chord` puis retire l'ancienne : en cas d'échec, l'ancienne reste active.
fn replace(app: &AppHandle, state: &QuickCaptureShortcut, chord: Chord) -> Result<(), ShortcutError> {
    let mut current = state.lock();
    let new = to_shortcut(&chord)?;
    let manager = app.global_shortcut();
    if current.as_ref() == Some(&chord) && manager.is_registered(new) {
        return Ok(());
    }
    // La nouvelle est enregistrée avant de libérer l'ancienne : jamais sans raccourci en cas d'échec.
    manager.register(new).map_err(|e| classify_register_error(&e.to_string()))?;
    if let Some(old) = current.as_ref().and_then(|c| to_shortcut(c).ok()) {
        let _ = manager.unregister(old);
    }
    *current = Some(chord);
    Ok(())
}

/// Enregistre la capture rapide globale (D-04) ; remplace l'ancienne combinaison sans redémarrage.
///
/// `accelerator` : notation du registre (`Ctrl+Alt+Space`). Erreurs `{ code, message }` :
/// `shortcut-syntax`, `shortcut-no-modifier`, `shortcut-windows-key`, `shortcut-reserved`,
/// `shortcut-in-use` (prise par une autre application ; l'ancienne reste active).
#[tauri::command]
pub fn set_quick_capture_shortcut(
    app: AppHandle,
    state: State<'_, QuickCaptureShortcut>,
    accelerator: String,
) -> Result<(), ShortcutCommandError> {
    let chord = parse_chord(&accelerator)?;
    replace(&app, &state, chord).map_err(Into::into)
}

/// Retire la capture rapide globale (interrupteur « Désactiver »). Sans effet si rien n'est enregistré.
/// Erreur : `shortcut-unavailable` si le système refuse de libérer la combinaison.
#[tauri::command]
pub fn clear_quick_capture_shortcut(app: AppHandle, state: State<'_, QuickCaptureShortcut>) -> Result<(), ShortcutCommandError> {
    let mut current = state.lock();
    if let Some(shortcut) = current.as_ref().and_then(|c| to_shortcut(c).ok()) {
        app.global_shortcut().unregister(shortcut).map_err(|e| ShortcutCommandError {
            code: ShortcutError::Unavailable.code(),
            message: e.to_string(),
        })?;
    }
    *current = None;
    Ok(())
}

/// Combinaison actuellement enregistrée (notation du registre), `None` si aucune.
#[tauri::command]
pub fn get_quick_capture_shortcut(state: State<'_, QuickCaptureShortcut>) -> Option<String> {
    state.lock().as_ref().map(Chord::canonical)
}

/// Plugin global-shortcut : à l'appui, la mini-fenêtre de capture rapide s'ouvre ou se ferme (Q-01).
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::capture::trigger(app);
            }
        })
        .build()
}

/// État géré à poser dans `setup`.
pub fn manage(app: &AppHandle) {
    app.manage(QuickCaptureShortcut::default());
}
