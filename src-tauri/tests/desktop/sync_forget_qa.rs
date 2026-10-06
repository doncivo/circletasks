//! Y-10, QA (qa-test) : comparaison différentielle Rust / TypeScript de l'ordre total, de la coupure et des conditions de suppression
//! sur des cas pseudo-aléatoires figés (`tests/fixtures/sync/forget-order-random.json`, produits par `forgetRandom.ts` avec la sortie
//! TypeScript pour référence ; règles de l'ADR 0011 §18 points 3 à 10), registre `forgotten.json` falsifié ou illisible, faux dossier
//! `devices/<uuid>` (fantôme jamais vu, non bloquant) et appareil cité par un seul oublié. Aucune attente réelle.

use std::collections::BTreeMap;
use std::path::Path;

use circletasks_lib::sync::forget::{cutoff, forget_order, forgotten_delete_check, learn_declarations, DeleteCheck, Verdict, FORGOTTEN_FILE};
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::state::DeviceAck;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};

use crate::sync_forget::{check_json, entries_of, known_of, snapshot_of};
use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, FOLDER};
use circletasks_lib::sync::service::SYNC_KEY_ACCOUNT;

const DEV_X: &str = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const GHOST: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SV: u64 = 14;

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

fn random_table() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/sync/forget-order-random.json")).expect("table aléatoire figée")
}

#[test]
fn qa_differential_forget_order_matches_typescript() {
    let cases = random_table()["forgetOrder"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 120);
    for case in cases {
        let expected: BTreeMap<String, Verdict> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(forget_order(&entries_of(&case["entries"])), expected, "{}", case["name"]);
    }
}

#[test]
fn qa_differential_learn_matches_typescript() {
    let cases = random_table()["learn"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 80);
    for case in cases {
        let cap = case["cap"].as_u64().unwrap() as usize;
        let (entries, overflow) = learn_declarations(&entries_of(&case["master"]), &entries_of(&case["candidates"]), cap);
        assert_eq!(json!({ "entries": entries, "overflow": overflow }), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn qa_differential_cutoff_matches_typescript() {
    let cases = random_table()["cutoff"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 120);
    for case in cases {
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
fn qa_differential_forgotten_delete_check_matches_typescript() {
    let cases = random_table()["forgottenDelete"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 300);
    let mut ready = 0;
    let mut waiting = 0;
    for case in cases {
        let done: Vec<String> = serde_json::from_value(case["done"].clone()).unwrap();
        let check = forgotten_delete_check(case["target"].as_str().unwrap(), case["self"].as_str().unwrap(), &entries_of(&case["master"]), &done, &known_of(&case), &snapshot_of(&case["ownSnapshot"]));
        let actual = check_json(&check);
        assert_eq!(actual, case["expected"], "{}", case["name"]);
        match check {
            DeleteCheck::Ready { .. } => ready += 1,
            DeleteCheck::Waiting { .. } => waiting += 1,
            DeleteCheck::Refused(_) => {}
        }
    }
    // La table n'est utile que si elle exerce les deux issues principales.
    assert!(ready >= 30 && waiting >= 100, "ready {ready}, waiting {waiting}");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Deux appareils sur un même dossier : A et X (+ un faux dossier)
// ------------------------------------------------------------------------------------------------------------------------------

fn joined(fs: &std::sync::Arc<MemFs>, owner: &Device, dev: &str) -> Device {
    let d = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()));
    d.vault.set(SYNC_KEY_ACCOUNT, &owner.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    d.core.bind_device(dev).unwrap();
    d
}

fn state_json(dev: &str, seq: u64) -> Value {
    let ep = epoch(1, DEV_A);
    json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": SV, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": 0, "record": 0, "hlc": null, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000 + seq, dev), "forgotten": [], "reset": null
    })
}

/// Instantané `n` de `dev` (un seul enregistrement `snap-end`, `covers` donnés) puis état `seq` qui l'annonce (§18 point 11).
fn announce_snapshot(d: &Device, dev: &str, seq: u64, n: u64, covers: Value) {
    let ep = epoch(1, DEV_A);
    let handle = d.core.snapshot_begin(&ep, n, SV).unwrap();
    d.core.snapshot_append(handle, &[json!({ "k": "snap-end", "count": 0, "covers": covers, "epoch": ep, "sv": SV }).to_string()]).unwrap();
    d.core.snapshot_commit(handle).unwrap();
    let mut state = state_json(dev, seq);
    state["snapshot"] = json!({ "seq": n, "endHlc": hlc(5_000 + n, dev) });
    d.core.write_state(SV, state).unwrap();
}

fn published_forgotten(a: &Device) -> Vec<String> {
    let scan = a.core.scan(&[]).unwrap();
    let state = scan.devices.iter().find(|d| d.device_id == DEV_A).and_then(|d| d.state.clone()).expect("état publié de A");
    state.forgotten.iter().map(|f| f.device_id.clone()).collect()
}

fn a_and_x() -> (Device, Device, std::sync::Arc<MemFs>) {
    let (a, fs) = device();
    a.setup(DEV_A);
    let x = joined(&fs, &a, DEV_X);
    x.core.write_state(SV, state_json(DEV_X, 1)).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 1)).unwrap();
    (a, x, fs)
}

#[test]
fn qa_forgotten_json_of_another_folder_or_identity_is_rebuilt_and_a_corrupt_one_is_io() {
    let (mut a, _x, _fs) = a_and_x();
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()]);
    let file = a.base.path().join("sync").join(FORGOTTEN_FILE);
    let entry = json!({ "deviceId": GHOST, "at": hlc(9_000_000_000_000, DEV_A), "lastAck": null });
    // Autre dossier, autre identité : registre absent, reconstruit depuis les états authentifiés (son propre état est `ok`) ; la liste
    // falsifiée n'est jamais reprise, la déclaration authentique revient.
    let mut seq = 2;
    for forged in [
        json!({ "folderId": "un-autre-dossier", "deviceId": DEV_A, "entries": [entry] }).to_string(),
        json!({ "folderId": "icloud", "deviceId": DEV_X, "entries": [entry] }).to_string(),
    ] {
        std::fs::write(&file, &forged).unwrap();
        a.restart();
        seq += 1;
        a.core.write_state(SV, state_json(DEV_A, seq)).unwrap();
        assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()], "{forged}");
    }
    // Illisible (JSON cassé, vide) : `io`, jamais traité comme absent, rien n'est réécrit (ADR 0011 §18 point 7).
    for forged in ["{ pas du json".to_owned(), String::new()] {
        std::fs::write(&file, &forged).unwrap();
        a.restart();
        seq += 1;
        assert_eq!(code(a.core.write_state(SV, state_json(DEV_A, seq))), SyncCode::Io, "{forged}");
        assert_eq!(code(a.core.scan(&[])), SyncCode::Io);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), forged);
    }
}

#[test]
fn qa_fake_device_folder_never_seen_does_not_block_the_deletion_and_can_still_be_forgotten() {
    let (a, _x, fs) = a_and_x();
    // Un dossier devices/<uuid> sans aucun état (reste d'un essai, d'une copie de conflit, d'un appareil jamais abouti) : fantôme jamais
    // vu, ni actif ni bloquant (ADR 0011 §18 point 8 a).
    fs.mkdir(&["devices", GHOST]);
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    // Condition (h) (§18 point 11) : aucun instantané annoncé par A, appel direct (WebView) : refusé, rien supprimé.
    assert_eq!(code(a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    assert!(fs.names().iter().any(|n| n.starts_with(&format!("devices/{DEV_X}"))));
    announce_snapshot(&a, DEV_A, 3, 2, json!({}));
    assert!(a.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(fs.names().iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))));
    // Il reste oubliable (il est dans devices/), et ses fichiers supprimables ensuite (dossier vide : sans erreur).
    a.clock.advance(10 * 60_000);
    a.core.device_forget(GHOST, 1).unwrap();
    announce_snapshot(&a, DEV_A, 4, 3, json!({}));
    assert!(a.core.forgotten_delete(GHOST).unwrap().complete);
}

#[test]
fn qa_device_cited_only_by_a_forgotten_device_is_not_known_and_does_not_block() {
    let (a, x, fs) = a_and_x();
    // X cite dans ses accusés un appareil dont le dossier a disparu (supprimé à la main dans iCloud).
    let mut with_ack = state_json(DEV_X, 2);
    with_ack["acks"] = json!({ GHOST: { "epoch": epoch(1, DEV_A), "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 } });
    x.core.write_state(SV, with_ack).unwrap();
    a.core.device_forget(DEV_X, 1).unwrap();
    announce_snapshot(&a, DEV_A, 2, 2, json!({}));
    // X est oublié : ses accusés ne font connaître personne (audit Y-10 c) ; la suppression se fait.
    assert!(a.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(fs.names().iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))));
}

#[test]
fn qa_forget_order_ignores_a_declaration_whose_hlc_is_not_strict() {
    // Même si le suffixe est un identifiant d'appareil : un hlc mal formé n'oublie personne (TypeScript : voir forgetDifferential.test.ts).
    let bad = format!("bad791000000023-0000-{DEV_A}");
    assert!(forget_order(&entries_of(&json!([{ "deviceId": DEV_X, "at": bad, "lastAck": null }]))).is_empty());
}

#[test]
fn qa_interrupted_write_of_forgotten_json_leaves_no_declaration_and_the_next_attempt_succeeds() {
    let (a, _x, _fs) = a_and_x();
    let dir = a.base.path().join("sync");
    std::fs::create_dir_all(&dir).unwrap();
    // Arrêt entre l'écriture du fichier temporaire et le renommage : un `.tmp` orphelin (même contenu falsifié) ne vaut jamais déclaration.
    let entry = json!({ "deviceId": GHOST, "at": hlc(9_000_000_000_000, DEV_A), "lastAck": null });
    std::fs::write(dir.join(format!("{FORGOTTEN_FILE}.tmp")), json!({ "folderId": "icloud", "deviceId": DEV_A, "entries": [entry] }).to_string()).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    assert!(published_forgotten(&a).is_empty(), "rien n'est déclaré");
    // Registre persisté dès le premier usage (ADR 0011 §18 point 7), sans aucune déclaration : le .tmp orphelin n'a pas été repris.
    let registry: Value = serde_json::from_slice(&std::fs::read(dir.join(FORGOTTEN_FILE)).unwrap()).unwrap();
    assert!(registry["entries"].as_array().unwrap().is_empty());
    // La tentative suivante aboutit : seule la déclaration confirmée est publiée, le `.tmp` orphelin est remplacé.
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 3)).unwrap();
    assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()]);
    assert!(!dir.join(format!("{FORGOTTEN_FILE}.tmp")).exists());
}
