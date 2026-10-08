//! Point d'entrée commun PC (Windows) et iPhone (iOS).
//!
//! PC : zone de notification, démarrage avec Windows, instance unique et mise à jour sont dans
//! `desktop` (D-01 à D-03, ADR 0006). Les raccourcis globaux et l'OCR s'y ajouteront (Q-01, D-04).
//! Les plugins Swift iOS sont dans `plugins/`.
//! Les migrations de schéma sont gérées côté TypeScript (src/db/migrator.ts, ADR 0002) :
//! aucune migration n'est déclarée dans tauri-plugin-sql.

pub mod backup;
pub mod backup_triggers;
pub mod calendars;
#[cfg(desktop)]
pub mod focus_window;
#[cfg(desktop)]
pub mod capture;
#[cfg(desktop)]
pub mod desktop;
#[cfg(desktop)]
pub mod export;
#[cfg(desktop)]
pub mod import;
#[cfg(desktop)]
pub mod ocr;
#[cfg(desktop)]
pub mod shortcut;
/// Synchronisation par iCloud Drive (ADR 0011, lot Y1 : Y-08, Y-01).
pub mod sync;
/// Coffre système (agendas, clé de synchro), déplacé de `calendars/vault.rs` au lot Y1.
pub mod vault;
/// Clé de synchro au Trousseau iOS (contrat, ordre 5).
pub mod vault_ios;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop::configure(builder).manage(export::ExportState::default()).manage(sync::commands::SyncState::default()).invoke_handler(tauri::generate_handler![
        desktop::set_tray_labels, desktop::confirm_quit, shortcut::set_quick_capture_shortcut, shortcut::clear_quick_capture_shortcut, shortcut::get_quick_capture_shortcut,
        export::export_save_file, export::reveal_exported_file, import::import_open_file,
        capture::hide_quick_capture, capture::resize_quick_capture, capture::submit_quick_capture, capture::request_capture_context, capture::capture_setup_error,
        ocr::ocr_status, ocr::ocr_recognize,
        backup::backup_database_before_migration, backup::daily_backup, backup::list_backups, backup::check_backup, backup::restore_backup, backup::reveal_backups_folder,
        calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http,
        // Mini-fenêtre Focus ouverte par Rust (correctif F-01, ADR 0011 section 2.1).
        focus_window::focus_window_open, focus_window::focus_window_bring_to_front, focus_window::focus_window_close,
        // Synchronisation (ADR 0011 section 11.1) : 21 commandes pour `main`, 3 pour `pairing`.
        sync::commands::sync_folder_info, sync::commands::sync_folder_choose, sync::commands::sync_folder_forget, sync::commands::sync_bind_device,
        sync::commands::sync_key_status, sync::commands::sync_key_create, sync::commands::sync_pairing_open, sync::commands::sync_pairing_payload,
        sync::commands::sync_key_import, sync::commands::sync_pairing_close, sync::commands::sync_scan, sync::commands::sync_read_journal,
        sync::commands::sync_append_journal, sync::commands::sync_write_state, sync::commands::sync_snapshot_begin, sync::commands::sync_snapshot_append,
        sync::commands::sync_snapshot_commit, sync::commands::sync_read_snapshot, sync::commands::sync_delete_own, sync::commands::sync_restore_marker_get,
        sync::commands::sync_restore_marker_clear,
        // Lot Y4 (ADR 0011 section 18, étape 0) : corps qui répondent `not-configured` jusqu'à Y-10 et Y-11.
        sync::commands::sync_device_forget, sync::commands::sync_forgotten_delete, sync::commands::sync_reset_key,
    ]);
    // iPhone (ADR 0011 §22 point 7, §23 point 2) : plugin folder-bookmark (appelé par Rust seul), scan du QR (JS), service de synchro.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_folder_bookmark::init()).plugin(tauri_plugin_barcode_scanner::init()).manage(sync::commands_ios::SyncState::default());
    #[cfg(target_os = "ios")]
    let builder = builder.invoke_handler(tauri::generate_handler![backup::backup_database_before_migration, calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http,
        // Synchronisation sur iPhone (ADR 0011 §22 point 7, Y-IOS-01) : commandes de `main`, aucune de la fenêtre `pairing`.
        sync::commands_ios::sync_folder_info, sync::commands_ios::sync_folder_choose, sync::commands_ios::sync_folder_forget, sync::commands_ios::sync_bind_device,
        sync::commands_ios::sync_key_status, sync::commands_ios::sync_key_create, sync::commands_ios::sync_scan, sync::commands_ios::sync_read_journal,
        sync::commands_ios::sync_append_journal, sync::commands_ios::sync_write_state, sync::commands_ios::sync_snapshot_begin, sync::commands_ios::sync_snapshot_append,
        sync::commands_ios::sync_snapshot_commit, sync::commands_ios::sync_read_snapshot, sync::commands_ios::sync_delete_own, sync::commands_ios::sync_restore_marker_get,
        sync::commands_ios::sync_restore_marker_clear, sync::commands_ios::sync_forgotten_delete,
        // Y-IOS-02 (ADR 0011 §23 point 5) : clé reçue dans `main`, oubli, réinitialisation (confirmations natives de l'iPhone).
        sync::commands_ios::sync_key_import, sync::commands_ios::sync_device_forget, sync::commands_ios::sync_reset_key,
    ]);
    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("échec du démarrage de CircleTasks");
}
