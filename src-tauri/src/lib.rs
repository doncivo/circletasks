//! Point d'entrée commun PC (Windows) et iPhone (iOS).
//!
//! PC : zone de notification, démarrage avec Windows, instance unique et mise à jour sont dans
//! `desktop` (D-01 à D-03, ADR 0006). Les raccourcis globaux et l'OCR s'y ajouteront (Q-01, D-04).
//! Les plugins Swift iOS sont dans `plugins/`.
//! Les migrations de schéma sont gérées côté TypeScript (src/db/migrator.ts, ADR 0002) :
//! aucune migration n'est déclarée dans tauri-plugin-sql.

/// Journal technique persistant (I-04, ADR 0014) : PC et iPhone.
pub mod applog;
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
/// Règles d'export communes au PC et à l'iPhone (taille, nom, extension, type ; ADR 0009 avenant lot F A3).
pub mod export_common;
/// Export sur iPhone par le plugin ct-files (FILES-IOS-01) ; compilé aussi sous `test-hooks` pour les tests Windows (faux transport).
#[cfg(any(target_os = "ios", feature = "test-hooks"))]
pub mod export_ios;
#[cfg(desktop)]
pub mod import;
/// Démarrage de l'iPhone (`setup`) : journal technique, purge des temporaires d'export.
#[cfg(target_os = "ios")]
mod ios_setup;
/// OCR : Windows.Media.Ocr sur PC, Vision sur iPhone (CAP-IOS-01, ADR 0015).
#[cfg(any(desktop, target_os = "ios"))]
pub mod ocr;
#[cfg(desktop)]
pub mod shortcut;
/// Expiration de la signature SideStore (I-02, ADR 0013 section 3) : analyse compilée partout, commande iOS seulement.
pub mod signing;
/// Appel des plugins Swift avec délai (ADR 0015 §3.1) ; compilé partout, testé avec un faux.
pub mod mobile_call;
/// Dictée sur l'appareil et Réglages iOS (CAP-IOS-01, ADR 0015 §2) ; la logique est testée sous Windows, les commandes sont iOS.
pub mod speech;
/// Démarrage sûr et restauration (P-04-iOS) : porte de démarrage, plugin SQL enregistré après la récupération (iPhone), marqueur en attente.
pub mod startup_gate;
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
        backup::backup_database_before_migration, backup::db_diagnostics, backup::daily_backup, backup::list_backups, backup::check_backup, backup::restore_backup, backup::reveal_backups_folder, startup_gate::backup_restore_marker_write,
        calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http,
        // Mini-fenêtre Focus ouverte par Rust (correctif F-01, ADR 0011 section 2.1).
        focus_window::focus_window_open, focus_window::focus_window_bring_to_front, focus_window::focus_window_close,
        // Synchronisation (ADR 0011 section 11.1) : 21 commandes pour `main`, 3 pour `pairing`.
        sync::commands::sync_folder_info, sync::commands::sync_folder_choose, sync::commands::sync_folder_forget, sync::commands::sync_bind_device,
        sync::commands::sync_key_status, sync::commands::sync_key_create, sync::commands::sync_pairing_open, sync::commands::sync_pairing_payload,
        sync::commands::sync_key_import, sync::commands::sync_pairing_close, sync::commands::sync_scan, sync::commands::sync_read_journal,
        sync::commands::sync_append_journal, sync::commands::sync_write_state, sync::commands::sync_snapshot_begin, sync::commands::sync_snapshot_append,
        sync::commands::sync_snapshot_commit, sync::commands::sync_read_snapshot, sync::commands::sync_delete_own, sync::commands::sync_abandon_orphan_epoch, sync::commands::sync_restore_marker_get,
        sync::commands::sync_restore_marker_clear,
        // Lot Y4 (ADR 0011 section 18, étape 0) : corps qui répondent `not-configured` jusqu'à Y-10 et Y-11.
        sync::commands::sync_device_forget, sync::commands::sync_forgotten_delete, sync::commands::sync_reset_key,
        // Journal technique (I-04, ADR 0014 §2) : capability logs.json (fenêtre main).
        applog::log_append, applog::log_read, applog::log_clear,
    ]);
    // PC : plugin SQL après les plugins PC (l'instance unique reste le premier) (la fenêtre principale n'est créée qu'après la récupération, `desktop.rs`) ; marqueur de restauration
    // en attente (P-04-iOS critère 12, PC compris).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_sql::Builder::default().build()).manage(startup_gate::PendingRestoreMarker::default());
    // iPhone (ADR 0011 §22 point 7, §23 point 2) : plugin folder-bookmark (appelé par Rust seul), scan du QR (JS), service de synchro.
    // Android non géré, volontairement : ni plugin ni commandes (seuls le PC Windows et l'iPhone sont livrés).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_folder_bookmark::init()).plugin(tauri_plugin_web_auth::init()).plugin(tauri_plugin_reminders::init()).plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_vision::init()).plugin(tauri_plugin_speech::init()).manage(ocr::vision::VisionState::default()).manage(speech::SpeechState::default()).manage(sync::commands_ios::SyncState::default());
    // FILES-IOS-01 : plugin ct-files (sélecteur « Enregistrer dans Fichiers », appelé par Rust seul) et état de l'export ; purge des
    // temporaires restants au démarrage (`ios_setup`).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ct_files::init()).manage(export_ios::ExportIosState::default()).setup(ios_setup::setup);
    // P-04-iOS (ADR 0009 avenant lot F B3) : PAS de plugin SQL ici ; `ios_setup` l'enregistre après la récupération d'une restauration
    // interrompue (`startup_gate`), la porte et le marqueur en attente sont gérés.
    #[cfg(target_os = "ios")]
    let builder = builder.manage(startup_gate::StartupGate::default()).manage(startup_gate::PendingRestoreMarker::default());
    #[cfg(target_os = "ios")]
    let builder = builder.invoke_handler(tauri::generate_handler![backup::backup_database_before_migration, backup::db_diagnostics, calendars::calendar_secret_set, calendars::calendar_secret_exists, calendars::calendar_secret_delete, calendars::calendar_oauth_google_authorize, calendars::calendar_oauth_google_revoke, calendars::calendar_http,
        // Synchronisation sur iPhone (ADR 0011 §22 point 7, Y-IOS-01) : commandes de `main`, aucune de la fenêtre `pairing`.
        sync::commands_ios::sync_folder_info, sync::commands_ios::sync_folder_choose, sync::commands_ios::sync_folder_forget, sync::commands_ios::sync_bind_device,
        sync::commands_ios::sync_key_status, sync::commands_ios::sync_key_create, sync::commands_ios::sync_scan, sync::commands_ios::sync_read_journal,
        sync::commands_ios::sync_append_journal, sync::commands_ios::sync_write_state, sync::commands_ios::sync_snapshot_begin, sync::commands_ios::sync_snapshot_append,
        sync::commands_ios::sync_snapshot_commit, sync::commands_ios::sync_read_snapshot, sync::commands_ios::sync_delete_own, sync::commands_ios::sync_abandon_orphan_epoch, sync::commands_ios::sync_restore_marker_get,
        sync::commands_ios::sync_restore_marker_clear, sync::commands_ios::sync_forgotten_delete,
        // Y-IOS-02 (ADR 0011 §23 point 5) : clé reçue dans `main`, oubli, réinitialisation (confirmations natives de l'iPhone).
        sync::commands_ios::sync_key_import, sync::commands_ios::sync_device_forget, sync::commands_ios::sync_reset_key,
        // FILES-IOS-01 (ADR 0009 avenant lot F A3) : même commande et même permission qu'au PC, temporaire remis au plugin ct-files.
        export_ios::export_save_file,
        // P-04-iOS (ADR 0009 avenant lot F B1) : sauvegarde et restauration sur iPhone ; `reveal_backups_folder` reste PC.
        backup::daily_backup, backup::list_backups, backup::check_backup, backup::restore_backup, startup_gate::backup_startup_status, startup_gate::backup_set_aside_conflicts, startup_gate::backup_restore_marker_write,
        // Journal technique (I-04, ADR 0014 §2) : capability logs-ios.json.
        applog::log_append, applog::log_read, applog::log_clear,
        // I-02 (ADR 0013 section 3.1) : dates du profil de signature (lecture de embedded.mobileprovision), iOS seulement.
        signing::app_signing_info,
        // CAP-IOS-01 (ADR 0015) : Vision derrière les commandes OCR du PC, dictée sur l'appareil, Réglages iOS. Rust seul appelle les plugins.
        ocr::ocr_status, ocr::ocr_recognize, speech::ios::speech_status, speech::ios::speech_request_permissions, speech::ios::speech_listen, speech::ios::speech_stop, speech::ios::app_settings_open,
    ]);
    // N-01 : notifications locales de l'iPhone (rappels, ADR 0012 N1.1). Aucune ligne sous cfg(desktop) : le PC n'envoie aucune notification.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // N-03 : enregistré APRÈS le plugin officiel (un seul délégué des notifications existe : celui-ci prend sa place, ADR 0012 avenant N-03 N3.1).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_notification_actions::init());
    // Lot M (ADR 0013) : Face ID (I-03), retour haptique (A-07), cache de confidentialité natif (I-03). iOS seulement.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_biometric::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ct_haptics::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_privacy_shield::init());
    // CAP-IOS-01 : copies temporaires de photos supprimées au lancement : dans `ios_setup` (un seul `setup` : un second remplacerait le
    // premier et le plugin SQL ne serait jamais enregistré).
    builder
        .run(tauri::generate_context!())
        .expect("échec du démarrage de CircleTasks");
}
