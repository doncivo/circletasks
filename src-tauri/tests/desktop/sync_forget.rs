//! Y-10 « J'oublie un appareil » (ADR 0011 sections 1.1, 1.4, 11.1, 14.2 et 18) : table de cas commune avec `retention.ts`,
//! `sync_device_forget` (préconditions, confirmation native, `forgotten.json`), `sync_write_state` (Rust maître de `forgotten`),
//! `sync_forgotten_delete` (conditions recalculées, refus un par un, suppression des seuls noms stricts, `state.ctx` en dernier,
//! idempotence) et tests d'attaque (état rejoué, appareil oublié qui tente d'oublier, oublis croisés, faux état étranger, chemin hors
//! de `devices/<id oublié>/`). Horloge contrôlée : aucune attente réelle.

use std::collections::BTreeMap;
use std::path::Path;

use circletasks_lib::sync::files::{delete_forgotten_device_files, Availability, FsError};
use circletasks_lib::sync::forget::{
    completed_forgotten, cutoff, forget_order, forgotten_delete_check, next_declaration_hlc, Declaration, DeleteCheck, KnownDevice, KnownState, Verdict, FORGOTTEN_FILE,
    SYNC_NEXT_KEY_ACCOUNT,
};
use circletasks_lib::sync::log;
use circletasks_lib::sync::service::{AppendRequest, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::state::{DeviceAck, ForgottenDevice};
use circletasks_lib::sync::store::StateStatus;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, DEV_C, FOLDER};
use circletasks_lib::sync::folder::FolderKind;

const DEV_X: &str = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const DEV_D: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const SV: u64 = 14;

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Table de cas commune (tests/fixtures/sync/forget-order.json)
// ------------------------------------------------------------------------------------------------------------------------------

fn table() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/sync/forget-order.json")).expect("table de cas")
}

fn status_of(name: &str) -> StateStatus {
    match name {
        "ok" => StateStatus::Ok,
        "missing" => StateStatus::Missing,
        "cloud-pending" => StateStatus::CloudPending,
        "foreign" => StateStatus::Foreign,
        "corrupt" => StateStatus::Corrupt,
        "rollback" => StateStatus::Rollback,
        "too-large" => StateStatus::TooLarge,
        "newer-format" => StateStatus::NewerFormat,
        other => panic!("statut inconnu : {other}"),
    }
}

fn check_json(check: &DeleteCheck) -> Value {
    match check {
        DeleteCheck::Ready { by, cutoff } => json!({ "kind": "ready", "by": by, "cutoff": cutoff }),
        DeleteCheck::Waiting { device, code } => json!({ "kind": "waiting", "device": device, "code": code.as_str() }),
        DeleteCheck::Refused(code) => json!({ "kind": "refused", "code": code.as_str() }),
    }
}

#[test]
fn shared_table_forget_order() {
    let cases = table()["forgetOrder"].as_array().unwrap().clone();
    assert!(cases.len() >= 10);
    for case in cases {
        let declarations: Vec<Declaration> = case["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| Declaration { by: d["by"].as_str().unwrap().to_owned(), entry: serde_json::from_value(d["entry"].clone()).unwrap() })
            .collect();
        let expected: BTreeMap<String, Verdict> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(forget_order(&declarations), expected, "{}", case["name"]);
    }
}

#[test]
fn shared_table_cutoff() {
    for case in table()["cutoff"].as_array().unwrap() {
        let ackers: Vec<(String, BTreeMap<String, DeviceAck>)> = case["ackers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a["deviceId"].as_str().unwrap().to_owned(), serde_json::from_value(a["acks"].clone()).unwrap()))
            .collect();
        let expected: Option<DeviceAck> = serde_json::from_value(case["expected"].clone()).unwrap();
        let result = cutoff(case["target"].as_str().unwrap(), ackers.iter().map(|(id, acks)| (id.as_str(), acks)));
        assert_eq!(result, expected, "{}", case["name"]);
    }
}

#[test]
fn shared_table_forgotten_delete_check() {
    for case in table()["forgottenDelete"].as_array().unwrap() {
        let known: Vec<KnownDevice> = case["known"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| KnownDevice {
                device_id: d["deviceId"].as_str().unwrap().to_owned(),
                status: status_of(d["status"].as_str().unwrap()),
                state: if d["state"].is_null() {
                    None
                } else {
                    Some(KnownState {
                        state_seq: d["state"]["stateSeq"].as_u64().unwrap(),
                        acks: serde_json::from_value(d["state"]["acks"].clone()).unwrap(),
                        forgotten: serde_json::from_value(d["state"]["forgotten"].clone()).unwrap(),
                    })
                },
            })
            .collect();
        let check = forgotten_delete_check(case["target"].as_str().unwrap(), case["self"].as_str().unwrap(), &known);
        assert_eq!(check_json(&check), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn shared_table_write_state_forgotten() {
    for case in table()["writeStateForgotten"].as_array().unwrap() {
        let master: Vec<ForgottenDevice> = serde_json::from_value(case["master"].clone()).unwrap();
        let published: Vec<ForgottenDevice> = serde_json::from_value(case["published"].clone()).unwrap();
        let expected: Option<Vec<ForgottenDevice>> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(completed_forgotten(&published, &master), expected, "{}", case["name"]);
    }
}

#[test]
fn declaration_hlc_follows_every_known_hlc() {
    assert_eq!(next_declaration_hlc(5_000, [], DEV_A), hlc(5_000, DEV_A));
    assert_eq!(next_declaration_hlc(5_000, [hlc(4_000, DEV_B).as_str()], DEV_A), hlc(5_000, DEV_A));
    // Horloge locale en retard sur un hlc lu : même milliseconde, compteur suivant.
    let later = hlc(9_000, DEV_B);
    assert_eq!(next_declaration_hlc(5_000, [later.as_str()], DEV_A), format!("{:015}-0001-{DEV_A}", 9_000));
    assert!(next_declaration_hlc(5_000, [later.as_str(), "pas un hlc"], DEV_A) > later);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Appareils simulés sur un même dossier
// ------------------------------------------------------------------------------------------------------------------------------

struct Folder {
    fs: std::sync::Arc<MemFs>,
    a: Device,
    b: Device,
    x: Device,
    seq: BTreeMap<&'static str, u64>,
}

fn joined(fs: &std::sync::Arc<MemFs>, owner: &Device, dev: &str) -> Device {
    let d = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()));
    d.vault.set(SYNC_KEY_ACCOUNT, &owner.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    d.core.bind_device(dev).unwrap();
    d
}

fn ack(dev: &str, segment: u64, record: u64, state_seq: u64) -> Value {
    json!({ "epoch": epoch(1, DEV_A), "segment": segment, "record": record, "hlc": if segment == 0 { Value::Null } else { json!(hlc(segment * 100 + record, dev)) }, "stateSeq": state_seq })
}

fn state_json(dev: &str, seq: u64, head: (u64, u64, Option<String>), acks: Value, forgotten: Value) -> Value {
    let ep = epoch(1, DEV_A);
    json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": SV, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": head.0, "record": head.1, "hlc": head.2, "stateSeq": seq },
        "acks": acks, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000 + seq, dev), "forgotten": forgotten, "reset": null
    })
}

impl Folder {
    /// A (premier appareil), B et X sur le même dossier ; X publie deux segments (2 enregistrements dans le premier, 1 dans le second).
    fn new() -> Self {
        let (a, fs) = device();
        a.setup(DEV_A);
        let b = joined(&fs, &a, DEV_B);
        let x = joined(&fs, &a, DEV_X);
        let ep = epoch(1, DEV_A);
        for (segment, expect, ms) in [(1, 0, 101), (1, 1, 102), (2, 0, 201)] {
            x.core.append_journal(&AppendRequest { epoch: ep.clone(), segment, expect_records: expect, sv: SV, max_hlc: hlc(ms, DEV_X), records: vec!["{}".into()] }).unwrap();
        }
        let mut f = Self { fs, a, b, x, seq: BTreeMap::new() };
        f.publish("x", json!({}), None).unwrap();
        f.publish("a", json!({}), None).unwrap();
        f.publish("b", json!({}), None).unwrap();
        f
    }

    fn dev(&self, who: &str) -> (&Device, &'static str) {
        match who {
            "a" => (&self.a, DEV_A),
            "b" => (&self.b, DEV_B),
            _ => (&self.x, DEV_X),
        }
    }

    /// Publie l'état de `who` (accusés donnés ; `forgotten` : liste publiée par le moteur, vide par défaut : Rust complète).
    fn publish(&mut self, who: &'static str, acks: Value, forgotten: Option<Value>) -> Result<(), SyncError> {
        let seq = self.seq.get(who).copied().unwrap_or(0) + 1;
        let (d, dev) = self.dev(who);
        let head = if who == "x" { (2, 1, Some(hlc(201, DEV_X))) } else { (0, 0, None) };
        d.core.write_state(SV, state_json(dev, seq, head, acks, forgotten.unwrap_or(json!([]))))?;
        self.seq.insert(who, seq);
        Ok(())
    }

    fn seq_of(&self, who: &str) -> u64 {
        self.seq[who]
    }

    /// Accusés « à jour » sur X (2, 1) et sur l'état courant des autres.
    fn acks_up_to_date(&self, who: &str, x_at: (u64, u64)) -> Value {
        let mut acks = serde_json::Map::new();
        for (other, dev) in [("a", DEV_A), ("b", DEV_B)] {
            if other != who {
                acks.insert(dev.to_owned(), ack(dev, 0, 0, self.seq_of(other)));
            }
        }
        acks.insert(DEV_X.to_owned(), ack(DEV_X, x_at.0, x_at.1, self.seq_of("x")));
        Value::Object(acks)
    }

    fn files_of(&self, dev: &str) -> Vec<String> {
        let prefix = format!("devices/{dev}/");
        self.fs.names().into_iter().filter(|n| n.starts_with(&prefix)).collect()
    }

    /// A oublie X (boîte acceptée), puis tout le monde publie ses accusés à jour (A d'abord, B ensuite, A de nouveau).
    fn forget_x_and_settle(&mut self) {
        self.a.core.device_forget(DEV_X, 1).unwrap();
        let acks = self.acks_up_to_date("a", (2, 1));
        self.publish("a", acks, None).unwrap();
        let acks = self.acks_up_to_date("b", (2, 1));
        self.publish("b", acks, None).unwrap();
        let acks = self.acks_up_to_date("a", (2, 1));
        let published = self.published_forgotten(DEV_A);
        self.publish("a", acks, Some(published)).unwrap();
        let acks = self.acks_up_to_date("b", (2, 1));
        self.publish("b", acks, None).unwrap();
    }

    fn published_forgotten(&self, dev: &str) -> Value {
        let scan = self.b.core.scan(&[]).unwrap();
        let state = scan.devices.iter().find(|d| d.device_id == dev).and_then(|d| d.state.clone()).expect("état publié");
        serde_json::to_value(&state.forgotten).unwrap()
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_device_forget (critères 3, 5 et 6)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn device_forget_refusals_before_any_dialog() {
    // Sans dossier, sans clé, sans liaison.
    let (d, _) = device();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::NotConfigured);
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::KeyMissing);
    d.core.key_create().unwrap();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::NotBound);
    assert_eq!(d.ui.prompts(), 0);

    let f = Folder::new();
    // Identifiant mal formé, chemin, appareil local, appareil inconnu.
    for bad in ["", "..", "../devices", "5C6D7E8F-9A0B-4C1D-8E2F-3A4B5C6D7E8F", "devices/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f"] {
        assert_eq!(code(f.a.core.device_forget(bad, 1)), SyncCode::BadName, "{bad}");
    }
    assert_eq!(code(f.a.core.device_forget(DEV_A, 1)), SyncCode::BadName);
    assert_eq!(code(f.a.core.device_forget(DEV_C, 1)), SyncCode::BadName);
    // Réinitialisation en cours (entrée `.next` au coffre, Y-11).
    f.a.vault.set(SYNC_NEXT_KEY_ACCOUNT, "réservé").unwrap();
    assert_eq!(code(f.a.core.device_forget(DEV_X, 1)), SyncCode::StateMismatch);
    f.a.vault.delete(SYNC_NEXT_KEY_ACCOUNT).unwrap();
    assert_eq!(f.a.ui.prompts(), 0, "aucune boîte pour un refus");
    assert!(!f.a.base.path().join("sync").join(FORGOTTEN_FILE).exists(), "rien n'est écrit");
}

#[test]
fn device_forget_dialog_outcomes() {
    let f = Folder::new();
    let file = f.a.base.path().join("sync").join(FORGOTTEN_FILE);
    // Pas au premier plan : aucune boîte, rien d'écrit.
    f.a.ui.ready(false);
    assert_eq!(code(f.a.core.device_forget(DEV_X, 1)), SyncCode::NotForeground);
    f.a.ui.ready(true);
    assert_eq!(f.a.ui.prompts(), 0);
    // Refus de la boîte : rien d'écrit, puis 10 minutes de blocage (compteurs persistés, mêmes règles que Y-08).
    f.a.ui.answer(false);
    assert_eq!(code(f.a.core.device_forget(DEV_X, 1)), SyncCode::ConsentDenied);
    assert!(!file.exists());
    let spec = f.a.ui.last.lock().unwrap().clone().expect("boîte");
    assert_eq!(spec.default_button, circletasks_lib::sync::consent::IDCANCEL, "« Annuler » par défaut");
    assert_eq!(spec.texts.instruction, "Oublier cet appareil ?");
    f.a.ui.answer(true);
    assert_eq!(code(f.a.core.device_forget(DEV_X, 1)), SyncCode::RateLimited);
    f.a.clock.advance(10 * 60_000);
    f.a.core.device_forget(DEV_X, 1).unwrap();
    assert_eq!(f.a.ui.prompts(), 2);
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let entries = saved["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["deviceId"], DEV_X);
    let at = entries[0]["at"].as_str().unwrap();
    assert!(at.ends_with(DEV_A), "daté par l'appareil qui oublie");
    assert!(at > hlc(201, DEV_X).as_str() && at > hlc(1_003, DEV_B).as_str(), "après tout hlc authentifié connu");
    // Déjà oublié (déclaré) : succès sans effet, sans boîte.
    f.a.core.device_forget(DEV_X, 1).unwrap();
    assert_eq!(f.a.ui.prompts(), 2);
    let again: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(again, saved);
}

#[test]
fn device_forget_rate_limit_three_openings_per_ten_minutes() {
    let f = Folder::new();
    for dev in [DEV_C, DEV_D] {
        let other = joined(&f.fs, &f.a, dev);
        other.core.write_state(SV, state_json(dev, 1, (0, 0, None), json!({}), json!([]))).unwrap();
    }
    for target in [DEV_X, DEV_B, DEV_C] {
        f.a.core.device_forget(target, 1).unwrap();
    }
    assert_eq!(code(f.a.core.device_forget(DEV_D, 1)), SyncCode::RateLimited, "quatrième ouverture en 10 minutes");
    assert_eq!(f.a.ui.prompts(), 3);
    // Compteur persisté : relu après un redémarrage.
    let mut a = f.a;
    a.restart();
    assert_eq!(code(a.core.device_forget(DEV_D, 1)), SyncCode::RateLimited);
    a.clock.advance(10 * 60_000);
    a.core.device_forget(DEV_D, 1).unwrap();
}

#[test]
fn device_forget_keeps_at_most_64_declarations() {
    let f = Folder::new();
    let ids: Vec<String> = (0..65).map(|i| format!("{:08x}-0000-4000-8000-000000000000", 0x1000_0000 + i)).collect();
    for id in &ids {
        f.fs.mkdir(&["devices", id]);
    }
    for (i, id) in ids.iter().take(64).enumerate() {
        if i > 0 && i % 3 == 0 {
            f.a.clock.advance(10 * 60_000);
        }
        f.a.core.device_forget(id, 1).unwrap();
    }
    f.a.clock.advance(10 * 60_000);
    let prompts = f.a.ui.prompts();
    assert_eq!(code(f.a.core.device_forget(&ids[64], 1)), SyncCode::TooLarge);
    assert_eq!(f.a.ui.prompts(), prompts, "refus avant toute boîte");
    let saved: Value = serde_json::from_slice(&std::fs::read(f.a.base.path().join("sync").join(FORGOTTEN_FILE)).unwrap()).unwrap();
    assert_eq!(saved["entries"].as_array().unwrap().len(), 64);
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_write_state : Rust maître de `forgotten` (critère 6)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn write_state_publishes_rusts_list_and_refuses_any_other() {
    let mut f = Folder::new();
    // Avant toute déclaration : une liste non vide est refusée.
    let fake = json!([{ "deviceId": DEV_X, "at": hlc(5_000, DEV_A), "lastAck": null }]);
    assert_eq!(code(f.publish("a", json!({}), Some(fake.clone()))), SyncCode::StateMismatch);
    f.a.core.device_forget(DEV_X, 1).unwrap();
    // Liste vide envoyée : Rust complète avec sa déclaration.
    f.publish("a", json!({}), None).unwrap();
    let published = f.published_forgotten(DEV_A);
    assert_eq!(published.as_array().unwrap().len(), 1);
    assert_eq!(published[0]["deviceId"], DEV_X);
    // Liste égale : acceptée ; modifiée (hlc plus ancien pour gagner l'ordre total) : refusée.
    f.publish("a", json!({}), Some(published.clone())).unwrap();
    let mut earlier = published.clone();
    earlier[0]["at"] = json!(hlc(1, DEV_A));
    assert_eq!(code(f.publish("a", json!({}), Some(earlier))), SyncCode::StateMismatch);
    let mut extra = published.as_array().unwrap().clone();
    extra.push(json!({ "deviceId": DEV_B, "at": hlc(9_999_999, DEV_A), "lastAck": null }));
    assert_eq!(code(f.publish("a", json!({}), Some(Value::Array(extra)))), SyncCode::StateMismatch);
    // Après un redémarrage, forgotten.json fait foi ; perdu, il est reconstruit depuis son state.ctx authentifié.
    f.a.restart();
    f.publish("a", json!({}), None).unwrap();
    assert_eq!(f.published_forgotten(DEV_A), published);
    std::fs::remove_file(f.a.base.path().join("sync").join(FORGOTTEN_FILE)).unwrap();
    f.a.restart();
    f.publish("a", json!({}), None).unwrap();
    assert_eq!(f.published_forgotten(DEV_A), published, "un oubli ne décroît jamais");
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_forgotten_delete (critères 11 et 12)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn forgotten_delete_removes_only_strict_names_state_last_and_is_idempotent() {
    let mut f = Folder::new();
    let ep = epoch(1, DEV_A);
    // Noms étrangers dans le dossier de X : jamais lus ni supprimés.
    f.fs.put(&["devices", DEV_X, "state 2.ctx"], b"copie de conflit");
    f.fs.put(&["devices", DEV_X, &ep, "j-00000003.ctj.tmp"], b"temporaire");
    f.forget_x_and_settle();
    let others_before: Vec<String> = f.fs.names().into_iter().filter(|n| !n.starts_with(&format!("devices/{DEV_X}"))).collect();
    let capture = log::capture();
    let result = f.a.core.forgotten_delete(DEV_X).unwrap();
    assert!(result.complete);
    assert_eq!(result.deleted, 3, "deux segments et state.ctx (dossier d'époque gardé : il contient un nom étranger)");
    assert_eq!(f.files_of(DEV_X).iter().filter(|n| !n.ends_with(".tmp") && !n.ends_with("state 2.ctx") && !n.ends_with(&ep)).count(), 0);
    assert!(f.files_of(DEV_X).iter().any(|n| n.ends_with("state 2.ctx")) && f.files_of(DEV_X).iter().any(|n| n.ends_with(".tmp")));
    let others_after: Vec<String> = f.fs.names().into_iter().filter(|n| !n.starts_with(&format!("devices/{DEV_X}"))).collect();
    assert_eq!(others_before, others_after, "aucun fichier d'un autre dossier n'est touché");
    // Journal : identifiants et nombres, jamais de chemin.
    let lines = capture.lines();
    assert!(lines.iter().any(|l| l.starts_with("sync:forgotten-delete ") && l.contains(DEV_X)));
    assert!(lines.iter().all(|l| !l.contains(FOLDER) && !l.contains("devices/") && !l.contains('\\')), "{lines:?}");
    // Deux appareils qui suppriment : sans erreur, rien de plus.
    let again = f.b.core.forgotten_delete(DEV_X).unwrap();
    assert_eq!((again.deleted, again.complete), (0, true));
    assert_eq!(f.a.core.forgotten_delete(DEV_X).unwrap().deleted, 0);
}

#[test]
fn forgotten_delete_refusals_one_by_one_delete_nothing() {
    // Identifiant mal formé, hors de devices/, appareil local.
    let mut f = Folder::new();
    for bad in ["..", "../a", "devices", DEV_X.to_uppercase().as_str(), ""] {
        assert_eq!(code(f.a.core.forgotten_delete(bad)), SyncCode::BadName, "{bad}");
    }
    assert_eq!(code(f.a.core.forgotten_delete(DEV_A)), SyncCode::BadName);
    let x_files = f.files_of(DEV_X);
    // Aucune déclaration authentifiée.
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // Déclaration confirmée mais pas encore publiée : pas encore dans un état authentifié.
    f.a.core.device_forget(DEV_X, 1).unwrap();
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // Publiée, mais B n'a pas accusé X jusqu'à la coupure (A a lu (2, 1), B (1, 2)).
    let acks = f.acks_up_to_date("a", (2, 1));
    f.publish("a", acks, None).unwrap();
    let acks = f.acks_up_to_date("b", (1, 2));
    f.publish("b", acks, None).unwrap();
    assert_eq!(code(f.b.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // B à jour de la coupure, mais n'a pas accusé l'état de A qui porte la déclaration.
    let mut acks = f.acks_up_to_date("b", (2, 1));
    acks[DEV_A]["stateSeq"] = json!(f.seq_of("a") - 1);
    f.publish("b", acks, None).unwrap();
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // A n'a pas encore accusé la coupure atteinte par B (maximum des accusés, pas le seul accusé de l'appareil qui oublie).
    let acks = f.acks_up_to_date("b", (2, 1));
    f.publish("b", acks, None).unwrap();
    let acks = f.acks_up_to_date("a", (1, 1));
    let published = f.published_forgotten(DEV_A);
    f.publish("a", acks, Some(published)).unwrap();
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // État d'un actif dans le nuage : cloud-pending.
    f.forget_x_and_settle_after_declaration();
    f.fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Cloud);
    *f.fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::CloudPending);
    f.fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Local);
    // Réinitialisation en cours.
    f.a.vault.set(SYNC_NEXT_KEY_ACCOUNT, "réservé").unwrap();
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    f.a.vault.delete(SYNC_NEXT_KEY_ACCOUNT).unwrap();
    assert_eq!(f.files_of(DEV_X), x_files, "aucun refus ne supprime quoi que ce soit");
    // Conditions réunies : supprimé.
    assert!(f.a.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(f.files_of(DEV_X).is_empty());
}

impl Folder {
    /// Déclaration déjà faite par A : publications à jour de A et B.
    fn forget_x_and_settle_after_declaration(&mut self) {
        for who in ["a", "b", "a", "b"] {
            let acks = self.acks_up_to_date(who, (2, 1));
            let published = if who == "a" { Some(self.published_forgotten(DEV_A)) } else { None };
            self.publish(who, acks, published).unwrap();
        }
    }
}

#[test]
fn forgotten_delete_passes_are_bounded_and_keep_state_last() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_X);
    for n in 1..=5u32 {
        fs.put(&["devices", DEV_X, &ep, &format!("j-{n:08}.ctj")], b"x");
    }
    fs.put(&["devices", DEV_X, &ep, "s-00000001.cts"], b"x");
    fs.put(&["devices", DEV_X, "state.ctx"], b"x");
    fs.put(&["devices", DEV_X, "state.next.ctx"], b"x");
    let mut passes = 0;
    loop {
        passes += 1;
        let pass = delete_forgotten_device_files(&shared(&fs), DEV_X, 2).unwrap();
        let names = fs.names();
        if !pass.complete {
            assert!(names.iter().any(|n| n.ends_with("/state.ctx")), "state.ctx supprimé en dernier");
            continue;
        }
        assert!(names.iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))), "{names:?}");
        break;
    }
    assert_eq!(passes, 5, "2 entrées par passe : 6 fichiers, 1 dossier d'époque, 2 états");
    // Dossier déjà absent : sans erreur.
    let pass = delete_forgotten_device_files(&shared(&fs), DEV_X, 2).unwrap();
    assert_eq!((pass.deleted, pass.complete), (0, true));
    // Chemin hors de devices/<uuid>/ : refusé avant toute opération.
    assert!(delete_forgotten_device_files(&shared(&fs), "..", 2).is_err());
}

fn shared(fs: &std::sync::Arc<MemFs>) -> crate::sync_support::SharedFs {
    crate::sync_support::SharedFs(fs.clone())
}

// ------------------------------------------------------------------------------------------------------------------------------
// Attaques (exigence de sécurité de la fiche)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn attack_replayed_state_cannot_advance_the_deletion() {
    let mut f = Folder::new();
    f.a.core.device_forget(DEV_X, 1).unwrap();
    let acks = f.acks_up_to_date("a", (2, 1));
    f.publish("a", acks, None).unwrap();
    // État de B où il n'a pas encore lu jusqu'à la coupure, gardé par un tiers.
    let acks = f.acks_up_to_date("b", (1, 1));
    f.publish("b", acks, None).unwrap();
    let old_b = f.fs.get(&["devices", DEV_B, "state.ctx"]).unwrap();
    f.forget_x_and_settle_after_declaration();
    // A a vu le dernier état de B ; le tiers remet l'ancien : rejeu, B n'est plus lisible, rien n'est supprimé.
    f.a.core.scan(&[]).unwrap();
    f.fs.put(&["devices", DEV_B, "state.ctx"], &old_b);
    let x_files = f.files_of(DEV_X);
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    assert_eq!(f.files_of(DEV_X), x_files);
}

#[test]
fn attack_forgotten_device_cannot_forget_or_delete_the_one_that_forgot_it() {
    let mut f = Folder::new();
    f.forget_x_and_settle();
    // X (qui a encore la clé) apprend son oubli : il ne peut plus déclarer, ni supprimer chez A.
    assert_eq!(code(f.x.core.device_forget(DEV_A, 1)), SyncCode::StateMismatch);
    assert_eq!(code(f.x.core.forgotten_delete(DEV_A)), SyncCode::StateMismatch);
    // Aucun autre appareil ne voit A oublié : ses fichiers ne sont jamais supprimés.
    let a_files = f.files_of(DEV_A);
    assert_eq!(code(f.b.core.forgotten_delete(DEV_A)), SyncCode::StateMismatch);
    assert_eq!(f.files_of(DEV_A), a_files);
    // Les fichiers de X, eux, peuvent être supprimés.
    assert!(f.b.core.forgotten_delete(DEV_X).unwrap().complete);
}

#[test]
fn attack_crossed_declarations_only_the_oldest_counts() {
    let mut f = Folder::new();
    // X oublie A d'abord (X n'a pas encore appris quoi que ce soit), A oublie X ensuite.
    f.x.core.device_forget(DEV_A, 1).unwrap();
    f.x.clock.advance(1);
    let x_acks = json!({ DEV_A: ack(DEV_A, 0, 0, 1), DEV_B: ack(DEV_B, 0, 0, 1) });
    f.publish("x", x_acks, None).unwrap();
    f.a.clock.advance(60_000);
    // A a lu la déclaration de X : sa propre déclaration est refusée (A est oublié).
    assert_eq!(code(f.a.core.device_forget(DEV_X, 1)), SyncCode::StateMismatch);
    // B ne peut supprimer ni les fichiers de X (non oublié) ni ceux de A tant que les conditions ne sont pas réunies.
    assert_eq!(code(f.b.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    assert_eq!(code(f.b.core.forgotten_delete(DEV_A)), SyncCode::StateMismatch);
}

#[test]
fn attack_foreign_state_forgets_nobody_and_never_unlocks_a_deletion() {
    let mut f = Folder::new();
    // Faux state.ctx étranger (sans la clé) qui prétend oublier A et B : statut foreign, déclaration ignorée.
    f.fs.put(&["devices", DEV_C, "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    let scan = f.a.core.scan(&[]).unwrap();
    let c = scan.devices.iter().find(|d| d.device_id == DEV_C).unwrap();
    assert_ne!(c.state_status, "ok");
    // A peut toujours oublier X (personne ne l'a oublié) ; la suppression attend C (actif illisible) : rien n'est supprimé.
    f.forget_x_and_settle();
    let x_files = f.files_of(DEV_X);
    assert_eq!(code(f.a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    assert_eq!(f.files_of(DEV_X), x_files);
    // Le faux dossier disparaît (tiers ou appareil qui revient) : la suppression peut se faire.
    f.fs.remove(&["devices", DEV_C, "state.ctx"]);
    f.fs.remove(&["devices", DEV_C]);
    assert!(f.a.core.forgotten_delete(DEV_X).unwrap().complete);
}
