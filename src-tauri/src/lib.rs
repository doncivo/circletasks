//! Point d'entrée commun PC (Windows) et iPhone (iOS).
//!
//! PC : zone de notification, démarrage avec Windows, instance unique et mise à jour sont dans
//! `desktop` (D-01 à D-03, ADR 0006). Les raccourcis globaux et l'OCR s'y ajouteront (Q-01, D-04).
//! Les plugins Swift iOS sont dans `plugins/`.
//! Les migrations de schéma sont gérées côté TypeScript (src/db/migrator.ts, ADR 0002) :
//! aucune migration n'est déclarée dans tauri-plugin-sql.

pub mod backup;
pub mod calendars;
#[cfg(desktop)]
pub mod capture;
#[cfg(desktop)]
pub mod desktop;
#[cfg(desktop)]
pub mod export;
#[cfg(desktop)]
pub mod ocr;
#[cfg(desktop)]
pub mod shortcut;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop::configure(builder).manage(export::ExportState::default()).invoke_handler(tauri::generate_handler![desktop::set_tray_labels, desktop::confirm_quit, shortcut::set_quick_capture_shortcut, shortcut::clear_quick_capture_shortcut, shortcut::get_quick_capture_shortcut, export::export_save_file, export::reveal_exported_file, capture::hide_quick_capture, capture::resize_quick_capture, capture::submit_quick_capture, capture::request_capture_context, capture::capture_setup_error, ocr::ocr_status, ocr::ocr_recognize, backup::backup_database_before_migration, calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![backup::backup_database_before_migration, calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http]);
    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("échec du démarrage de CircleTasks");
}
