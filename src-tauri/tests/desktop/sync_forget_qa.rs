//! Y-10, QA (qa-test) : comparaison différentielle Rust / TypeScript de l'ordre total, de la coupure et des conditions de suppression
//! sur des cas pseudo-aléatoires figés (`tests/fixtures/sync/forget-order-random.json`, produits par `forgetRandom.ts` avec la sortie
//! TypeScript pour référence), `forgotten.json` falsifié ou illisible, faux dossier `devices/<uuid>` qui bloque la suppression et sa
//! résolution possible côté Rust. Aucune attente réelle.

use std::collections::BTreeMap;
use std::path::Path;

use circletasks_lib::sync::forget::{cutoff, forget_order, forgotten_delete_check, Declaration, DeleteCheck, KnownDevice, KnownState, Verdict, FORGOTTEN_FILE};
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::state::DeviceAck;
use circletasks_lib::sync::store::StateStatus;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};

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

#[test]
fn qa_differential_forget_order_matches_typescript() {
    let cases = random_table()["forgetOrder"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 120);
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
        let actual = match &check {
            DeleteCheck::Ready { by, cutoff } => json!({ "kind": "ready", "by": by, "cutoff": cutoff }),
            DeleteCheck::Waiting { device, code } => json!({ "kind": "waiting", "device": device, "code": code.as_str() }),
            DeleteCheck::Refused(code) => json!({ "kind": "refused", "code": code.as_str() }),
        };
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
fn qa_forgotten_json_of_another_folder_identity_or_corrupt_never_changes_the_published_list() {
    let (mut a, _x, _fs) = a_and_x();
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()]);
    let file = a.base.path().join("sync").join(FORGOTTEN_FILE);
    let entry = json!({ "deviceId": GHOST, "at": hlc(9_000_000_000_000, DEV_A), "lastAck": null });
    let forgeries = [
        json!({ "folderId": "un-autre-dossier", "deviceId": DEV_A, "entries": [entry] }).to_string(),
        json!({ "folderId": "icloud", "deviceId": DEV_X, "entries": [entry] }).to_string(),
        "{ pas du json".to_owned(),
        String::new(),
    ];
    let mut seq = 2;
    for forged in forgeries {
        std::fs::write(&file, &forged).unwrap();
        // Après redémarrage, un fichier d'une autre identité, d'un autre dossier ou illisible n'est jamais repris : liste reconstruite
        // depuis son propre `state.ctx` authentifié (un oubli ne décroît jamais, rien n'est ajouté).
        a.restart();
        seq += 1;
        a.core.write_state(SV, state_json(DEV_A, seq)).unwrap();
        assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()], "{forged}");
    }
}

#[test]
fn qa_fake_device_folder_blocks_the_deletion_until_it_is_forgotten_which_rust_allows() {
    let (a, _x, fs) = a_and_x();
    // Un dossier devices/<uuid> sans aucun état (reste d'un essai, d'une copie de conflit, d'un appareil jamais abouti).
    fs.mkdir(&["devices", GHOST]);
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    // Le faux dossier est un « actif » sans état : la suppression attend, sans fin et sans autre message que le code.
    for _ in 0..3 {
        assert_eq!(code(a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    }
    assert!(fs.names().iter().any(|n| n.starts_with(&format!("devices/{DEV_X}"))), "rien n'est supprimé");
    // Rust accepte pourtant d'oublier ce faux dossier (il est dans devices/) : la seule issue est donc une action de l'utilisateur.
    a.clock.advance(10 * 60_000);
    a.core.device_forget(GHOST, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 3)).unwrap();
    assert!(a.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(fs.names().iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))));
    // Les fichiers du faux dossier peuvent ensuite être supprimés à leur tour (dossier vide : sans erreur).
    assert!(a.core.forgotten_delete(GHOST).unwrap().complete);
}

#[test]
fn qa_device_cited_only_in_an_authenticated_ack_blocks_the_deletion_and_can_be_forgotten() {
    let (a, x, fs) = a_and_x();
    // X cite dans ses accusés un appareil dont le dossier a disparu (supprimé à la main dans iCloud).
    let mut with_ack = state_json(DEV_X, 2);
    with_ack["acks"] = json!({ GHOST: { "epoch": epoch(1, DEV_A), "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 } });
    x.core.write_state(SV, with_ack).unwrap();
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 2)).unwrap();
    assert_eq!(code(a.core.forgotten_delete(DEV_X)), SyncCode::StateMismatch);
    // X est oublié : son accusé ne compte plus (seuls les états des actifs comptent pour l'identité des actifs), mais le fantôme cité
    // reste un actif sans état tant que personne ne l'a oublié ; Rust l'accepte comme cible (cité dans un accusé authentifié).
    a.clock.advance(10 * 60_000);
    a.core.device_forget(GHOST, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 3)).unwrap();
    assert!(a.core.forgotten_delete(DEV_X).unwrap().complete);
    assert!(fs.names().iter().all(|n| !n.starts_with(&format!("devices/{DEV_X}"))));
}

#[test]
fn qa_forget_order_ignores_a_declaration_whose_hlc_is_not_strict() {
    // Même si le suffixe est l'identifiant de l'auteur : un hlc mal formé n'oublie personne (TypeScript : voir forgetDifferential.test.ts).
    let bad = format!("bad791000000023-0000-{DEV_A}");
    let declarations = vec![Declaration {
        by: DEV_A.to_owned(),
        entry: serde_json::from_value(json!({ "deviceId": DEV_X, "at": bad, "lastAck": null })).unwrap(),
    }];
    assert!(forget_order(&declarations).is_empty());
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
    assert!(!dir.join(FORGOTTEN_FILE).exists());
    // La tentative suivante aboutit : seule la déclaration confirmée est publiée, le `.tmp` orphelin est remplacé.
    a.core.device_forget(DEV_X, 1).unwrap();
    a.core.write_state(SV, state_json(DEV_A, 3)).unwrap();
    assert_eq!(published_forgotten(&a), vec![DEV_X.to_owned()]);
    assert!(!dir.join(format!("{FORGOTTEN_FILE}.tmp")).exists());
}
