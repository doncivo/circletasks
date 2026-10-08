//! Plugin Tauri `haptics` de CircleTasks (A-07, ADR 0013 §1.1) : retour haptique iOS. Aucune commande Rust : les appels JS
//! `plugin:haptics|impact_feedback`, `|notification_feedback` et `|selection_feedback` vont directement au Swift (`HapticsPlugin.swift`),
//! qui déclenche les générateurs UIKit sur le fil principal (Tauri appelle les plugins sur une file d'arrière-plan, constat 1 de l'ADR).
//! Enregistré dans le bloc iOS de `lib.rs` de l'app seulement ; aucune clé Info.plist.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ct_haptics);

/// Enregistre le plugin `haptics`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("haptics")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            api.register_ios_plugin(init_plugin_ct_haptics)?;
            #[cfg(not(target_os = "ios"))]
            let _ = api;
            Ok(())
        })
        .build()
}
