//! Outils partagés des tests (faux du plugin folder-bookmark, ADR 0011 §22).

/// `applog::init` fixe un dossier de journal pour TOUT le processus de test : les tests qui l'appellent puis relisent le journal prennent ce
/// verrou pour qu'aucun autre ne redirige le journal entre l'écriture et la relecture.
pub static APPLOG_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn applog_dir_lock() -> std::sync::MutexGuard<'static, ()> {
    APPLOG_DIR_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub mod fake_bookmark;
pub mod fake_web_auth;
pub mod http_mock;
