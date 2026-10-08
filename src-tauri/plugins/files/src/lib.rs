//! Plugin Swift ct-files de CircleTasks (FILES-IOS-01, ADR 0009 avenant lot F point A1, décision du 2026-10-08) : présente le sélecteur
//! « Enregistrer dans Fichiers » (`UIDocumentPickerViewController(forExporting:asCopy: true)`) sur un fichier temporaire écrit par Rust
//! (`src-tauri/src/export_ios.rs`), qui le supprime ensuite dans tous les cas.
//!
//! Aucune commande n'est exposée à la WebView (`build.rs`) : Rust seul appelle le plugin, par `CtFiles::call` (bloquant, toujours depuis
//! `spawn_blocking`). L'erreur rendue est le **code** rejeté par Swift (jamais un message), `failed` à défaut. Préfixe `ct-` : aucun conflit
//! possible avec un plugin communautaire « files ».

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ct_files);

/// Accès au plugin, géré par `init()` (`app.state::<CtFiles<R>>()`).
pub struct CtFiles<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for CtFiles<R> {
    fn clone(&self) -> Self {
        Self {
            #[cfg(target_os = "ios")]
            handle: self.handle.clone(),
            #[cfg(not(target_os = "ios"))]
            _runtime: std::marker::PhantomData,
        }
    }
}

impl<R: Runtime> CtFiles<R> {
    /// Appelle la commande Swift `command` avec `args` ; rend sa réponse JSON, ou le code de rejet (`failed` si Swift n'en donne pas).
    #[cfg(target_os = "ios")]
    pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        use tauri::plugin::mobile::PluginInvokeError;
        self.handle.run_mobile_plugin::<serde_json::Value>(command, args).map_err(|error| match error {
            PluginInvokeError::InvokeRejected(response) => response.code.filter(|code| !code.is_empty()).unwrap_or_else(|| "failed".to_owned()),
            _ => "failed".to_owned(),
        })
    }

    /// Hors iOS (le crate n'est une dépendance que de la cible iOS) : aucun plugin, `failed`.
    #[cfg(not(target_os = "ios"))]
    pub fn call(&self, _command: &str, _args: serde_json::Value) -> Result<serde_json::Value, String> {
        Err("failed".to_owned())
    }
}

/// Enregistre le plugin (bloc iOS de `lib.rs` de l'app).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ct-files")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let plugin = CtFiles { handle: api.register_ios_plugin(init_plugin_ct_files)? };
            #[cfg(not(target_os = "ios"))]
            let plugin = {
                let _ = api;
                CtFiles::<R> { _runtime: std::marker::PhantomData }
            };
            app.manage(plugin);
            Ok(())
        })
        .build()
}
