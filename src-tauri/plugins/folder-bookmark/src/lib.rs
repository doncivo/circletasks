//! Plugin Swift folder-bookmark de CircleTasks (ADR 0011 §6.3 et §22) : signet de sécurité du dossier `iCloud Drive/CircleTasks`, accès
//! aux fichiers sous ce signet (`openat` sans suivre de lien, `NSFileCoordinator`), téléchargement forcé, tâche d'arrière-plan, et
//! confirmation native (`UIAlertController`, §23 point 3).
//!
//! Aucune commande n'est exposée à la WebView (`build.rs`) : Rust seul appelle le plugin, par `FolderBookmark::call` (bloquant, toujours
//! depuis `spawn_blocking`). Le nom de commande est exactement celui de la méthode Swift `@objc func <nom>(_ invoke: Invoke)`
//! (lowerCamelCase des deux côtés) ; l'erreur rendue est le **code** rejeté par Swift (jamais un message), `io` à défaut.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_folder_bookmark);

/// Accès au plugin, géré par `init()` (`app.state::<FolderBookmark<R>>()`).
pub struct FolderBookmark<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for FolderBookmark<R> {
    fn clone(&self) -> Self {
        Self {
            #[cfg(target_os = "ios")]
            handle: self.handle.clone(),
            #[cfg(not(target_os = "ios"))]
            _runtime: std::marker::PhantomData,
        }
    }
}

impl<R: Runtime> FolderBookmark<R> {
    /// Appelle la commande Swift `command` avec `args` ; rend sa réponse JSON, ou le code de rejet (`io` si Swift n'en donne pas).
    #[cfg(target_os = "ios")]
    pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        use tauri::plugin::mobile::PluginInvokeError;
        self.handle.run_mobile_plugin::<serde_json::Value>(command, args).map_err(|error| match error {
            PluginInvokeError::InvokeRejected(response) => response.code.filter(|code| !code.is_empty()).unwrap_or_else(|| "io".to_owned()),
            _ => "io".to_owned(),
        })
    }

    /// Hors iOS (le crate n'est une dépendance que de la cible iOS) : aucun plugin, `io`.
    #[cfg(not(target_os = "ios"))]
    pub fn call(&self, _command: &str, _args: serde_json::Value) -> Result<serde_json::Value, String> {
        Err("io".to_owned())
    }
}

/// Enregistre le plugin (bloc iOS de `lib.rs` de l'app).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folder-bookmark")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let plugin = FolderBookmark { handle: api.register_ios_plugin(init_plugin_folder_bookmark)? };
            #[cfg(not(target_os = "ios"))]
            let plugin = {
                let _ = api;
                FolderBookmark::<R> { _runtime: std::marker::PhantomData }
            };
            app.manage(plugin);
            Ok(())
        })
        .build()
}
