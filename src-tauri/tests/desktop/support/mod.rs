//! Outils partagés des tests (faux du plugin folder-bookmark, ADR 0011 §22).

/// Verrou + `applog::reset_for_tests` : le test qui le prend a SON journal (état propre à son fil), où n'entrent pas les écritures des autres
/// tests (limite : celles faites depuis un autre fil vont à l'état global). Le verrou est conservé : l'état global reste partagé par les
/// tests qui n'isolent pas leur fil, et il sérialise ceux qui ont besoin du journal global (écritures depuis d'autres fils, `applog::init`
/// au `setup`) pour qu'aucun ne le redirige pendant qu'un autre le relit.
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
