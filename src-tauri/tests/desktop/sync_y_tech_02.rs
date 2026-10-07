//! Y-TECH-02 (revue d'ensemble de fin d'ordre 4) : avertissements du scan rendus au moteur (dossier de plus de 1 Gio, budget de nonces),
//! compteurs de confirmation dont l'écriture échoue (aucune boîte sans ouverture comptée, blocage gardé en mémoire après un refus).

use std::sync::Arc;

use circletasks_lib::sync::consent::{ConsentGate, ConsentKind, ConsentUi, DialogSpec};
use circletasks_lib::sync::files::Availability;
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::limits::CONSENT_BLOCK_MS;
use circletasks_lib::sync::service::AppendRequest;
use circletasks_lib::sync::SyncCode;

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, FakeUi, MemFs, TestClock, DEV_A, DEV_B, FOLDER, NOW};

const OWNER: isize = 0x1234;

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

/// Rend l'écriture de `consent.json` impossible : un dossier occupe le nom du fichier temporaire.
fn break_writes(dir: &std::path::Path) {
    std::fs::create_dir_all(dir.join("consent.json.tmp")).unwrap();
}

#[test]
fn y_tech_02_scan_reports_a_folder_over_one_gib_without_failing() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let scan = d.core.scan(&[]).unwrap();
    assert!(!scan.folder_large);
    fs.put(&["devices", DEV_B, "state.ctx"], b"x");
    fs.set_extra(&["devices", DEV_B, "state.ctx"], 2 * 1024 * 1024 * 1024);
    fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Cloud);
    let scan = d.core.scan(&[]).unwrap();
    assert!(scan.folder_large, "au-delà de 1 Gio : avertissement rendu, pas seulement journalisé");
    let json = serde_json::to_value(&scan).unwrap();
    assert_eq!(json["folderLarge"], serde_json::Value::Bool(true));
}

#[test]
fn y_tech_02_scan_reports_the_nonce_budget_warning() {
    let fs = MemFs::new();
    let d = Device::with_options(FakeBackend::with(FOLDER, FolderKind::Icloud, fs), |o| o.nonce_warn = 2);
    d.setup(DEV_A);
    assert!(!d.core.scan(&[]).unwrap().nonce_warning);
    let request = AppendRequest { epoch: epoch(1, DEV_A), segment: 1, expect_records: 0, sv: 14, max_hlc: hlc(10, DEV_A), records: vec!["{}".to_owned(); 3] };
    d.core.append_journal(&request).unwrap();
    let scan = d.core.scan(&[]).unwrap();
    assert!(scan.nonce_warning, "alerte du budget de nonces rendue au moteur");
    assert_eq!(serde_json::to_value(&scan).unwrap()["nonceWarning"], serde_json::Value::Bool(true));
}

#[test]
fn y_tech_02_an_opening_that_cannot_be_counted_opens_no_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let ui = FakeUi::new();
    let clock = TestClock::new(NOW);
    let consent = ConsentGate::new(dir.path().to_path_buf(), ui.clone(), clock.clock());
    break_writes(dir.path());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::Io);
    assert_eq!(code(consent.confirm_forget(OWNER, "PC")), SyncCode::Io);
    assert_eq!(code(consent.confirm_reset(OWNER)), SyncCode::Io);
    assert_eq!(code(consent.count_import(OWNER)), SyncCode::Io);
    assert_eq!(ui.prompts(), 0, "aucune boîte tant que l'ouverture n'est pas comptée sur le disque");
    // Sans compteur à écrire, la boîte de remplacement reste possible (seul le blocage la conditionne).
    assert!(consent.confirm(ConsentKind::ReplaceKey, OWNER).is_ok());
    assert_eq!(ui.prompts(), 1);
}

/// Boîte refusée pendant laquelle le disque devient inaccessible : le blocage ne peut plus être écrit.
struct RefuseThenBreak {
    inner: Arc<FakeUi>,
    dir: std::path::PathBuf,
}

impl ConsentUi for RefuseThenBreak {
    fn owner_ready(&self, owner: isize) -> bool {
        self.inner.owner_ready(owner)
    }
    fn ask(&self, spec: &DialogSpec) -> bool {
        self.inner.ask(spec);
        break_writes(&self.dir);
        false
    }
}

#[test]
fn y_tech_02_a_refusal_blocks_in_memory_when_it_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeUi::new();
    let clock = TestClock::new(NOW);
    let ui = Arc::new(RefuseThenBreak { inner: inner.clone(), dir: dir.path().to_path_buf() });
    let consent = ConsentGate::new(dir.path().to_path_buf(), ui, clock.clock());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::ConsentDenied);
    assert_eq!(inner.prompts(), 1);
    // Le fichier n'a pas reçu le blocage : la mémoire le tient (aucune boîte, aucun compteur à écrire).
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::RateLimited);
    assert_eq!(code(consent.confirm(ConsentKind::EraseKey, OWNER)), SyncCode::RateLimited);
    assert_eq!(code(consent.precheck(OWNER)), SyncCode::RateLimited);
    assert_eq!(inner.prompts(), 1);
    clock.advance(CONSENT_BLOCK_MS);
    // Seconde revue, point 4 : blocage borné à son échéance (marqueur), jamais prolongé.
    assert!(consent.precheck(OWNER).is_ok(), "blocage de 10 minutes, pas davantage");
}

/// Audit (point bas 7) : un refus dont l'écriture échoue n'est pas perdu à la relance (marqueur lu comme un fichier illisible : blocage).
#[test]
fn y_tech_02_a_refusal_that_cannot_be_written_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeUi::new();
    let clock = TestClock::new(NOW);
    let ui = Arc::new(RefuseThenBreak { inner: inner.clone(), dir: dir.path().to_path_buf() });
    let consent = ConsentGate::new(dir.path().to_path_buf(), ui, clock.clock());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::ConsentDenied);
    // Relance (nouvelle instance), écritures toujours impossibles : bloqué, aucune boîte.
    let restarted = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
    assert_eq!(code(restarted.confirm_show(OWNER)), SyncCode::RateLimited);
    assert_eq!(inner.prompts(), 1);
    // Le disque revient : le blocage est écrit (10 minutes depuis sa lecture), puis levé.
    std::fs::remove_dir_all(dir.path().join("consent.json.tmp")).unwrap();
    let again = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
    assert_eq!(code(again.confirm_show(OWNER)), SyncCode::RateLimited);
    clock.advance(CONSENT_BLOCK_MS);
    let later = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
    assert!(later.confirm_show(OWNER).is_ok());
    assert_eq!(inner.prompts(), 2);
}

/// Seconde revue, point 4 : le marqueur porte l'échéance du blocage (borné, jamais prolongé à chaque lecture) ; passée l'échéance, un
/// marqueur qui ne peut pas être retiré rend `io` (la cause est l'écriture), jamais `rate-limited`.
#[test]
fn y_tech_02_refusal_marker_carries_its_deadline_and_answers_io_when_it_cannot_be_removed() {
    use circletasks_lib::sync::consent::CONSENT_REFUSED_MARKER;
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeUi::new();
    let clock = TestClock::new(NOW);
    let ui = Arc::new(RefuseThenBreak { inner: inner.clone(), dir: dir.path().to_path_buf() });
    let consent = ConsentGate::new(dir.path().to_path_buf(), ui, clock.clock());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::ConsentDenied);
    let marker = dir.path().join(CONSENT_REFUSED_MARKER);
    let deadline: u64 = std::fs::read_to_string(&marker).unwrap().trim().parse().expect("échéance dans le marqueur");
    assert_eq!(deadline, NOW + CONSENT_BLOCK_MS);
    // Avant l'échéance, après des relances répétées : bloqué, échéance inchangée (jamais prolongée).
    for _ in 0..3 {
        clock.advance(CONSENT_BLOCK_MS / 4);
        let restarted = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
        assert_eq!(code(restarted.precheck(OWNER)), SyncCode::RateLimited);
    }
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), deadline.to_string());
    // Passée l'échéance, écritures encore impossibles : plus de blocage (précondition seule) ; une ouverture non comptée : io.
    clock.advance(CONSENT_BLOCK_MS / 4);
    let after = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
    assert!(after.precheck(OWNER).is_ok(), "blocage borné");
    assert!(!marker.exists(), "marqueur retiré à l'échéance");
    assert_eq!(code(after.confirm_show(OWNER)), SyncCode::Io);
    assert_eq!(inner.prompts(), 1);
}

/// Seconde revue, point 4 (suite) : marqueur échu qui ne peut pas être retiré → `io`, aucune boîte ; retiré → boîte possible.
#[cfg(windows)]
#[test]
fn y_tech_02_an_expired_marker_that_cannot_be_removed_answers_io() {
    use circletasks_lib::sync::consent::CONSENT_REFUSED_MARKER;
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeUi::new();
    let clock = TestClock::new(NOW);
    let marker = dir.path().join(CONSENT_REFUSED_MARKER);
    std::fs::write(&marker, (NOW - 1).to_string()).unwrap();
    // Fichier ouvert sans partage de suppression : le retrait échoue.
    let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&marker).unwrap();
    let consent = ConsentGate::new(dir.path().to_path_buf(), inner.clone(), clock.clock());
    assert_eq!(code(consent.precheck(OWNER)), SyncCode::Io);
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::Io);
    assert_eq!(inner.prompts(), 0);
    drop(lock);
    assert!(consent.confirm_show(OWNER).is_ok());
    assert_eq!(inner.prompts(), 1);
}

/// Boîte refusée pendant laquelle un refus non écrit (marqueur `consent.refused`) apparaît.
struct RefuseWithMarker {
    inner: Arc<FakeUi>,
    marker: std::path::PathBuf,
    deadline: u64,
}

impl ConsentUi for RefuseWithMarker {
    fn owner_ready(&self, owner: isize) -> bool {
        self.inner.owner_ready(owner)
    }
    fn ask(&self, spec: &DialogSpec) -> bool {
        self.inner.ask(spec);
        std::fs::write(&self.marker, self.deadline.to_string()).unwrap();
        false
    }
}

/// Troisième revue, point 3 : avec un marqueur actif, `consent.json` lisible reste lu (blocage = le plus tardif des deux) ; un refus
/// pendant le blocage garde les compteurs d'affichage et d'import, jamais un fichier réécrit vide.
#[test]
fn y_tech_02_a_refusal_during_a_marker_block_keeps_the_counters() {
    use circletasks_lib::sync::consent::{CONSENT_FILE, CONSENT_REFUSED_MARKER};
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeUi::new();
    let clock = TestClock::new(NOW);
    let file = dir.path().join(CONSENT_FILE);
    std::fs::write(&file, serde_json::json!({ "show": [NOW - 2, NOW - 1], "import": [NOW - 3], "blockedUntil": 0 }).to_string()).unwrap();
    let ui = Arc::new(RefuseWithMarker { inner: inner.clone(), marker: dir.path().join(CONSENT_REFUSED_MARKER), deadline: NOW + CONSENT_BLOCK_MS / 2 });
    let consent = ConsentGate::new(dir.path().to_path_buf(), ui, clock.clock());
    assert_eq!(code(consent.confirm_show(OWNER)), SyncCode::ConsentDenied);
    let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["show"], serde_json::json!([NOW - 2, NOW - 1, NOW]), "affichages gardés");
    assert_eq!(written["import"], serde_json::json!([NOW - 3]), "imports gardés");
    assert_eq!(written["blockedUntil"], serde_json::json!(NOW + CONSENT_BLOCK_MS));
}
