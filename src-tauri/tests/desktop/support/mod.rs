//! Outils partagés des tests (faux du plugin folder-bookmark, ADR 0011 §22).

/// `applog::init` fixe un dossier de journal pour TOUT le processus de test : les tests qui l'appellent puis relisent le journal prennent ce
/// verrou pour qu'aucun autre ne redirige le journal entre l'écriture et la relecture.
pub static APPLOG_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn applog_dir_lock() -> std::sync::MutexGuard<'static, ()> {
    let guard = APPLOG_DIR_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Journal propre au test qui prend le verrou : ni dossier, ni entrées en attente, ni débit laissés par les tests précédents du processus.
    circletasks_lib::applog::reset_for_tests();
    guard
}

pub mod fake_bookmark;
pub mod fake_web_auth;
pub mod http_mock;
