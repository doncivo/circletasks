//! Plugin Swift reminders de CircleTasks (ADR 0008 §10.4, K-05 à K-07) : lit les listes et les rappels d'EventKit choisis par l'utilisateur et
//! écrit titre, échéance et statut terminé d'un rappel (jamais notes, priorité, alertes ajoutées, lieu ni sous-tâches).
//!
//! Aucune commande Rust : toutes sont transmises à Swift (voir `build.rs`). Le crate n'existe que dans la cible iOS (dépendance sous
//! `cfg(target_os = "ios")` dans `src-tauri/Cargo.toml`) : le PC n'a ni plugin ni capability et n'accède jamais à Rappels.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_reminders);

/// Enregistre le plugin (bloc iOS de `lib.rs` de l'app).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("reminders")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            {
                let _handle = api.register_ios_plugin(init_plugin_reminders)?;
            }
            #[cfg(not(target_os = "ios"))]
            {
                let _ = api;
            }
            Ok(())
        })
        .build()
}
