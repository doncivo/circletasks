//! P-04 : la fenêtre principale est créée par `setup` après la récupération d'une restauration interrompue (configuration `create: false`).

use circletasks_lib::desktop::{build_window_from_config, recovery_failed_text, MAIN_WINDOW, RECOVERY_FAILED_MESSAGE};
use tauri::utils::config::WindowConfig;
use tauri::Manager;

const WINDOWS_CONF: &str = include_str!("../../tauri.windows.conf.json");

fn main_config() -> WindowConfig {
    let value: serde_json::Value = serde_json::from_str(WINDOWS_CONF).expect("tauri.windows.conf.json valide");
    serde_json::from_value(value["app"]["windows"][0].clone()).expect("configuration de fenêtre")
}

#[test]
fn the_windows_configuration_does_not_let_tauri_create_the_main_window() {
    let config = main_config();
    assert_eq!(config.label, MAIN_WINDOW);
    assert!(!config.create, "create: false — la fenêtre est construite par setup");
    assert!(!config.visible, "démarrage masqué");
}

#[test]
fn build_window_from_config_creates_the_main_window_once_and_hidden() {
    let app = tauri::test::mock_app();
    let handle = app.handle();
    assert!(handle.get_webview_window(MAIN_WINDOW).is_none(), "aucune fenêtre avant la construction explicite");
    build_window_from_config(handle, &main_config()).expect("création");
    assert!(handle.get_webview_window(MAIN_WINDOW).is_some(), "fenêtre créée");
    // Idempotent : un second appel ne crée pas de doublon.
    build_window_from_config(handle, &main_config()).expect("deuxième appel");
    assert_eq!(handle.webview_windows().len(), 1);
}

#[test]
fn the_failure_dialog_gives_the_code_and_a_next_step_without_a_personal_path() {
    let text = recovery_failed_text("recovery-conflict", "fr.circletasks.planner");
    assert!(text.starts_with(RECOVERY_FAILED_MESSAGE));
    assert!(text.contains("recovery-conflict"));
    assert!(text.contains("%APPDATA%\\fr.circletasks.planner"));
    assert!(text.contains(".restore-old") && text.contains(".restoring") && text.contains("restore-marker.json"));
    assert!(!text.contains("Users"));
    for code in ["no-data-dir", "window-failed"] {
        assert!(recovery_failed_text(code, "fr.circletasks.planner").contains(code), "{code}");
    }
}
