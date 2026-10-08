//! Plugin Swift notification-actions de CircleTasks (ADR 0012 avenant N-03) : prend la place du délégué `UNUserNotificationCenterDelegate`
//! du plugin officiel `tauri-plugin-notification`, enregistre les catégories et actions (« Fait », « +15 min »), et écrit chaque action
//! reçue (y compris app tuée) dans un fichier durable que la WebView tire par `drain` puis acquitte par `ack`.
//!
//! Aucune commande Rust : toutes sont transmises à Swift (voir `build.rs`). Le crate n'existe que dans la cible iOS (dépendance sous
//! `cfg(target_os = "ios")` dans `src-tauri/Cargo.toml`) : le PC n'a ni plugin ni capability, il n'envoie aucune notification.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_notification_actions);

/// Enregistre le plugin (bloc iOS de `lib.rs` de l'app, APRÈS le plugin officiel : son `init` Swift prend le délégué en second).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notification-actions")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            {
                let _handle = api.register_ios_plugin(init_plugin_notification_actions)?;
            }
            #[cfg(not(target_os = "ios"))]
            {
                let _ = api;
            }
            Ok(())
        })
        .build()
}
