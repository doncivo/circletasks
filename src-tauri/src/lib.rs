//! Point d'entrée commun PC (Windows) et iPhone (iOS).
//!
//! Les commandes Rust, la zone de notification, les raccourcis et l'OCR Windows
//! s'ajouteront ici (agent desktop-tauri) ; les plugins Swift iOS dans `plugins/`.
//! Les migrations de schéma sont gérées côté TypeScript (src/db/migrator.ts, ADR 0002) :
//! aucune migration n'est déclarée dans tauri-plugin-sql.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("échec du démarrage de CircleTasks");
}
