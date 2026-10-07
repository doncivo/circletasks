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
    // Audit (point bas 7) : tant que le blocage ne peut pas être écrit, le marqueur le redonne (échoue fermé) ; levé une fois écrit
    // (y_tech_02_a_refusal_that_cannot_be_written_survives_a_restart).
    assert_eq!(code(consent.precheck(OWNER)), SyncCode::RateLimited);
    assert_eq!(inner.prompts(), 1);
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
