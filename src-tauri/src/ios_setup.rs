//! Démarrage de l'iPhone (`setup` du builder, `cfg(target_os = "ios")`), ADR 0009 avenant lot F et ADR 0014.
//!
//! Ordre : (1) journal technique (`applog::init`, I-04) ; (2) purge des temporaires d'export restés dans `<cache>/exports/` (FILES-IOS-01),
//! inscrite au journal avec le nombre d'entrées supprimées ; (3) récupération d'une restauration interrompue, puis SEULEMENT si elle
//! réussit, enregistrement du plugin SQL (P-04-iOS, `startup_gate`) : aucune base n'est ouverte ni créée avant. Un échec n'arrête pas
//! l'app : la WebView le lit par `backup_startup_status` et affiche l'écran d'erreur persistant avec le code.

use tauri::{App, Manager};

/// `setup` de l'iPhone : la purge ne fait jamais échouer le démarrage (rattrapée au démarrage suivant, échec inscrit au journal).
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir().ok();
    match &config_dir {
        Some(dir) => crate::applog::init(dir.join(crate::applog::LOG_DIR)),
        None => crate::applog::write("logs", "no-data-dir"),
    }
    match app.path().app_cache_dir() {
        Ok(cache_dir) => match crate::export_ios::purge_exports(&cache_dir) {
            Ok(0) => {}
            Ok(count) => crate::applog::write_count("export", "temp-purged", u32::try_from(count).unwrap_or(u32::MAX)),
            Err(_) => crate::applog::write("export", "temp-purge-failed"),
        },
        Err(_) => crate::applog::write("export", "no-cache-dir"),
    }
    let _ = crate::startup_gate::register_sql_after_recovery(app.handle(), config_dir.as_deref());
    Ok(())
}
