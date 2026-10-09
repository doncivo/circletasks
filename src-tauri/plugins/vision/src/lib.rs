//! Plugin Swift vision de CircleTasks (CAP-IOS-01, ADR 0015 section 1.2).
//!
//! Aucune commande n'est exposée à la WebView (`build.rs`) : Rust seul appelle le plugin, par `Vision::call` (bloquant, toujours depuis un fil
//! dédié avec délai : `src/mobile_call.rs` de l'app). Le nom de commande est exactement celui de la méthode Swift
//! `@objc func <nom>(_ invoke: Invoke)` (lowerCamelCase des deux côtés) ; l'erreur rendue est le **code** rejeté par Swift (jamais un
//! message), `failed` à défaut de code, `unavailable` si l'appel n'a pas pu atteindre Swift.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_vision);

/// Accès au plugin, géré par `init()` (`app.state::<Vision<R>>()`).
pub struct Vision<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for Vision<R> {
    fn clone(&self) -> Self {
        Self {
            #[cfg(target_os = "ios")]
            handle: self.handle.clone(),
            #[cfg(not(target_os = "ios"))]
            _runtime: std::marker::PhantomData,
        }
    }
}

impl<R: Runtime> Vision<R> {
    /// Appelle la commande Swift `command` avec `args` ; rend sa réponse JSON, ou le code de rejet.
    #[cfg(target_os = "ios")]
    pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        use tauri::plugin::mobile::PluginInvokeError;
        self.handle.run_mobile_plugin::<serde_json::Value>(command, args).map_err(|error| match error {
            PluginInvokeError::InvokeRejected(response) => response.code.filter(|code| !code.is_empty()).unwrap_or_else(|| "failed".to_owned()),
            _ => "unavailable".to_owned(),
        })
    }

    /// Hors iOS (le crate n'est une dépendance que de la cible iOS) : aucun plugin, `unavailable`.
    #[cfg(not(target_os = "ios"))]
    pub fn call(&self, _command: &str, _args: serde_json::Value) -> Result<serde_json::Value, String> {
        Err("unavailable".to_owned())
    }
}

/// Enregistre le plugin (bloc iOS de `lib.rs` de l'app).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vision")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let plugin = Vision { handle: api.register_ios_plugin(init_plugin_vision)? };
            #[cfg(not(target_os = "ios"))]
            let plugin = {
                let _ = api;
                Vision::<R> { _runtime: std::marker::PhantomData }
            };
            app.manage(plugin);
            Ok(())
        })
        .build()
}
