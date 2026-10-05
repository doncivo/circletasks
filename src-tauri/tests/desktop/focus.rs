//! Garde-fous de la mini-fenêtre Focus (M10, F-01) : capabilities dédiées, aucune notification, aucune base.

use serde_json::Value;

const FOCUS_CAPABILITY: &str = include_str!("../../capabilities/focus.json");
const LAUNCHER_CAPABILITY: &str = include_str!("../../capabilities/focus-launcher.json");
const SOURCES: [&str; 3] = [
    include_str!("../../src/desktop.rs"),
    include_str!("../../src/shortcut.rs"),
    include_str!("../../src/lib.rs"),
];

fn permissions(source: &str) -> Vec<String> {
    let capability: Value = serde_json::from_str(source).expect("capability valide");
    capability["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .map(|permission| permission.as_str().expect("identifiant").to_owned())
        .collect()
}

#[test]
fn focus_window_capability_is_scoped_to_the_focus_window_on_windows() {
    let capability: Value = serde_json::from_str(FOCUS_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["focus"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
}

#[test]
fn focus_window_only_exchanges_events() {
    // Pas de SQL, pas de commande de l'application, pas de joker ni de permission « default » : seulement les événements.
    let granted = permissions(FOCUS_CAPABILITY);
    assert!(!granted.is_empty());
    for id in &granted {
        assert!(id.starts_with("core:event:allow-"), "{id}");
        assert!(!id.ends_with(":default") && !id.contains('*'), "{id}");
    }
}

/// Correctif F-01 (ADR 0011 section 2.1, troisième audit H1) : la fenêtre principale n'ouvre la mini-fenêtre que par trois commandes
/// Rust ; aucune permission de création, d'affichage, de focus ni de destruction de fenêtre.
#[test]
fn only_the_main_window_may_open_the_focus_window_through_rust_commands() {
    let capability: Value = serde_json::from_str(LAUNCHER_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let granted = permissions(LAUNCHER_CAPABILITY);
    assert_eq!(granted, ["allow-focus-window-open", "allow-focus-window-bring-to-front", "allow-focus-window-close"]);
    assert!(!granted.iter().any(|id| id.starts_with("core:")));
}

/// Libellé, URL et options fixés par Rust ; une position hors des écrans est recentrée (fenêtre centrée).
#[test]
fn focus_window_label_url_and_position_are_fixed_by_rust() {
    use circletasks_lib::focus_window::{is_on_screen, usable_position, FocusPosition, Screen, FOCUS_HEIGHT, FOCUS_URL, FOCUS_WIDTH, FOCUS_WINDOW};
    assert_eq!(FOCUS_WINDOW, "focus");
    assert_eq!(FOCUS_URL, "index.html?window=focus");
    assert_eq!((FOCUS_WIDTH, FOCUS_HEIGHT), (340.0, 460.0));
    let screens = [Screen { x: 0, y: 0, width: 1920, height: 1080 }, Screen { x: 1920, y: 0, width: 1280, height: 1024 }];
    assert!(is_on_screen(FocusPosition { x: 100, y: 100 }, &screens));
    assert!(is_on_screen(FocusPosition { x: 2000, y: 900 }, &screens));
    assert!(is_on_screen(FocusPosition { x: -40, y: 0 }, &screens));
    assert!(!is_on_screen(FocusPosition { x: 1920 + 1280, y: 10 }, &screens), "écran débranché");
    assert!(!is_on_screen(FocusPosition { x: 100, y: -5 }, &screens));
    assert!(!is_on_screen(FocusPosition { x: 100, y: 1000 }, &screens[..1]));
    assert_eq!(usable_position(Some(FocusPosition { x: 5000, y: 5000 }), &screens), None);
    assert_eq!(usable_position(Some(FocusPosition { x: 10, y: 10 }), &screens), Some(FocusPosition { x: 10, y: 10 }));
    assert_eq!(usable_position(None, &screens), None);
    let source = include_str!("../../src/focus_window.rs");
    for option in [".always_on_top(true)", ".skip_taskbar(true)", ".resizable(false)", ".maximizable(false)", ".minimizable(false)"] {
        assert!(source.contains(option), "{option}");
    }
}

#[test]
fn pc_never_sends_a_notification_for_focus() {
    // PRD section 7 : le PC n'émet que le son de fin de Focus ; aucun module Rust n'utilise de notification.
    for source in SOURCES {
        assert!(!source.contains("tauri_plugin_notification"), "plugin de notification présent");
        assert!(!source.contains("notification::"), "API de notification présente");
    }
}
