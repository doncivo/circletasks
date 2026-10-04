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
pub mod desktop;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop::configure(builder).invoke_handler(tauri::generate_handler![desktop::set_tray_labels, desktop::confirm_quit, backup::backup_database_before_migration]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![backup::backup_database_before_migration]);
    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("échec du démarrage de CircleTasks");
}
