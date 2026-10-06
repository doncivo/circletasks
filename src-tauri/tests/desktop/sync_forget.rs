//! Y-10 « J'oublie un appareil » (ADR 0011 sections 1.1, 1.4, 11.1, 14.2 et 18 points 3 à 10) : table de cas commune avec
//! `retention.ts`, registre `forgotten.json` (liste maître, anti-rejeu persistant, terminés ; reconstruction (i)(ii)(iii), refus, `io`),
//! `sync_device_forget` (préconditions, boîte avec détail lu par Rust, plafond 48, hlc borné), `sync_write_state` (liste maître),
//! `sync_forgotten_delete` (conditions révisées, fantômes, `done`), scénario « X oublie Z, A oublie X » et tests d'attaque. Horloge
//! contrôlée : aucune attente réelle.

use std::collections::BTreeMap;
use std::path::Path;

use circletasks_lib::sync::files::{delete_forgotten_device_files, Availability, FsError};
use circletasks_lib::sync::forget::{
    completed_forgotten, cutoff, forget_order, forgotten_delete_check, learn_declarations, local_date_time, next_declaration_hlc, DeleteCheck, KnownDevice, KnownState,
    Verdict, FORGOTTEN_FILE, SYNC_NEXT_KEY_ACCOUNT,
};
use circletasks_lib::sync::limits::PAIRING_CLOCK_TOLERANCE_MS;
use circletasks_lib::sync::log;
use circletasks_lib::sync::service::{AppendRequest, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::state::{DeviceAck, ForgottenDevice};
use circletasks_lib::sync::store::StateStatus;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, DEV_C, FOLDER, NOW};
use circletasks_lib::sync::folder::FolderKind;

const DEV_X: &str = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const DEV_Z: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const GHOST: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
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

pub fn status_of(name: &str) -> StateStatus {
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

pub fn check_json(check: &DeleteCheck) -> Value {
    match check {
        DeleteCheck::Ready { by, cutoff } => json!({ "kind": "ready", "by": by, "cutoff": cutoff }),
        DeleteCheck::Waiting { device, code } => json!({ "kind": "waiting", "device": device, "code": code.as_str() }),
        DeleteCheck::Refused(code) => json!({ "kind": "refused", "code": code.as_str() }),
    }
}

/// Appareils connus d'un cas de la table.
pub fn known_of(case: &Value) -> Vec<KnownDevice> {
    case["known"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| KnownDevice {
            device_id: d["deviceId"].as_str().unwrap().to_owned(),
            status: status_of(d["status"].as_str().unwrap()),
            seen: d["seen"].as_bool().unwrap(),
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
        .collect()
}

pub fn entries_of(value: &Value) -> Vec<ForgottenDevice> {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn shared_table_forget_order() {
    let cases = table()["forgetOrder"].as_array().unwrap().clone();
    assert!(cases.len() >= 12);
    for case in cases {
        let expected: BTreeMap<String, Verdict> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(forget_order(&entries_of(&case["entries"])), expected, "{}", case["name"]);
    }
}

#[test]
fn shared_table_learn() {
    for case in table()["learn"].as_array().unwrap() {
        let (entries, overflow) = learn_declarations(&entries_of(&case["master"]), &entries_of(&case["candidates"]), 64);
        assert_eq!(json!({ "entries": entries, "overflow": overflow }), case["expected"], "{}", case["name"]);
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
        let done: Vec<String> = serde_json::from_value(case["done"].clone()).unwrap();
        let check = forgotten_delete_check(case["target"].as_str().unwrap(), case["self"].as_str().unwrap(), &entries_of(&case["master"]), &done, &known_of(case));
        assert_eq!(check_json(&check), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn shared_table_write_state_forgotten() {
    for case in table()["writeStateForgotten"].as_array().unwrap() {
        let expected: Option<Vec<ForgottenDevice>> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(completed_forgotten(&entries_of(&case["published"]), &entries_of(&case["master"])), expected, "{}", case["name"]);
    }
}

#[test]
fn shared_table_declaration_hlc() {
    assert_eq!(PAIRING_CLOCK_TOLERANCE_MS, 120_000);
    for case in table()["declarationHlc"].as_array().unwrap() {
        let seen: Vec<String> = serde_json::from_value(case["seen"].clone()).unwrap();
        let result = next_declaration_hlc(case["nowMs"].as_u64().unwrap(), seen.iter().map(String::as_str), case["self"].as_str().unwrap(), PAIRING_CLOCK_TOLERANCE_MS);
        assert_eq!(json!(result), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn local_date_time_is_24h_and_civil() {
    assert_eq!(local_date_time(0), ("01/01/1970".to_owned(), "00:00".to_owned()));
    // 2026-10-06 14:05 UTC
    assert_eq!(local_date_time(1_791_295_500_000), ("06/10/2026".to_owned(), "14:05".to_owned()));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Appareils simulés sur un même dossier
// ------------------------------------------------------------------------------------------------------------------------------

struct Dev {
    id: &'static str,
    d: Device,
    seq: u64,
    head: (u64, u64, Option<String>),
}

struct Net {
    fs: std::sync::Arc<MemFs>,
    devs: Vec<Dev>,
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

fn state_json(dev: &str, seq: u64, head: &(u64, u64, Option<String>), acks: Value, forgotten: Value) -> Value {
    let ep = epoch(1, DEV_A);
    json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": SV, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": head.0, "record": head.1, "hlc": head.2, "stateSeq": seq },
        "acks": acks, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000 + seq, dev), "forgotten": forgotten, "reset": null
    })
}

impl Net {
    /// A (premier appareil), puis les autres associés ; chacun publie un premier état.
    fn new(ids: &[&'static str]) -> Self {
        let (a, fs) = device();
        a.setup(DEV_A);
        let mut devs = vec![Dev { id: DEV_A, d: a, seq: 0, head: (0, 0, None) }];
        for id in ids {
            let d = joined(&fs, &devs[0].d, id);
            devs.push(Dev { id, d, seq: 0, head: (0, 0, None) });
        }
        let mut net = Self { fs, devs };
        for id in net.ids() {
            net.publish_raw(id, json!({}), json!([])).unwrap();
        }
        net
    }

    fn ids(&self) -> Vec<&'static str> {
        self.devs.iter().map(|d| d.id).collect()
    }

    fn dev(&self, id: &str) -> &Dev {
        self.devs.iter().find(|d| d.id == id).expect("appareil")
    }

    fn dev_mut(&mut self, id: &str) -> &mut Dev {
        self.devs.iter_mut().find(|d| d.id == id).expect("appareil")
    }

    /// `id` publie trois enregistrements (segment 1 : 2, segment 2 : 1) et son état.
    fn journal(&mut self, id: &'static str) {
        let ep = epoch(1, DEV_A);
        for (segment, expect, ms) in [(1, 0, 101), (1, 1, 102), (2, 0, 201)] {
            self.dev(id).d.core.append_journal(&AppendRequest { epoch: ep.clone(), segment, expect_records: expect, sv: SV, max_hlc: hlc(ms, id), records: vec!["{}".into()] }).unwrap();
        }
        self.dev_mut(id).head = (2, 1, Some(hlc(201, id)));
        self.publish_raw(id, json!({}), json!([])).unwrap();
    }

    /// Écrit l'état de `id` tel quel (accusés et liste `forgotten` envoyée par le « moteur »).
    fn publish_raw(&mut self, id: &str, acks: Value, forgotten: Value) -> Result<(), SyncError> {
        let dev = self.dev(id);
        let seq = dev.seq + 1;
        dev.d.core.write_state(SV, state_json(id, seq, &dev.head, acks, forgotten))?;
        self.dev_mut(id).seq = seq;
        Ok(())
    }

    /// Un cycle de `id` : scan (fusion du registre), puis état republiant la liste maître rendue, accusés à jour (têtes, `stateSeq`) ;
    /// aucun accusé sur les appareils de `done` ; un appareil sans dossier n'est pas accusé.
    fn cycle(&mut self, id: &str) -> Result<(), SyncError> {
        let scan = self.dev(id).d.core.scan(&[])?;
        let mut acks = serde_json::Map::new();
        for other in &self.devs {
            if other.id == id || scan.forgotten.done.iter().any(|d| d == other.id) || !self.fs.names().iter().any(|n| n == &format!("devices/{}", other.id)) {
                continue;
            }
            acks.insert(other.id.to_owned(), ack(other.id, other.head.0, other.head.1, other.seq));
        }
        let forgotten = serde_json::to_value(&scan.forgotten.entries).unwrap();
        self.publish_raw(id, Value::Object(acks), forgotten)
    }

    /// Plusieurs tours de cycles des appareils donnés (les erreurs d'un appareil oublié qui ne peut plus rien écrire sont ignorées).
    fn settle(&mut self, ids: &[&str], rounds: usize) {
        for _ in 0..rounds {
            for id in ids {
                let _ = self.cycle(id);
            }
        }
    }

    fn files_of(&self, dev: &str) -> Vec<String> {
        let prefix = format!("devices/{dev}/");
        self.fs.names().into_iter().filter(|n| n.starts_with(&prefix)).collect()
    }

    fn registry(&self, id: &str) -> Value {
        serde_json::from_slice(&std::fs::read(self.dev(id).d.base.path().join("sync").join(FORGOTTEN_FILE)).unwrap()).unwrap()
    }

    fn published_forgotten(&self, of: &str) -> Vec<String> {
        let scan = self.dev(DEV_A).d.core.scan(&[]).unwrap();
        let state = scan.devices.iter().find(|d| d.device_id == of).and_then(|d| d.state.clone()).expect("état publié");
        state.forgotten.iter().map(|f| f.device_id.clone()).collect()
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_device_forget (critères 3, 5 et 6 ; §18 points 5 et 8)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn device_forget_refusals_before_any_dialog() {
    let (d, _) = device();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::NotConfigured);
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::KeyMissing);
    d.core.key_create().unwrap();
    assert_eq!(code(d.core.device_forget(DEV_X, 1)), SyncCode::NotBound);
    assert_eq!(d.ui.prompts(), 0);

    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.settle(&[DEV_A, DEV_B, DEV_X], 1);
    let a = &net.dev(DEV_A).d;
    for bad in ["", "..", "../devices", "5C6D7E8F-9A0B-4C1D-8E2F-3A4B5C6D7E8F", "devices/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f"] {
        assert_eq!(code(a.core.device_forget(bad, 1)), SyncCode::BadName, "{bad}");
    }
    assert_eq!(code(a.core.device_forget(DEV_A, 1)), SyncCode::BadName);
    assert_eq!(code(a.core.device_forget(DEV_C, 1)), SyncCode::BadName);
    a.vault.set(SYNC_NEXT_KEY_ACCOUNT, "réservé").unwrap();
    assert_eq!(code(a.core.device_forget(DEV_X, 1)), SyncCode::StateMismatch);
    a.vault.delete(SYNC_NEXT_KEY_ACCOUNT).unwrap();
    assert_eq!(a.ui.prompts(), 0, "aucune boîte pour un refus");
    assert!(net.registry(DEV_A)["entries"].as_array().unwrap().is_empty(), "rien n'est déclaré");
}

#[test]
fn device_forget_dialog_shows_what_rust_read_and_outcomes() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    net.settle(&[DEV_A, DEV_B, DEV_X], 1);
    let a = &net.dev(DEV_A).d;
    a.ui.ready(false);
    assert_eq!(code(a.core.device_forget(DEV_X, 1)), SyncCode::NotForeground);
    a.ui.ready(true);
    assert_eq!(a.ui.prompts(), 0);
    a.ui.answer(false);
    assert_eq!(code(a.core.device_forget(DEV_X, 1)), SyncCode::ConsentDenied);
    let spec = a.ui.last.lock().unwrap().clone().expect("boîte");
    assert_eq!(spec.default_button, circletasks_lib::sync::consent::IDCANCEL, "« Annuler » par défaut");
    assert_eq!(spec.texts.instruction, "Oublier cet appareil ?");
    // Audit e : détail lu par Rust dans l'état authentifié de X (plateforme, 8 caractères, date et heure sur 24 h).
    assert!(spec.texts.content.starts_with("PC Windows · identifiant 5c6d7e8f… · dernière synchronisation le "), "{}", spec.texts.content);
    assert!(regex_like_time(&spec.texts.content));
    assert!(net.registry(DEV_A)["entries"].as_array().unwrap().is_empty());
    a.ui.answer(true);
    assert_eq!(code(a.core.device_forget(DEV_X, 1)), SyncCode::RateLimited);
    a.clock.advance(10 * 60_000);
    a.core.device_forget(DEV_X, 1).unwrap();
    let entries = net.registry(DEV_A)["entries"].as_array().unwrap().clone();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["deviceId"], DEV_X);
    let at = entries[0]["at"].as_str().unwrap();
    assert!(at.ends_with(DEV_A), "auteur = appareil du hlc : celui qui oublie");
    // Déjà oublié (déclaré) : succès sans boîte, rien de plus.
    let prompts = a.ui.prompts();
    a.core.device_forget(DEV_X, 1).unwrap();
    assert_eq!(a.ui.prompts(), prompts);
    assert_eq!(net.registry(DEV_A)["entries"].as_array().unwrap().len(), 1);
}

fn regex_like_time(text: &str) -> bool {
    // « … le jj/mm/aaaa à hh:mm »
    text.split(" à ").nth(1).is_some_and(|rest| rest.len() >= 5 && rest.as_bytes()[2] == b':' && rest[..2].bytes().all(|b| b.is_ascii_digit()) && rest[3..5].bytes().all(|b| b.is_ascii_digit()))
}

#[test]
fn device_forget_dialog_for_a_device_never_read() {
    let net = Net::new(&[DEV_B]);
    net.fs.mkdir(&["devices", GHOST]);
    let a = &net.dev(DEV_A).d;
    a.ui.answer(false);
    assert_eq!(code(a.core.device_forget(GHOST, 1)), SyncCode::ConsentDenied);
    let spec = a.ui.last.lock().unwrap().clone().expect("boîte");
    assert!(spec.texts.content.starts_with("Appareil jamais lu · identifiant eeeeeeee…"), "{}", spec.texts.content);
}

#[test]
fn device_forget_refused_from_48_declarations_before_the_dialog() {
    let net = Net::new(&[DEV_B]);
    let ids: Vec<String> = (0..49).map(|i| format!("{:08x}-0000-4000-8000-000000000000", 0x1000_0000 + i)).collect();
    for id in &ids {
        net.fs.mkdir(&["devices", id]);
    }
    let a = &net.dev(DEV_A).d;
    for (i, id) in ids.iter().take(48).enumerate() {
        if i > 0 && i % 3 == 0 {
            a.clock.advance(10 * 60_000);
        }
        a.core.device_forget(id, 1).unwrap();
    }
    a.clock.advance(10 * 60_000);
    let prompts = a.ui.prompts();
    assert_eq!(code(a.core.device_forget(&ids[48], 1)), SyncCode::TooLarge);
    assert_eq!(a.ui.prompts(), prompts, "refus avant toute boîte");
    assert_eq!(net.registry(DEV_A)["entries"].as_array().unwrap().len(), 48);
}

#[test]
fn device_forget_hlc_ignores_the_target_forgotten_devices_and_far_future_hlcs_and_refuses_a_non_strict_one() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    // X (la cible) publie un hlc très en avance : ignoré pour dater la déclaration.
    let x = net.dev(DEV_X);
    let mut state = state_json(DEV_X, x.seq + 1, &x.head, json!({}), json!([]));
    state["lastSyncHlc"] = json!(hlc(NOW + 3_600_000, DEV_X));
    x.d.core.write_state(SV, state).unwrap();
    net.dev_mut(DEV_X).seq += 1;
    // B (actif) publie un hlc au-delà de la tolérance : ignoré aussi.
    let b = net.dev(DEV_B);
    let mut state = state_json(DEV_B, b.seq + 1, &b.head, json!({}), json!([]));
    state["lastSyncHlc"] = json!(hlc(NOW + PAIRING_CLOCK_TOLERANCE_MS + 1, DEV_B));
    b.d.core.write_state(SV, state).unwrap();
    net.dev_mut(DEV_B).seq += 1;
    let a = &net.dev(DEV_A).d;
    a.core.scan(&[]).unwrap();
    a.core.device_forget(DEV_X, 1).unwrap();
    let at = net.registry(DEV_A)["entries"][0]["at"].as_str().unwrap().to_owned();
    assert_eq!(at, hlc(NOW, DEV_A));
    // Horloge hors bornes : hlc non strict, refus `hlc-order`, rien d'écrit.
    a.clock.0.store(1_000_000_000_000_000, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(code(a.core.device_forget(DEV_B, 1)), SyncCode::HlcOrder);
    assert_eq!(net.registry(DEV_A)["entries"].as_array().unwrap().len(), 1);
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_write_state : liste maître (critère 6, §18 point 3)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn write_state_publishes_the_master_list_and_refuses_any_other() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    let fake = json!([{ "deviceId": DEV_X, "at": hlc(5_000, DEV_A), "lastAck": null }]);
    assert_eq!(code(net.publish_raw(DEV_A, json!({}), fake)), SyncCode::StateMismatch);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.publish_raw(DEV_A, json!({}), json!([])).unwrap();
    assert_eq!(net.published_forgotten(DEV_A), vec![DEV_X.to_owned()]);
    let published: Value = serde_json::to_value(net.registry(DEV_A)["entries"].clone()).unwrap();
    net.publish_raw(DEV_A, json!({}), published.clone()).unwrap();
    let mut earlier = published.clone();
    earlier[0]["at"] = json!(hlc(1, DEV_A));
    assert_eq!(code(net.publish_raw(DEV_A, json!({}), earlier)), SyncCode::StateMismatch);
    // B apprend la déclaration de A à son scan et la republie (liste maître entière).
    net.cycle(DEV_B).unwrap();
    assert_eq!(net.published_forgotten(DEV_B), vec![DEV_X.to_owned()]);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Registre (§18 point 7) : reconstruction, refus, io, non-décroissance, anti-rejeu persistant
// ------------------------------------------------------------------------------------------------------------------------------

fn registry_path(d: &Device) -> std::path::PathBuf {
    d.base.path().join("sync").join(FORGOTTEN_FILE)
}

#[test]
fn registry_unreadable_is_io_and_nothing_is_written() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    for broken in ["{ pas du json".to_owned(), String::new(), json!({ "folderId": "x", "deviceId": DEV_A, "entries": [{ "deviceId": DEV_X, "at": "pas un hlc", "lastAck": null }] }).to_string()] {
        let path = registry_path(&net.dev(DEV_A).d);
        std::fs::write(&path, &broken).unwrap();
        net.dev_mut(DEV_A).d.restart();
        assert_eq!(code(net.dev(DEV_A).d.core.scan(&[])), SyncCode::Io, "{broken}");
        assert_eq!(code(net.publish_raw(DEV_A, json!({}), json!([]))), SyncCode::Io);
        assert_eq!(code(net.dev(DEV_A).d.core.device_forget(DEV_B, 1)), SyncCode::Io);
        assert_eq!(code(net.dev(DEV_A).d.core.forgotten_delete(DEV_X)), SyncCode::Io);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken, "rien n'est réécrit");
    }
    // Plus de 64 entrées : illisible aussi.
    let many: Vec<Value> = (0..65).map(|i| json!({ "deviceId": format!("{:08x}-0000-4000-8000-000000000000", 0x2000_0000 + i), "at": hlc(10 + i, DEV_A), "lastAck": null })).collect();
    std::fs::write(registry_path(&net.dev(DEV_A).d), json!({ "folderId": "x", "deviceId": DEV_A, "entries": many }).to_string()).unwrap();
    net.dev_mut(DEV_A).d.restart();
    assert_eq!(code(net.dev(DEV_A).d.core.scan(&[])), SyncCode::Io);
}

#[test]
fn registry_rebuilt_case_i_when_own_state_is_ok_and_never_shrinks_after_restart() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.cycle(DEV_A).unwrap();
    net.cycle(DEV_B).unwrap();
    let before = net.registry(DEV_A);
    // Redémarrage : registre relu tel quel, jamais plus court.
    net.dev_mut(DEV_A).d.restart();
    net.cycle(DEV_A).unwrap();
    assert_eq!(net.registry(DEV_A)["entries"], before["entries"]);
    // Registre d'un autre dossier (ou effacé) : absent, reconstruit depuis les états authentifiés (son propre état est `ok`).
    let mut other = before.clone();
    other["folderId"] = json!("un-autre-dossier");
    std::fs::write(registry_path(&net.dev(DEV_A).d), other.to_string()).unwrap();
    net.dev_mut(DEV_A).d.restart();
    net.cycle(DEV_A).unwrap();
    let rebuilt = net.registry(DEV_A);
    assert_eq!(rebuilt["entries"], before["entries"]);
    assert!(rebuilt["accepted"].as_object().unwrap().contains_key(DEV_B), "anti-rejeu repris du scan");
    assert_eq!(net.published_forgotten(DEV_A), vec![DEV_X.to_owned()]);
}

#[test]
fn registry_rebuilt_case_ii_for_a_device_that_never_published() {
    let net = Net::new(&[DEV_B]);
    let fresh = joined(&net.fs, &net.dev(DEV_A).d, DEV_C);
    // Jamais publié : aucun fichier, aucun accusé sur lui. Le scan reconstruit un registre (vide de ses déclarations, celles des autres apprises).
    let scan = fresh.core.scan(&[]).unwrap();
    assert!(scan.forgotten.entries.is_empty());
    assert!(registry_path(&fresh).exists());
}

#[test]
fn registry_rebuilt_case_iii_when_own_state_was_replaced_and_an_active_acknowledged_it() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.cycle(DEV_A).unwrap();
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_B).unwrap();
    // Un tiers remplace le state.ctx de A ; le registre de A est perdu (dossier de configuration effacé, own.json gardé).
    net.fs.put(&["devices", DEV_A, "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    std::fs::remove_file(registry_path(&net.dev(DEV_A).d)).unwrap();
    net.dev_mut(DEV_A).d.restart();
    // B a accusé l'état de A au stateSeq de own.json : reconstruction (iii) ; la déclaration revient par la liste republiée par B.
    let scan = net.dev(DEV_A).d.core.scan(&[]).unwrap();
    assert_eq!(scan.forgotten.entries.iter().map(|e| e.device_id.clone()).collect::<Vec<_>>(), vec![DEV_X.to_owned()]);
}

#[test]
fn registry_rebuild_refusals() {
    // État remplacé sans accusé qui le couvre : state-mismatch ; dans le nuage : cloud-pending ; plus récent : newer-format.
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_A).unwrap();
    net.cycle(DEV_A).unwrap();
    net.fs.put(&["devices", DEV_A, "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    std::fs::remove_file(registry_path(&net.dev(DEV_A).d)).unwrap();
    net.dev_mut(DEV_A).d.restart();
    assert_eq!(code(net.dev(DEV_A).d.core.scan(&[])), SyncCode::StateMismatch);
    assert!(!registry_path(&net.dev(DEV_A).d).exists(), "rien n'est écrit");

    let mut net = Net::new(&[DEV_B]);
    net.fs.set_availability(&["devices", DEV_A, "state.ctx"], Availability::Cloud);
    *net.fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    std::fs::remove_file(registry_path(&net.dev(DEV_A).d)).unwrap();
    net.dev_mut(DEV_A).d.restart();
    assert_eq!(code(net.dev(DEV_A).d.core.forgotten_delete(DEV_B)), SyncCode::CloudPending);

    let mut net = Net::new(&[DEV_B]);
    let mut bytes = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap().replacen("\"sm\":1", "\"sm\":2", 1);
    bytes = text.into_bytes();
    net.fs.put(&["devices", DEV_A, "state.ctx"], &bytes);
    std::fs::remove_file(registry_path(&net.dev(DEV_A).d)).unwrap();
    net.dev_mut(DEV_A).d.restart();
    assert_eq!(code(net.dev(DEV_A).d.core.scan(&[])), SyncCode::NewerFormat);
}

#[test]
fn replayed_state_after_restart_is_rollback_even_before_the_first_cycle_and_nothing_is_deleted() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    // Oublis croisés : X oublie B d'abord (déclaration la plus ancienne), puis A oublie X.
    net.dev(DEV_X).d.core.device_forget(DEV_B, 1).unwrap();
    net.cycle(DEV_X).unwrap();
    let old_x = net.fs.get(&["devices", DEV_X, "state.ctx"]).unwrap();
    net.settle(&[DEV_A, DEV_B], 2);
    // X publie un état plus récent ; A le lit (anti-rejeu persistant).
    net.cycle(DEV_X).unwrap();
    net.dev(DEV_A).d.core.scan(&[]).unwrap();
    // Redémarrage de Rust chez A ; un tiers remet l'ancien état de X ; une WebView compromise appelle la suppression avant tout cycle.
    net.dev_mut(DEV_A).d.restart();
    net.fs.put(&["devices", DEV_X, "state.ctx"], &old_x);
    let files = net.files_of(DEV_B);
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_B).is_err());
    let scan = net.dev(DEV_A).d.core.scan(&[]).unwrap();
    assert_eq!(scan.devices.iter().find(|d| d.device_id == DEV_X).unwrap().state_status, "rollback");
    assert_eq!(net.files_of(DEV_B), files, "rien n'est supprimé");
}

// ------------------------------------------------------------------------------------------------------------------------------
// sync_forgotten_delete (critères 11 et 12, §18 points 6, 8 et 9)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn forgotten_delete_removes_only_strict_names_state_last_records_done_and_is_idempotent() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    let ep = epoch(1, DEV_A);
    net.fs.put(&["devices", DEV_X, "state 2.ctx"], b"copie de conflit");
    net.fs.put(&["devices", DEV_X, &ep, "j-00000003.ctj.tmp"], b"temporaire");
    net.settle(&[DEV_A, DEV_B], 1);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A, DEV_B], 2);
    let others_before: Vec<String> = net.fs.names().into_iter().filter(|n| !n.starts_with(&format!("devices/{DEV_X}"))).collect();
    let capture = log::capture();
    let result = net.dev(DEV_A).d.core.forgotten_delete(DEV_X).unwrap();
    assert!(result.complete);
    assert_eq!(result.deleted, 3, "deux segments et state.ctx (dossier d'époque gardé : nom étranger)");
    assert!(net.files_of(DEV_X).iter().any(|n| n.ends_with("state 2.ctx")) && net.files_of(DEV_X).iter().any(|n| n.ends_with(".tmp")));
    let others_after: Vec<String> = net.fs.names().into_iter().filter(|n| !n.starts_with(&format!("devices/{DEV_X}")) && !n.contains("sync/")).collect();
    assert_eq!(others_before, others_after, "aucun fichier d'un autre dossier n'est touché");
    assert_eq!(net.registry(DEV_A)["done"], json!([DEV_X]));
    let lines = capture.lines();
    assert!(lines.iter().any(|l| l.starts_with("sync:forgotten-delete ") && l.contains(DEV_X)));
    assert!(lines.iter().all(|l| !l.contains(FOLDER) && !l.contains("devices/") && !l.contains('\\')), "{lines:?}");
    // B, qui ne l'a pas encore inscrit dans `done`, supprime aussi : sans erreur, rien de plus.
    let again = net.dev(DEV_B).d.core.forgotten_delete(DEV_X).unwrap();
    assert_eq!((again.deleted, again.complete), (0, true));
    assert_eq!(net.registry(DEV_B)["done"], json!([DEV_X]));
}

#[test]
fn forgotten_delete_refusals_one_by_one_delete_nothing() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    net.settle(&[DEV_A, DEV_B], 1);
    for bad in ["..", "../a", "devices", DEV_X.to_uppercase().as_str(), ""] {
        assert_eq!(code(a(&net).core.forgotten_delete(bad)), SyncCode::BadName, "{bad}");
    }
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_A)), SyncCode::BadName);
    let x_files = net.files_of(DEV_X);
    // Aucune déclaration.
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // Déclarée : B n'a pas encore republié la déclaration (condition f).
    a(&net).core.device_forget(DEV_X, 1).unwrap();
    net.cycle(DEV_A).unwrap();
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // B l'a republiée mais n'a pas lu X jusqu'à la coupure.
    net.dev_mut(DEV_X).head = (2, 1, Some(hlc(201, DEV_X)));
    let scan = net.dev(DEV_B).d.core.scan(&[]).unwrap();
    let forgotten = serde_json::to_value(&scan.forgotten.entries).unwrap();
    let seq_a = net.dev(DEV_A).seq;
    net.publish_raw(DEV_B, json!({ DEV_A: ack(DEV_A, 0, 0, seq_a), DEV_X: ack(DEV_X, 1, 1, 1) }), forgotten).unwrap();
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // État de B dans le nuage : cloud-pending.
    net.settle(&[DEV_A, DEV_B], 2);
    net.fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Cloud);
    *net.fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::CloudPending);
    net.fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Local);
    // state.ctx de X lui-même dans le nuage (condition g) : cloud-pending.
    net.fs.set_availability(&["devices", DEV_X, "state.ctx"], Availability::Cloud);
    *net.fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::CloudPending);
    net.fs.set_availability(&["devices", DEV_X, "state.ctx"], Availability::Local);
    // Réinitialisation en cours.
    a(&net).vault.set(SYNC_NEXT_KEY_ACCOUNT, "réservé").unwrap();
    assert_eq!(code(a(&net).core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    a(&net).vault.delete(SYNC_NEXT_KEY_ACCOUNT).unwrap();
    assert_eq!(net.files_of(DEV_X), x_files, "aucun refus ne supprime quoi que ce soit");
    assert!(a(&net).core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(net.files_of(DEV_X).is_empty());
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
    let mut total = 0;
    loop {
        passes += 1;
        let pass = delete_forgotten_device_files(&shared(&fs), DEV_X, 2).unwrap();
        total += pass.deleted;
        if !pass.complete {
            assert!(fs.names().iter().any(|n| n.ends_with("/state.ctx")), "state.ctx supprimé en dernier");
            continue;
        }
        assert!(fs.names().iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))));
        break;
    }
    assert_eq!(passes, 5, "2 entrées par passe : 6 fichiers, 1 dossier d'époque, 2 états");
    assert_eq!(total, 9, "le dossier d'époque compte une fois, quand il a disparu");
    let pass = delete_forgotten_device_files(&shared(&fs), DEV_X, 2).unwrap();
    assert_eq!((pass.deleted, pass.complete), (0, true));
    assert!(delete_forgotten_device_files(&shared(&fs), "..", 2).is_err());
    assert_eq!(circletasks_lib::sync::forget::MAX_FORGOTTEN_DELETE_ENTRIES, 1_000);
}

fn a(net: &Net) -> &Device {
    &net.dev(DEV_A).d
}

fn shared(fs: &std::sync::Arc<MemFs>) -> crate::sync_support::SharedFs {
    crate::sync_support::SharedFs(fs.clone())
}

#[test]
fn phantom_never_seen_does_not_block_a_seen_device_without_folder_does() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    // Fantômes jamais vus : dossier vide, état illisible.
    net.fs.mkdir(&["devices", GHOST]);
    net.fs.put(&["devices", DEV_Z, "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    net.settle(&[DEV_A, DEV_B], 1);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A, DEV_B], 2);
    let capture = log::capture();
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(capture.lines().iter().any(|l| l == &format!("sync:forgotten-delete-phantom {GHOST}")));
    // Un appareil vu (B) dont le dossier disparaît (tiers sans clé) bloque toujours la suppression d'un autre oublié.
    let mut net = Net::new(&[DEV_B, DEV_C, DEV_X]);
    net.journal(DEV_X);
    net.settle(&[DEV_A, DEV_B, DEV_C], 1);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A, DEV_B, DEV_C], 2);
    net.fs.remove(&["devices", DEV_C, "state.ctx"]);
    net.fs.remove(&["devices", DEV_C]);
    assert_eq!(code(net.dev(DEV_A).d.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Scénario §18 point 10 : X oublie Z, A oublie X, suppression de X
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn x_forgets_z_then_a_forgets_x_z_stays_forgotten_after_x_files_are_gone_and_after_restart() {
    let mut net = Net::new(&[DEV_X, DEV_Z]);
    net.journal(DEV_X);
    net.settle(&[DEV_A, DEV_X, DEV_Z], 1);
    // X oublie Z ; tous lisent (A apprend la déclaration de X).
    net.dev(DEV_X).d.core.device_forget(DEV_Z, 1).unwrap();
    net.settle(&[DEV_X, DEV_A], 2);
    // A oublie X ; A seul actif : conditions réunies, fichiers de X supprimés, state.ctx compris.
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A], 2);
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(net.files_of(DEV_X).is_empty());
    // (1) Z reste oublié chez Rust (liste maître), sans l'état de X ; la suppression des fichiers de Z est possible (Z ne bloque pas).
    let scan = net.dev(DEV_A).d.core.scan(&[]).unwrap();
    let order = forget_order(&scan.forgotten.entries);
    assert!(order.contains_key(DEV_Z) && order.contains_key(DEV_X));
    assert_eq!(scan.forgotten.done, vec![DEV_X.to_owned()]);
    net.settle(&[DEV_A], 1);
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_Z).unwrap().complete);
    // Après redémarrage aussi.
    net.dev_mut(DEV_A).d.restart();
    let scan = net.dev(DEV_A).d.core.scan(&[]).unwrap();
    assert!(forget_order(&scan.forgotten.entries).contains_key(DEV_Z));
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_Z).unwrap().complete);
}

#[test]
fn x_state_deleted_by_a_third_party_before_x_is_forgotten_z_stays_forgotten() {
    let mut net = Net::new(&[DEV_B, DEV_X, DEV_Z]);
    net.dev(DEV_X).d.core.device_forget(DEV_Z, 1).unwrap();
    net.settle(&[DEV_X, DEV_A, DEV_B], 2);
    // Un tiers sans clé supprime le state.ctx de X : la déclaration est déjà republiée par A et B.
    net.fs.remove(&["devices", DEV_X, "state.ctx"]);
    net.settle(&[DEV_A, DEV_B], 1);
    let scan = net.dev(DEV_B).d.core.scan(&[]).unwrap();
    assert!(forget_order(&scan.forgotten.entries).contains_key(DEV_Z));
    assert!(net.published_forgotten(DEV_A).contains(&DEV_Z.to_owned()));
}

#[test]
fn a_device_paired_later_learns_every_forget_from_any_active() {
    let mut net = Net::new(&[DEV_X, DEV_Z]);
    net.journal(DEV_X);
    net.dev(DEV_X).d.core.device_forget(DEV_Z, 1).unwrap();
    net.settle(&[DEV_X, DEV_A], 2);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A], 2);
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_X).unwrap().complete);
    // N est associé ensuite : son premier scan apprend Z et X oubliés, dans l'état de A seulement.
    let n = joined(&net.fs, &net.dev(DEV_A).d, DEV_C);
    let scan = n.core.scan(&[]).unwrap();
    let order = forget_order(&scan.forgotten.entries);
    assert!(order.contains_key(DEV_Z) && order.contains_key(DEV_X));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Attaques
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn attack_forgotten_device_cannot_forget_or_delete_the_one_that_forgot_it() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    net.settle(&[DEV_A, DEV_B], 1);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A, DEV_B, DEV_X], 2);
    let x = &net.dev(DEV_X).d;
    assert_eq!(code(x.core.device_forget(DEV_A, 1)), SyncCode::StateMismatch);
    assert_eq!(code(x.core.forgotten_delete(DEV_A)), SyncCode::StateMismatch);
    let a_files = net.files_of(DEV_A);
    assert_eq!(code(net.dev(DEV_B).d.core.forgotten_delete(DEV_A)), SyncCode::StateMismatch);
    assert_eq!(net.files_of(DEV_A), a_files);
    assert!(net.dev(DEV_B).d.core.forgotten_delete(DEV_X).unwrap().complete);
}

#[test]
fn attack_crossed_declarations_only_the_oldest_counts() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.dev(DEV_X).d.core.device_forget(DEV_A, 1).unwrap();
    net.cycle(DEV_X).unwrap();
    net.dev(DEV_A).d.clock.advance(60_000);
    // A a lu la déclaration de X (scan) : sa propre déclaration est refusée (A est oublié).
    net.dev(DEV_A).d.core.scan(&[]).unwrap();
    assert_eq!(code(net.dev(DEV_A).d.core.device_forget(DEV_X, 1)), SyncCode::StateMismatch);
    assert_eq!(code(net.dev(DEV_B).d.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
}

#[test]
fn attack_foreign_state_forgets_nobody() {
    let mut net = Net::new(&[DEV_B, DEV_X]);
    net.journal(DEV_X);
    // Faux state.ctx étranger (sans la clé) : statut foreign, aucune déclaration apprise ; fantôme jamais vu, il ne bloque pas.
    net.fs.put(&["devices", DEV_C, "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    let scan = net.dev(DEV_A).d.core.scan(&[]).unwrap();
    assert_ne!(scan.devices.iter().find(|d| d.device_id == DEV_C).unwrap().state_status, "ok");
    assert!(scan.forgotten.entries.is_empty());
    net.settle(&[DEV_A, DEV_B], 1);
    net.dev(DEV_A).d.core.device_forget(DEV_X, 1).unwrap();
    net.settle(&[DEV_A, DEV_B], 2);
    assert!(net.dev(DEV_A).d.core.forgotten_delete(DEV_X).unwrap().complete);
}
