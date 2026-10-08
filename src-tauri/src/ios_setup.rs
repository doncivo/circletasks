//! Démarrage de l'iPhone (`setup` du builder, `cfg(target_os = "ios")`), ADR 0009 avenant lot F.
//!
//! FILES-IOS-01 : purge des temporaires d'export restés dans `<cache>/exports/` (arrêt brutal pendant un enregistrement).

use tauri::{App, Manager};

/// `setup` de l'iPhone : ne fait jamais échouer le démarrage pour la purge (rattrapée au démarrage suivant).
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        let _ = crate::export_ios::purge_exports(&cache_dir);
    }
    Ok(())
}
