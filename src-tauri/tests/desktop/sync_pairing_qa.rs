//! Y-06 (QA) critères 8, 9 et 18 : arrivée de l'appareil associé (une seule détection, jamais par un appareil déjà associé, référence
//! conservée après « Nouveau code », remise à zéro à chaque nouvelle fenêtre) et fermeture par chaque chemin côté registre.

use circletasks_lib::sync::pairing::{Caller, PairingMode, PairingRegistry, PAIRING_WINDOW};
use circletasks_lib::sync::SyncCode;

use crate::sync_support::{DEV_B, DEV_C, NOW};

fn caller(hwnd: isize) -> Caller<'static> {
    Caller { label: PAIRING_WINDOW, url: "http://tauri.localhost/pairing.html", hwnd }
}

fn shown(hwnd: isize) -> PairingRegistry {
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(hwnd, PairingMode::Show, NOW);
    registry
}

#[test]
fn sync_pairing_qa_9_baseline_survives_a_new_code_and_the_arrival_is_seen_after_it() {
    let registry = shown(42);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), None, "référence : B était déjà associé");
    // « Nouveau code » : nouvelle génération, même fenêtre.
    registry.renew(&caller(42), 1, NOW + 1_000).unwrap();
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), None, "B déjà associé : la fenêtre reste après le nouveau code");
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned(), DEV_C.to_owned()]), Some(42), "C arrive après le nouveau code");
    assert!(registry.current().is_none());
}

#[test]
fn sync_pairing_qa_9_each_new_window_takes_its_own_baseline() {
    let registry = shown(42);
    assert_eq!(registry.observe_paired(&[]), None);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), Some(42));
    // Seconde fenêtre : B est déjà associé, il ne ferme pas la nouvelle fenêtre ; C, oui.
    registry.begin_open(false).unwrap();
    registry.register(43, PairingMode::Show, NOW + 10_000);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), None);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), None);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned(), DEV_C.to_owned()]), Some(43));
}

#[test]
fn sync_pairing_qa_8_a_destroyed_window_never_produces_an_arrival() {
    // Croix native, Annuler, expiration, réduction de main : `clear` efface l'instance ; une arrivée ensuite ne détruit rien et n'émet rien.
    let registry = shown(42);
    assert_eq!(registry.observe_paired(&[]), None);
    registry.clear(42);
    assert_eq!(registry.observe_paired(&[DEV_B.to_owned()]), None);
    assert!(registry.current().is_none());
    // Sans aucune instance : jamais d'arrivée.
    let none = PairingRegistry::default();
    assert_eq!(none.observe_paired(&[]), None);
    assert_eq!(none.observe_paired(&[DEV_B.to_owned()]), None);
}

#[test]
fn sync_pairing_qa_8_a_stale_generation_or_other_window_cannot_renew_or_verify() {
    let registry = shown(42);
    assert_eq!(registry.renew(&caller(43), 1, NOW).unwrap_err().code, SyncCode::WrongWindow);
    registry.renew(&caller(42), 1, NOW + 1).unwrap();
    assert_eq!(registry.renew(&caller(42), 1, NOW + 2).unwrap_err().code, SyncCode::WrongWindow, "génération 1 remplacée");
    // Le minuteur d'une génération remplacée ne détruit pas la fenêtre.
    assert!(!registry.expire_if_due(42, 1, NOW + 10 * 60_000));
    assert!(registry.expire_if_due(42, 2, NOW + 10 * 60_000));
}
