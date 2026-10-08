//! Plugin Tauri `privacy-shield` de CircleTasks (I-03, ADR 0013 §2.5 ; décision d'Ali du 2026-10-08 : construit dès le lot M). Le cache JS
//! ne couvre que le passage en arrière-plan ; le sélecteur d'apps ouvert sans quitter l'app la laisse seulement inactive. Le Swift pose une
//! vue opaque sur la fenêtre à `willResignActive` et la retire à `didBecomeActive`, si `set_enabled({ enabled: true })` l'a activé.
//! Aucune commande Rust (appel JS direct au Swift) ; enregistré dans le bloc iOS de `lib.rs` de l'app seulement ; aucune clé Info.plist.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_privacy_shield);

/// Enregistre le plugin `privacy-shield`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("privacy-shield")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            api.register_ios_plugin(init_plugin_privacy_shield)?;
            #[cfg(not(target_os = "ios"))]
            let _ = api;
            Ok(())
        })
        .build()
}
