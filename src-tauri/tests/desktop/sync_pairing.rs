//! Y-08 critères 10 à 13 : confirmation native (configuration pure, préconditions, compteurs persistés, verrou) et fenêtre dédiée
//! `pairing` (instance créée par Rust, URL exacte, HWND, jeton à usage unique, génération, mode, minuteur). Les garanties de la
//! fenêtre sont testées sur le registre avec des fenêtres « de test » (même libellé, autre URL, autre HWND).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use circletasks_lib::sync::consent::{dialog_spec, dialog_texts, ConsentGate, ConsentKind, IDCANCEL, ID_CONFIRM};
use circletasks_lib::sync::limits::{CONSENT_BLOCK_MS, PAIRING_VALIDITY_MS};
use circletasks_lib::sync::pairing::{is_pairing_url, Caller, PairingMode, PairingRegistry, PAIRING_WINDOW};
use circletasks_lib::sync::SyncCode;

use crate::sync_support::{FakeUi, TestClock, NOW};

const OWNER: isize = 0x1234;
const URL: &str = "http://tauri.localhost/pairing.html";

fn gate(dir: &std::path::Path, ui: &Arc<FakeUi>, clock: &Arc<TestClock>) -> ConsentGate {
    ConsentGate::new(dir.to_path_buf(), ui.clone(), clock.clock())
}

fn code(result: Result<impl Sized, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

#[test]
fn y08_10_dialog_config_has_two_buttons_cancel_by_default_and_compiled_texts() {
    let spec = dialog_spec(ConsentKind::ShowKey, OWNER);
    assert_eq!(spec.owner, OWNER);
    assert_eq!(spec.default_button, IDCANCEL);
    assert_eq!(spec.buttons, vec![(ID_CONFIRM, "Afficher la clé".to_owned()), (IDCANCEL, "Annuler".to_owned())]);
    assert_eq!(spec.texts.instruction, "Afficher la clé de synchronisation ?");
    for kind in [ConsentKind::ShowKey, ConsentKind::ReplaceKey, ConsentKind::EraseKey] {
        let texts = dialog_texts(kind);
        assert!(!texts.title.is_empty() && !texts.instruction.is_empty() && !texts.confirm.is_empty());
        assert_eq!(texts.cancel, "Annuler");
        assert_eq!(dialog_spec(kind, OWNER).default_button, IDCANCEL);
    }
    assert_eq!(dialog_texts(ConsentKind::EraseKey).content, "Sans clé, cet appareil devra être associé de nouveau.");
    // Les textes viennent du fichier compilé, jamais de la WebView.
    let source = include_str!("../../src/sync/consent.rs");
    assert!(source.contains("include_str!(\"../../../src/i18n/native/fr.json\")"));
}

#[test]
fn y08_10_refusal_returns_consent_denied_and_blocks_ten_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let ui = FakeUi::new();
    let clock = TestClock::new(NOW);
    let consent = gate(dir.path(), &ui, &clock);
    ui.answer(false);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::ConsentDenied);
    ui.answer(true);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited);
    // Blocage persistant : un redémarrage (nouvelle instance) le relit.
    let restarted = gate(dir.path(), &ui, &clock);
    assert_eq!(code(restarted.confirm_show(OWNER)), SyncCode::RateLimited);
    clock.advance(CONSENT_BLOCK_MS);
    assert!(restarted.confirm_show(OWNER).is_ok());
}

#[test]
fn y08_11_preconditions_without_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let ui = FakeUi::new();
    let clock = TestClock::new(NOW);
    let consent = gate(dir.path(), &ui, &clock);
    ui.ready(false);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::NotForeground);
    assert_eq!(code(consent.confirm(ConsentKind::EraseKey, OWNER)), SyncCode::NotForeground);
    assert_eq!(ui.prompts(), 0, "aucune boîte si la fenêtre n'est pas au premier plan");
}

#[test]
fn y08_11_three_openings_per_ten_minutes_refusals_included_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let ui = FakeUi::new();
    let clock = TestClock::new(NOW);
    let consent = gate(dir.path(), &ui, &clock);
    for _ in 0..3 {
        consent.confirm_show(OWNER).unwrap();
        clock.advance(60_000);
    }
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited);
    assert_eq!(ui.prompts(), 3);
    let restarted = gate(dir.path(), &ui, &clock);
    assert_eq!(code(restarted.confirm_show(OWNER)), SyncCode::RateLimited, "process:allow-restart ne remet rien à zéro");
    clock.advance(8 * 60_000);
    assert!(restarted.confirm_show(OWNER).is_ok(), "fenêtre glissante de 10 minutes");
    // Cinq imports par 10 minutes.
    for _ in 0..5 {
        restarted.count_import(OWNER).unwrap();
    }
    assert_eq!(code(restarted.count_import(OWNER)), SyncCode::RateLimited);
}

#[test]
fn y08_11_unreadable_file_blocks_ten_minutes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("consent.json"), b"{pas du json").unwrap();
    let ui = FakeUi::new();
    let clock = TestClock::new(NOW);
    let consent = gate(dir.path(), &ui, &clock);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited);
    clock.advance(CONSENT_BLOCK_MS - 1);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited, "le blocage ne se prolonge pas à chaque lecture");
    clock.advance(1);
    assert!(consent.confirm_show(OWNER).is_ok());
}

/// Boîte qui reste ouverte jusqu'au signal du test : un appel pendant ce temps est refusé (`rate-limited`).
struct SlowUi {
    inner: Arc<FakeUi>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    opened: std::sync::mpsc::SyncSender<()>,
}

impl circletasks_lib::sync::consent::ConsentUi for SlowUi {
    fn owner_ready(&self, _owner: isize) -> bool {
        true
    }
    fn ask(&self, _spec: &circletasks_lib::sync::consent::DialogSpec) -> bool {
        self.inner.prompts.fetch_add(1, Ordering::SeqCst);
        let _ = self.opened.send(());
        let _ = self.release.lock().unwrap().recv();
        true
    }
}

#[test]
fn y08_11_one_dialog_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (opened_tx, opened_rx) = std::sync::mpsc::sync_channel(1);
    let ui = Arc::new(SlowUi { inner: FakeUi::new(), release: std::sync::Mutex::new(release_rx), opened: opened_tx });
    let clock = TestClock::new(NOW);
    let consent = Arc::new(ConsentGate::new(dir.path().to_path_buf(), ui.clone(), clock.clock()));
    let first = {
        let consent = consent.clone();
        std::thread::spawn(move || consent.confirm(ConsentKind::EraseKey, OWNER))
    };
    opened_rx.recv().unwrap();
    assert!(consent.is_busy());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited);
    assert_eq!(code(consent.count_import(OWNER)), SyncCode::RateLimited);
    release_tx.send(()).unwrap();
    assert!(first.join().unwrap().is_ok());
    assert!(!consent.is_busy());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fenêtre dédiée `pairing`
// ------------------------------------------------------------------------------------------------------------------------------

fn caller(hwnd: isize) -> Caller<'static> {
    Caller { label: PAIRING_WINDOW, url: URL, hwnd }
}

#[test]
fn y08_12_exact_url_and_vite_only_in_debug() {
    assert!(is_pairing_url("http://tauri.localhost/pairing.html"));
    assert!(is_pairing_url("tauri://localhost/pairing.html"));
    for bad in [
        "http://tauri.localhost/pairing.html?x=1",
        "http://tauri.localhost/pairing.html#a",
        "http://tauri.localhost/index.html",
        "http://evil.localhost/pairing.html",
        "http://tauri.localhost/pairing.html/",
    ] {
        assert!(!is_pairing_url(bad), "{bad}");
    }
    // L'URL du serveur Vite n'est acceptée que dans un build de développement ; `cargo test --release` vérifie le refus.
    assert_eq!(is_pairing_url("http://localhost:1420/pairing.html"), cfg!(debug_assertions));
}

#[test]
fn y08_12_never_reuses_a_window_and_checks_label_url_hwnd() {
    let registry = PairingRegistry::default();
    // Libellé déjà pris (fenêtre créée par un tiers) avant la boîte : refus, rien n'est créé.
    assert_eq!(code(registry.begin_open(true)), SyncCode::AlreadyOpen);
    assert!(registry.current().is_none());
    registry.begin_open(false).unwrap();
    // Une seconde ouverture pendant la boîte : refus.
    assert_eq!(code(registry.begin_open(false)), SyncCode::AlreadyOpen);
    let instance = registry.register(42, PairingMode::Show, NOW);
    assert_eq!(code(registry.begin_open(false)), SyncCode::AlreadyOpen, "instance existante jamais réutilisée");
    // Fenêtres de test : même libellé, autre URL ou autre HWND ; ou `main`.
    for fake in [Caller { label: PAIRING_WINDOW, url: "http://tauri.localhost/index.html", hwnd: 42 }, caller(43), Caller { label: "main", url: URL, hwnd: 42 }, caller(0)] {
        assert_eq!(code(registry.verify(&fake, NOW)), SyncCode::WrongWindow);
        assert_eq!(code(registry.take_token(&fake, NOW)), SyncCode::WrongWindow);
    }
    assert_eq!(registry.verify(&caller(42), NOW).unwrap(), instance);
}

#[test]
fn y08_12_token_is_single_use_and_bound_to_the_generation() {
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(42, PairingMode::Show, NOW);
    let first = registry.take_token(&caller(42), NOW).unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(code(registry.take_token(&caller(42), NOW)), SyncCode::WrongWindow, "jeton à usage unique");
    let renewed = registry.renew(&caller(42), 1, NOW + 1_000).unwrap();
    assert_eq!(renewed.generation, 2);
    assert_eq!(renewed.expires_at, NOW + 1_000 + PAIRING_VALIDITY_MS);
    assert_eq!(code(registry.renew(&caller(42), 1, NOW)), SyncCode::WrongWindow, "génération périmée");
    // Destruction : jeton et instance effacés ; un ancien jeton ne sert plus.
    registry.clear(42);
    assert!(registry.current().is_none());
    assert_eq!(code(registry.verify(&caller(42), NOW)), SyncCode::WrongWindow);
}

#[test]
fn y08_12_mode_is_bound_to_the_instance() {
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(7, PairingMode::Import, NOW);
    assert_eq!(code(registry.take_token(&caller(7), NOW)), SyncCode::WrongMode, "pas de charge utile dans une instance import");
    assert_eq!(registry.verify(&caller(7), NOW).unwrap().mode, PairingMode::Import);
    assert_eq!(PairingMode::parse("show"), Some(PairingMode::Show));
    assert_eq!(PairingMode::parse("other"), None);
}

#[test]
fn y08_13_one_timer_per_generation_old_timers_have_no_effect() {
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(9, PairingMode::Show, NOW);
    assert!(!registry.expire_if_due(9, 1, NOW + PAIRING_VALIDITY_MS - 1));
    registry.renew(&caller(9), 1, NOW + 60_000).unwrap();
    // Le minuteur de la génération 1 arrive à échéance : sans effet après « Nouveau code ».
    assert!(!registry.expire_if_due(9, 1, NOW + PAIRING_VALIDITY_MS));
    assert!(!registry.expire_if_due(9, 2, NOW + PAIRING_VALIDITY_MS));
    assert!(registry.expire_if_due(9, 2, NOW + 60_000 + PAIRING_VALIDITY_MS));
    // Échue : plus aucun appel accepté.
    assert_eq!(code(registry.verify(&caller(9), NOW + 60_000 + PAIRING_VALIDITY_MS)), SyncCode::WrongWindow);
}

#[test]
fn y08_12_pairing_window_is_never_declared_in_the_configuration() {
    for conf in [include_str!("../../tauri.conf.json"), include_str!("../../tauri.windows.conf.json")] {
        let value: serde_json::Value = serde_json::from_str(conf).unwrap();
        let windows = value["app"]["windows"].as_array().cloned().unwrap_or_default();
        assert!(windows.iter().all(|w| w["label"] != PAIRING_WINDOW && !w["url"].as_str().unwrap_or("").contains("pairing")));
    }
    // Création par Rust : masquée, puis affinité d'affichage vérifiée avant l'affichage ; `main` n'est jamais concernée.
    let source = include_str!("../../src/sync/commands.rs");
    let build = source.find("WebviewWindowBuilder::new(app, PAIRING_WINDOW").expect("création par Rust");
    let affinity = source.find("exclude_from_capture(hwnd)").expect("affinité");
    let show = source.find("window.show()").expect("affichage");
    assert!(build < affinity && affinity < show);
    assert!(source.contains(".visible(false)") && source.contains("WDA_EXCLUDEFROMCAPTURE") && source.contains("run_on_main_thread"));
    assert_eq!(source.matches("exclude_from_capture(").count(), 3, "définitions (Windows et repli) et un seul appel, sur la fenêtre pairing");
}
