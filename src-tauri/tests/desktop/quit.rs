//! Sortie propre (D-01, critère 7) : attente bornée de la confirmation du front.

use std::time::{Duration, Instant};

use circletasks_lib::desktop::{wait_for_confirmation, QuitGate, QUIT_GRACE};

#[test]
fn confirmation_before_the_deadline_lets_the_app_quit_at_once() {
    let gate = QuitGate::default();
    let receiver = gate.begin();
    gate.confirm();
    let started = Instant::now();
    assert!(wait_for_confirmation(&receiver, Duration::from_secs(5)));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn silent_front_does_not_block_the_exit_beyond_the_grace_period() {
    let gate = QuitGate::default();
    let receiver = gate.begin();
    let started = Instant::now();
    assert!(!wait_for_confirmation(&receiver, Duration::from_millis(100)));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn confirmation_without_pending_exit_is_ignored_and_grace_is_bounded() {
    let gate = QuitGate::default();
    gate.confirm();
    assert!(QUIT_GRACE <= Duration::from_secs(3));
}
