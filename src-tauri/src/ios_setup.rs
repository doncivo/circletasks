//! Démarrage de l'iPhone (`setup` du builder, `cfg(target_os = "ios")`), ADR 0009 avenant lot F et ADR 0014.
//!
//! Ordre : (1) journal technique (`applog::init`, I-04) ; (2) purge des temporaires d'export restés dans `<cache>/exports/` (FILES-IOS-01),
//! inscrite au journal avec le nombre d'entrées supprimées.

use tauri::{App, Manager};

/// `setup` de l'iPhone : la purge ne fait jamais échouer le démarrage (rattrapée au démarrage suivant, échec inscrit au journal).
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    match app.path().app_config_dir() {
        Ok(dir) => crate::applog::init(dir.join(crate::applog::LOG_DIR)),
        Err(_) => crate::applog::write("logs", "no-data-dir"),
    }
    match app.path().app_cache_dir() {
        Ok(cache_dir) => match crate::export_ios::purge_exports(&cache_dir) {
            Ok(0) => {}
            Ok(count) => crate::applog::write_count("export", "temp-purged", u32::try_from(count).unwrap_or(u32::MAX)),
            Err(_) => crate::applog::write("export", "temp-purge-failed"),
        },
        Err(_) => crate::applog::write("export", "no-cache-dir"),
    }
    Ok(())
}
