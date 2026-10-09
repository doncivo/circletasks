//! Plugin Swift web-auth de CircleTasks (ADR 0008 §9.1) : une session `ASWebAuthenticationSession` qui rend l'URL de retour de
//! l'autorisation Google sur iPhone. Le plugin ne voit ni code, ni jeton, ni secret : il ouvre l'URL reçue et rend l'URL de retour ;
//! Rust vérifie le `state` et échange le code.
//!
//! Aucune commande n'est exposée à la WebView (`build.rs`) : Rust seul appelle le plugin, par `WebAuth::call` (bloquant, toujours
//! depuis `spawn_blocking`). Le nom de commande est exactement celui de la méthode Swift `@objc public func <nom>(_ invoke: Invoke)` ;
//! l'erreur rendue est le **code** rejeté par Swift (`cancelled`, `unavailable`, `failed`), jamais un message, `failed` à défaut.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_web_auth);

/// Accès au plugin, géré par `init()` (`app.state::<WebAuth<R>>()`).
pub struct WebAuth<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for WebAuth<R> {
    fn clone(&self) -> Self {
        Self {
            #[cfg(target_os = "ios")]
            handle: self.handle.clone(),
            #[cfg(not(target_os = "ios"))]
            _runtime: std::marker::PhantomData,
        }
    }
}

impl<R: Runtime> WebAuth<R> {
    /// Appelle la commande Swift `command` avec `args` ; rend sa réponse JSON, ou le code de rejet (`failed` si Swift n'en donne pas).
    #[cfg(target_os = "ios")]
    pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        use tauri::plugin::mobile::PluginInvokeError;
        self.handle.run_mobile_plugin::<serde_json::Value>(command, args).map_err(|error| match error {
            PluginInvokeError::InvokeRejected(response) => response.code.filter(|code| !code.is_empty()).unwrap_or_else(|| "failed".to_owned()),
            _ => "failed".to_owned(),
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
    Builder::new("web-auth")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let plugin = WebAuth { handle: api.register_ios_plugin(init_plugin_web_auth)? };
            #[cfg(not(target_os = "ios"))]
            let plugin = {
                let _ = api;
                WebAuth::<R> { _runtime: std::marker::PhantomData }
            };
            app.manage(plugin);
            Ok(())
        })
        .build()
}
