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

#[test]
fn only_the_main_window_may_create_the_focus_window() {
    let capability: Value = serde_json::from_str(LAUNCHER_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let granted = permissions(LAUNCHER_CAPABILITY);
    assert!(granted.contains(&"core:webview:allow-create-webview-window".to_owned()));
    for id in &granted {
        assert!(!id.ends_with(":default") && !id.contains('*'), "{id}");
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
