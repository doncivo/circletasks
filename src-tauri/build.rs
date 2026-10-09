//! Les commandes applicatives sont déclarées dans un manifeste : Tauri génère une permission
//! `allow-<commande>` par commande, et seules les capabilities qui la citent peuvent l'appeler
//! (permissions minimales, D-01). À mettre à jour avec `desktop::set_tray_labels`.

/// Identifiants client OAuth Google (ADR 0008 section 5, docs/stories/K-01.md) : variable d'environnement du build, sinon fichier `.env`
/// local à la racine du dépôt (ignoré par git). Jamais commités ; absents : l'app affiche « non configuré ».
const BUILD_SECRETS: [&str; 3] = ["CT_GOOGLE_CLIENT_ID", "CT_GOOGLE_CLIENT_SECRET", "CT_GOOGLE_IOS_CLIENT_ID"];

fn forward_local_env() {
    let dotenv = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("..").join(".env");
    println!("cargo:rerun-if-changed={}", dotenv.display());
    for key in BUILD_SECRETS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let Ok(text) = std::fs::read_to_string(&dotenv) else { return };
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim().trim_matches('"').trim_matches('\''));
        if BUILD_SECRETS.contains(&key) && !value.is_empty() && std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    forward_local_env();
    // Exécutables de test sous Windows : manifeste comctl32 v6 (voir windows-test.manifest).
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        if std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc") {
            println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_tray_labels", "confirm_quit", "set_quick_capture_shortcut", "clear_quick_capture_shortcut", "get_quick_capture_shortcut", "backup_database_before_migration", "db_diagnostics",
            // Sauvegarde quotidienne et restauration (P-04) : PC uniquement.
            "daily_backup", "list_backups", "check_backup", "restore_backup", "reveal_backups_folder",
            // Import CSV (P-07) : PC uniquement.
            "import_open_file",
            // Capture rapide (Q-01) : PC uniquement. OCR (Q-04, Windows ; CAP-IOS-01, Vision sur iPhone) : PC et iPhone.
            "export_save_file", "reveal_exported_file", "hide_quick_capture", "resize_quick_capture", "submit_quick_capture", "request_capture_context", "capture_setup_error", "ocr_status", "ocr_recognize",
            // Dictée sur l'appareil et Réglages iOS (CAP-IOS-01, ADR 0015) : iPhone uniquement.
            "speech_status", "speech_request_permissions", "speech_listen", "speech_stop", "app_settings_open",
            // Agendas externes (ADR 0008) : PC et iPhone.
            "calendar_secret_set", "calendar_secret_exists", "calendar_secret_delete",
            "calendar_oauth_google_authorize", "calendar_oauth_google_revoke", "calendar_http",
            // Mini-fenêtre Focus ouverte par Rust (correctif F-01 du lot Y1) : `main` ne crée plus aucune fenêtre.
            "focus_window_open", "focus_window_bring_to_front", "focus_window_close",
            // Synchronisation (ADR 0011 section 11.1) : 24 commandes ; capabilities sync.json (main, 21) et sync-pairing.json (pairing, 3).
            "sync_folder_info", "sync_folder_choose", "sync_folder_forget", "sync_bind_device", "sync_key_status", "sync_key_create",
            "sync_pairing_open", "sync_pairing_payload", "sync_key_import", "sync_pairing_close", "sync_scan", "sync_read_journal",
            "sync_append_journal", "sync_write_state", "sync_snapshot_begin", "sync_snapshot_append", "sync_snapshot_commit",
            "sync_read_snapshot", "sync_delete_own", "sync_restore_marker_get", "sync_restore_marker_clear",
            // Lot Y4 (ADR 0011 sections 11.1 et 18, étape 0) : Y-10 (oubli, suppression des fichiers d'un appareil oublié) et Y-11.
            "sync_device_forget", "sync_forgotten_delete", "sync_reset_key",
            // Journal technique persistant (I-04, ADR 0014 §2) : PC et iPhone, capabilities logs.json et logs-ios.json.
            "log_append", "log_read", "log_clear",
            // P-04-iOS (ADR 0009 avenant lot F B3) : issue de la récupération au démarrage (iPhone).
            "backup_startup_status", "backup_set_aside_conflicts",
        ])),
    )
    .expect("échec de la configuration de la compilation Tauri");
}
