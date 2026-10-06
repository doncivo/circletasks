//! Y-11 « Je réinitialise la synchronisation avec une nouvelle clé » (ADR 0011 sections 2.2, 9.1, 11.1, 14.3, 14.4 et 18 point 2) :
//! table de cas commune avec `epoch.ts`, `sync_reset_key` (refus avant la boîte, précondition, confirmation, `K2` sous `.next`, reprise),
//! annonce maîtresse (Rust), époque `n+1` sous `K2` dans `state.next.ctx`, réassociation vers `.next`, bascule (et reprise après un arrêt
//! avant chacune de ses écritures), perte d'une réinitialisation simultanée (et ses arrêts), isolement des clés, journal sans clé.
//! Horloge contrôlée : aucune attente réelle.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use circletasks_lib::sync::crypto::{parse_qr_text, MasterKey, Place};
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::forget::SYNC_NEXT_KEY_ACCOUNT;
use circletasks_lib::sync::log;
use circletasks_lib::sync::reset::{
    reset_precondition, reset_waiting, reset_winner, restore_candidates, valid_reset, ForgottenCut, LagReason, OpenedEpoch, PreconditionDevice, ResetCandidate, ResetKnown, RESET_FILE,
};
use circletasks_lib::sync::service::{AppendRequest, KeyInput, ResetView, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::state::DeviceAck;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::sync_forget::status_of;
use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, DEV_C, FOLDER};

const SV: u64 = 14;
/// Deuxième appareil qui réinitialise en même temps que A (UUID supérieur à celui de A : il gagne).
const DEV_W: &str = "fafafafa-fafa-4afa-8afa-fafafafafafa";

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Table de cas commune (tests/fixtures/sync/reset-order.json)
// ------------------------------------------------------------------------------------------------------------------------------

fn table() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/sync/reset-order.json")).expect("table de cas")
}

fn candidate_of(value: &Value) -> ResetCandidate {
    serde_json::from_value(value.clone()).expect("annonce")
}

fn ack_of(value: &Value) -> Option<DeviceAck> {
    (!value.is_null()).then(|| serde_json::from_value(value.clone()).expect("accusé"))
}

#[test]
fn shared_table_valid_reset() {
    let cases = table()["validReset"].as_array().unwrap().clone();
    assert!(cases.len() >= 8);
    for case in cases {
        assert_eq!(valid_reset(&candidate_of(&case["candidate"])), case["expected"].as_bool().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn shared_table_reset_winner() {
    let cases = table()["resetWinner"].as_array().unwrap().clone();
    assert!(cases.len() >= 8);
    for case in cases {
        let candidates: Vec<ResetCandidate> = case["candidates"].as_array().unwrap().iter().map(candidate_of).collect();
        let forgotten: BTreeSet<String> = case["forgotten"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        let winner = reset_winner(&candidates, &forgotten).map(|w| json!({ "by": w.by, "epoch": w.notice.epoch }));
        assert_eq!(winner.unwrap_or(Value::Null), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn shared_table_reset_precondition() {
    let cases = table()["resetPrecondition"].as_array().unwrap().clone();
    assert!(cases.len() >= 9);
    for case in cases {
        let actives: Vec<PreconditionDevice> = case["actives"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| PreconditionDevice {
                device_id: d["deviceId"].as_str().unwrap().to_owned(),
                status: status_of(d["status"].as_str().unwrap()),
                head: ack_of(&d["head"]),
                expired: d["expired"].as_bool().unwrap(),
                phantom: d["phantom"].as_bool().unwrap(),
            })
            .collect();
        let forgotten: Vec<ForgottenCut> =
            case["forgotten"].as_array().unwrap().iter().map(|f| ForgottenCut { device_id: f["deviceId"].as_str().unwrap().to_owned(), cutoff: ack_of(&f["cutoff"]) }).collect();
        let own: BTreeMap<String, DeviceAck> = serde_json::from_value(case["ownAcks"].clone()).unwrap();
        let got = reset_precondition(&actives, &forgotten, &own).map(|(device, reason)| json!({ "device": device, "reason": reason.as_str() }));
        assert_eq!(got.unwrap_or(Value::Null), case["expected"], "{}", case["name"]);
    }
    assert_eq!(LagReason::Cutoff.as_str(), "cutoff");
}

#[test]
fn shared_table_reset_waiting() {
    let cases = table()["resetWaiting"].as_array().unwrap().clone();
    assert!(cases.len() >= 6);
    for case in cases {
        let known: Vec<ResetKnown> = case["known"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| ResetKnown {
                device_id: d["deviceId"].as_str().unwrap().to_owned(),
                status: status_of(d["status"].as_str().unwrap()),
                epoch: d["epoch"].as_str().map(str::to_owned),
                kid: d["kid"].as_str().map(str::to_owned),
                seen: d["seen"].as_bool().unwrap(),
                author: d["author"].as_bool().unwrap(),
            })
            .collect();
        let forgotten: BTreeSet<String> = case["forgotten"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        let got = reset_waiting(&known, case["self"].as_str().unwrap(), case["epoch"].as_str().unwrap(), case["kid"].as_str().unwrap(), &forgotten);
        assert_eq!(json!(got), case["expected"], "{}", case["name"]);
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Appareils simulés partageant un dossier
// ------------------------------------------------------------------------------------------------------------------------------

/// Arrêt simulé : nom de l'étape qui échoue une fois (`io`).
#[derive(Clone, Default)]
struct Stop(Arc<Mutex<Option<String>>>);

impl Stop {
    fn at(&self, step: &str) {
        *self.0.lock().unwrap() = Some(step.to_owned());
    }
}

struct Dev {
    id: &'static str,
    d: Device,
    stop: Stop,
    seq: u64,
    epoch: String,
    head: (u64, u64, Option<String>),
    snap: Option<(u64, String)>,
    acks: Value,
    forgotten: Value,
    /// Nombre d'enregistrements publiés (hlc croissants).
    written: u64,
}

struct Net {
    fs: Arc<MemFs>,
    devs: Vec<Dev>,
}

fn with_stop(backend: Arc<FakeBackend>) -> (Device, Stop) {
    let stop = Stop::default();
    let hook = stop.clone();
    let d = Device::with_options(backend, move |o| {
        o.interrupt = Some(Arc::new(move |step: &str| {
            let mut guard = hook.0.lock().unwrap();
            if guard.as_deref() == Some(step) {
                *guard = None;
                return true;
            }
            false
        }));
    });
    (d, stop)
}

fn snap_end(covers: &Value, ep: &str) -> String {
    json!({ "k": "snap-end", "count": 0, "covers": covers, "epoch": ep, "sv": SV }).to_string()
}

fn state_json(dev: &Dev, reset: Value) -> Value {
    let snapshot = dev.snap.as_ref().map_or(Value::Null, |(n, end)| json!({ "seq": n, "endHlc": end }));
    json!({
        "deviceId": dev.id, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": SV, "epoch": dev.epoch, "stateSeq": dev.seq + 1,
        "head": { "epoch": dev.epoch, "segment": dev.head.0, "record": dev.head.1, "hlc": dev.head.2, "stateSeq": dev.seq + 1 },
        "acks": dev.acks, "snapshot": snapshot, "purgeHorizon": null, "lastSyncHlc": hlc(dev.d.clock.now() + dev.seq, dev.id), "forgotten": dev.forgotten, "reset": reset
    })
}

impl Net {
    /// A (premier appareil, époque 1 et instantané), puis les autres associés avec la même clé ; chacun publie, puis tous se lisent.
    fn new(ids: &[&'static str]) -> Self {
        let fs = MemFs::new();
        let backend = FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone());
        let (a, stop) = with_stop(backend);
        a.setup(DEV_A);
        let first = epoch(1, DEV_A);
        let mut devs = vec![Dev { id: DEV_A, d: a, stop, seq: 0, epoch: first.clone(), head: (0, 0, None), snap: None, acks: json!({}), forgotten: json!([]), written: 0 }];
        for id in ids {
            let (d, stop) = with_stop(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()));
            d.vault.set(SYNC_KEY_ACCOUNT, &devs[0].d.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
            d.core.choose_folder(Path::new(FOLDER)).unwrap();
            d.core.bind_device(id).unwrap();
            devs.push(Dev { id, d, stop, seq: 0, epoch: first.clone(), head: (0, 0, None), snap: None, acks: json!({}), forgotten: json!([]), written: 0 });
        }
        let mut net = Self { fs, devs };
        net.snapshot(DEV_A).unwrap();
        for id in net.ids() {
            net.publish(id, Value::Null).unwrap();
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

    fn core(&self, id: &str) -> &circletasks_lib::sync::service::SyncCore {
        &self.dev(id).d.core
    }

    fn publish(&mut self, id: &str, reset: Value) -> Result<(), SyncError> {
        let dev = self.dev(id);
        dev.d.core.write_state(SV, state_json(dev, reset))?;
        self.dev_mut(id).seq += 1;
        Ok(())
    }

    /// `id` ajoute un enregistrement dans son époque courante (segment 1).
    fn write(&mut self, id: &str) -> Result<(), SyncError> {
        let dev = self.dev(id);
        let segment = dev.head.0.max(1);
        let expect = if dev.head.0 == 0 { 0 } else { dev.head.1 };
        let n = dev.written + 1;
        let max_hlc = hlc(2_000_000 + n * 10, id);
        dev.d.core.append_journal(&AppendRequest { epoch: dev.epoch.clone(), segment, expect_records: expect, sv: SV, max_hlc: max_hlc.clone(), records: vec![format!("{{\"n\":{n}}}")] })?;
        let dev = self.dev_mut(id);
        dev.head = (segment, expect + 1, Some(max_hlc));
        dev.written = n;
        Ok(())
    }

    fn snapshot(&mut self, id: &str) -> Result<(), SyncError> {
        let dev = self.dev(id);
        let n = dev.snap.as_ref().map_or(1, |(n, _)| n + 1);
        let covers = dev.acks.clone();
        let handle = dev.d.core.snapshot_begin(&dev.epoch, n, SV)?;
        dev.d.core.snapshot_append(handle, &[snap_end(&covers, &dev.epoch)])?;
        dev.d.core.snapshot_commit(handle)?;
        let id_owned = dev.id;
        self.dev_mut(id).snap = Some((n, hlc(5_000_000 + n, id_owned)));
        Ok(())
    }

    /// `id` lit le dossier : accusés posés sur la tête de chaque autre appareil de la même époque (état authentifié).
    fn read_all(&mut self, id: &str) -> Result<FolderScanOut, SyncError> {
        let scan = self.core(id).scan(&[])?;
        let ep = self.dev(id).epoch.clone();
        let mut acks = serde_json::Map::new();
        for device in &scan.devices {
            if device.device_id == id || device.state_status != "ok" {
                continue;
            }
            let Some(state) = &device.state else { continue };
            if state.epoch != ep {
                continue;
            }
            acks.insert(device.device_id.clone(), json!({ "epoch": ep, "segment": state.head.segment, "record": state.head.record, "hlc": state.head.hlc, "stateSeq": state.state_seq }));
        }
        let forgotten = serde_json::to_value(&scan.forgotten.entries).unwrap();
        let dev = self.dev_mut(id);
        dev.acks = Value::Object(acks);
        dev.forgotten = forgotten;
        Ok(FolderScanOut { reset: scan.reset.clone(), states: scan.devices.iter().map(|d| (d.device_id.clone(), (d.state_status, d.kid.clone(), d.state.as_ref().map(|s| (s.epoch.clone(), s.reset.is_some()))))).collect() })
    }

    /// Un cycle : lecture, puis état republié.
    fn cycle(&mut self, id: &str) -> Result<FolderScanOut, SyncError> {
        let out = self.read_all(id)?;
        self.publish(id, Value::Null)?;
        Ok(out)
    }

    /// `id` lance la réinitialisation, l'annonce sous l'ancienne clé, puis ouvre l'époque visée sous la nouvelle (instantané, état).
    fn reset_and_open(&mut self, id: &str) -> String {
        self.cycle(id).unwrap();
        let kid = self.core(id).reset_key(1).expect("réinitialisation");
        self.announce_and_open(id, &kid);
        kid
    }

    fn announce_and_open(&mut self, id: &str, kid: &str) -> String {
        let view = self.read_all(id).unwrap().reset.expect("vue de la réinitialisation");
        assert_eq!(view.kid, kid);
        assert_eq!(view.stage, "created");
        let notice = serde_json::to_value(view.notice.clone().expect("annonce fixée par Rust")).unwrap();
        self.publish(id, notice).expect("annonce sous l'ancienne clé");
        let target = view.epoch.clone();
        let dev = self.dev_mut(id);
        dev.epoch = target.clone();
        dev.head = (0, 0, None);
        dev.snap = None;
        self.snapshot(id).expect("instantané d'ouverture sous la nouvelle clé");
        let dev = self.dev_mut(id);
        dev.acks = json!({});
        self.publish(id, Value::Null).expect("état sous la nouvelle clé");
        target
    }

    /// `id` importe la nouvelle clé de `from` (clé de secours de la fenêtre `pairing` de `from`), puis rejoint l'époque visée : ajout et
    /// état sous la nouvelle clé (`state.next.ctx`).
    fn join(&mut self, id: &str, from: &str) -> String {
        let payload = self.core(from).pairing_payload(u64::MAX >> 12).unwrap();
        let recovery = Zeroizing::new(payload.recovery_key.clone());
        let result = self.core(id).key_import(KeyInput::RecoveryKey(recovery), 1).expect("import de la nouvelle clé");
        let target = result.epoch.clone().expect("époque visée");
        let dev = self.dev_mut(id);
        dev.epoch = target.clone();
        dev.head = (0, 0, None);
        dev.snap = None;
        dev.acks = json!({});
        self.write(id).unwrap();
        self.publish(id, Value::Null).unwrap();
        target
    }

    fn vault_kid(&self, id: &str, account: &str) -> Option<String> {
        self.dev(id).d.vault.get(account).unwrap().map(|v| MasterKey::from_vault_value(&v).unwrap().kid().to_owned())
    }

    fn key_of(&self, id: &str, account: &str) -> MasterKey {
        MasterKey::from_vault_value(&self.dev(id).d.vault.get(account).unwrap().expect("clé")).unwrap()
    }

    fn files_of(&self, dev: &str) -> Vec<String> {
        let prefix = format!("devices/{dev}/");
        self.fs.names().into_iter().filter(|n| n.starts_with(&prefix)).collect()
    }

    fn reset_file(&self, id: &str) -> Option<Value> {
        std::fs::read(self.dev(id).d.base.path().join("sync").join(RESET_FILE)).ok().map(|b| serde_json::from_slice(&b).unwrap())
    }

    fn own_json(&self, id: &str) -> Value {
        serde_json::from_slice(&std::fs::read(self.dev(id).d.base.path().join("sync").join("own.json")).unwrap()).unwrap()
    }
}

/// Ce que retient le test d'un scan : vue de la réinitialisation, statut, `kid` et (époque, annonce) par appareil.
type DeviceSeen = (&'static str, Option<String>, Option<(String, bool)>);
struct FolderScanOut {
    reset: Option<ResetView>,
    states: BTreeMap<String, DeviceSeen>,
}

/// Kid d'en-tête d'un fichier (ligne 1).
fn header_kid(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|&b| b == b'\n')?;
    serde_json::from_slice::<Value>(&bytes[..end]).ok()?["kid"].as_str().map(str::to_owned)
}

// ------------------------------------------------------------------------------------------------------------------------------
// Action et précondition (critères 2, 3, 4)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn reset_key_refusals_before_any_dialog_and_nothing_created() {
    let (d, _) = device();
    assert_eq!(code(d.core.reset_key(1)), SyncCode::NotConfigured);
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!(code(d.core.reset_key(1)), SyncCode::KeyMissing);
    d.core.key_create().unwrap();
    assert_eq!(code(d.core.reset_key(1)), SyncCode::NotBound);
    assert_eq!(d.ui.prompts(), 0, "aucune boîte pour un refus");

    // Précondition : la tête de B dépasse l'accusé de A (B a écrit après la dernière lecture de A) : « Synchronisez d'abord ».
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_A).unwrap();
    net.write(DEV_B).unwrap();
    net.publish(DEV_B, Value::Null).unwrap();
    let a = &net.dev(DEV_A).d;
    assert_eq!(code(a.core.reset_key(1)), SyncCode::StateMismatch);
    assert_eq!(a.ui.prompts(), 0, "refus avant la boîte");
    assert!(!a.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), "aucune clé .next");
    assert!(net.reset_file(DEV_A).is_none(), "aucun registre");
    // A lit B jusqu'à sa tête : la réinitialisation passe.
    net.cycle(DEV_A).unwrap();
    assert!(net.core(DEV_A).reset_key(1).is_ok());
    assert_eq!(net.dev(DEV_A).d.ui.prompts(), 1);
}

#[test]
fn reset_key_dialog_refused_or_background_or_rate_limited_creates_nothing() {
    let mut net = Net::new(&[]);
    net.cycle(DEV_A).unwrap();
    let a = &net.dev(DEV_A).d;
    a.ui.ready(false);
    assert_eq!(code(a.core.reset_key(1)), SyncCode::NotForeground);
    assert_eq!(a.ui.prompts(), 0, "aucune boîte en arrière-plan");
    a.ui.ready(true);
    a.ui.answer(false);
    assert_eq!(code(a.core.reset_key(1)), SyncCode::ConsentDenied);
    assert_eq!(a.ui.prompts(), 1);
    let spec = a.ui.last.lock().unwrap().clone().expect("boîte");
    assert_eq!(spec.default_button, circletasks_lib::sync::consent::IDCANCEL, "« Annuler » par défaut");
    assert!(spec.texts.instruction.contains("Réinitialiser"), "texte natif de native/fr.json");
    assert!(!a.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), "refus : rien n'est créé");
    assert!(net.reset_file(DEV_A).is_none());
    // Après un refus : 10 minutes de blocage persistant.
    a.ui.answer(true);
    assert_eq!(code(a.core.reset_key(1)), SyncCode::RateLimited);
}

#[test]
fn reset_key_creates_k2_under_next_returns_only_its_kid_and_resumes_without_a_new_key() {
    let mut net = Net::new(&[]);
    net.cycle(DEV_A).unwrap();
    let k = net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).unwrap();
    let kid = net.core(DEV_A).reset_key(1).unwrap();
    assert_ne!(kid, k);
    assert_eq!(net.vault_kid(DEV_A, SYNC_NEXT_KEY_ACCOUNT).as_deref(), Some(kid.as_str()), "K2 sous .next");
    assert_eq!(net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).as_deref(), Some(k.as_str()), ".v1 intacte avant la bascule");
    assert!(kid.len() == 16 && kid.bytes().all(|b| b.is_ascii_hexdigit()), "seul le kid est rendu");
    assert_eq!(net.core(DEV_A).key_status().unwrap().next_kid.as_deref(), Some(kid.as_str()));
    let record = net.reset_file(DEV_A).unwrap();
    assert_eq!(record["role"], "initiator");
    assert_eq!(record["stage"], "created");
    assert_eq!(record["epoch"], epoch(2, DEV_A));
    // Reprise : même K2, aucune nouvelle boîte.
    let prompts = net.dev(DEV_A).d.ui.prompts();
    assert_eq!(net.core(DEV_A).reset_key(1).unwrap(), kid);
    assert_eq!(net.dev(DEV_A).d.ui.prompts(), prompts);
    // Budget de nonces de la nouvelle clé : repart de zéro.
    let usage: Value = serde_json::from_slice(&std::fs::read(net.dev(DEV_A).d.base.path().join("sync").join("usage.next.json")).unwrap()).unwrap();
    assert_eq!(usage, json!({ "kid": kid, "sealed": 0 }));
}

#[test]
fn an_orphan_next_key_left_by_a_crash_is_adopted_never_replaced() {
    let mut net = Net::new(&[]);
    net.cycle(DEV_A).unwrap();
    let orphan = MasterKey::generate().unwrap();
    net.dev(DEV_A).d.vault.set(SYNC_NEXT_KEY_ACCOUNT, &orphan.to_vault_value()).unwrap();
    assert_eq!(net.core(DEV_A).reset_key(1).unwrap(), orphan.kid());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Annonce maîtresse et époque n+1 (critères 5, 6)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn announcement_is_mastered_by_rust_and_no_k2_data_precedes_it() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_A).unwrap();
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_A).unwrap();
    let kid = net.core(DEV_A).reset_key(1).unwrap();
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    let notice = serde_json::to_value(view.notice.clone().unwrap()).unwrap();
    // Sous l'ancienne clé : annonce absente, d'un autre kid ou d'une autre époque : refusée.
    assert_eq!(code(net.publish(DEV_A, Value::Null)), SyncCode::StateMismatch);
    let mut forged = notice.clone();
    forged["kid"] = json!("0000000000000000");
    assert_eq!(code(net.publish(DEV_A, forged)), SyncCode::StateMismatch);
    // Aucune donnée de l'époque visée avant l'annonce.
    let target = view.epoch.clone();
    let early = {
        let dev = net.dev_mut(DEV_A);
        let saved = (dev.epoch.clone(), dev.head.clone());
        dev.epoch = target.clone();
        dev.head = (0, 0, None);
        let r = net.publish(DEV_A, Value::Null);
        let dev = net.dev_mut(DEV_A);
        dev.epoch = saved.0;
        dev.head = saved.1;
        r
    };
    assert_eq!(code(early), SyncCode::StateMismatch, "état de l'époque visée avant l'annonce : refusé");
    // Annonce exacte : acceptée ; B la lit dans le state.ctx de A, déchiffré avec la clé locale.
    net.publish(DEV_A, notice.clone()).unwrap();
    assert_eq!(net.reset_file(DEV_A).unwrap()["stage"], "announced");
    let seen = net.read_all(DEV_B).unwrap();
    assert_eq!(seen.states[DEV_A].0, "ok");
    assert_eq!(seen.states[DEV_A].2, Some((epoch(1, DEV_A), true)), "annonce authentifiée par K");
    // L'ancienne époque est figée dès l'annonce.
    assert_eq!(code(net.write(DEV_A)), SyncCode::StateMismatch);
    // Sous la nouvelle clé : `reset` toujours nul.
    let dev = net.dev_mut(DEV_A);
    dev.epoch = target.clone();
    dev.head = (0, 0, None);
    dev.acks = json!({});
    net.snapshot(DEV_A).unwrap();
    assert_eq!(code(net.publish(DEV_A, notice)), SyncCode::StateMismatch);
    net.publish(DEV_A, Value::Null).unwrap();
    assert_eq!(net.reset_file(DEV_A).unwrap()["stage"], "opened");
    let next = net.fs.get(&["devices", DEV_A, "state.next.ctx"]).expect("état K2 publié dans state.next.ctx");
    assert_eq!(header_kid(&next).as_deref(), Some(kid.as_str()));
    assert_ne!(header_kid(&net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap()).as_deref(), Some(kid.as_str()), "state.ctx reste sous K");
}

#[test]
fn files_of_the_new_epoch_never_open_with_k_and_no_key_byte_is_in_the_folder() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    let k = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    let kid = net.reset_and_open(DEV_A);
    net.write(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    let k2 = net.key_of(DEV_A, SYNC_NEXT_KEY_ACCOUNT);
    assert_eq!(k2.kid(), kid);
    let target = epoch(2, DEV_A);
    let mut k2_files = 0;
    for (path, bytes) in net.fs.all_files() {
        let parts: Vec<&str> = path.split('/').collect();
        let file_kid = header_kid(&bytes).unwrap_or_default();
        if file_kid == kid {
            k2_files += 1;
            // Aucune ligne d'un fichier K2 ne s'ouvre avec K, à sa place.
            let lines: Vec<&[u8]> = bytes.split(|&b| b == b'\n').skip(1).filter(|l| !l.is_empty()).collect();
            for (i, line) in lines.iter().enumerate() {
                let line = std::str::from_utf8(line).unwrap();
                let place = match parts.last() {
                    Some(&"state.next.ctx") | Some(&"state.ctx") => {
                        let h: Value = serde_json::from_slice(&bytes[..bytes.iter().position(|&b| b == b'\n').unwrap()]).unwrap();
                        Place::State { dev: parts[1], epoch: Box::leak(h["e"].as_str().unwrap().to_owned().into_boxed_str()), state_seq: h["n"].as_u64().unwrap() }
                    }
                    Some(name) if name.starts_with("s-") => Place::Snapshot { dev: parts[1], epoch: parts[2], seq: name[2..10].parse().unwrap(), index: i as u64 },
                    Some(name) => Place::Journal { dev: parts[1], epoch: parts[2], segment: name[2..10].parse().unwrap(), index: i as u64 },
                    None => unreachable!(),
                };
                assert!(k.open(&place, line).is_err(), "{path} : illisible avec K");
                assert!(k2.open(&place, line).is_ok(), "{path} : lisible avec K2");
            }
            assert!(path.contains(&target) || path.ends_with("state.next.ctx"), "{path} : seuls l'époque visée et state.next.ctx sont sous K2");
        }
    }
    assert!(k2_files >= 3, "état, instantané et segment sous K2");
    // Aucun octet d'une clé (brut, base64, base64url, clé de secours) dans le dossier.
    let needles = |key: &MasterKey| -> Vec<Vec<u8>> {
        let raw = STANDARD.decode(key.to_vault_value().as_str()).unwrap();
        vec![raw.clone(), STANDARD.encode(&raw).into_bytes(), URL_SAFE_NO_PAD.encode(&raw).into_bytes(), key.recovery_key().as_bytes().to_vec()]
    };
    for (path, bytes) in net.fs.all_files() {
        for needle in needles(&k).into_iter().chain(needles(&k2)) {
            assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_slice()), "{path} contient une clé");
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Nouvelle clé de secours (critère 7, D1) ; appareil seul (critère 14)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn pairing_payload_carries_k2_and_the_new_epoch_during_the_transition() {
    let mut net = Net::new(&[]);
    let old = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    net.cycle(DEV_A).unwrap();
    let kid = net.core(DEV_A).reset_key(1).unwrap();
    let payload = net.core(DEV_A).pairing_payload(u64::MAX >> 12).unwrap();
    let qr = parse_qr_text(&payload.qr_text).expect("QR");
    assert_eq!(qr.key.kid(), kid, "le QR porte K2");
    assert_eq!(qr.epoch.as_deref(), Some(epoch(2, DEV_A).as_str()), "e = n+1");
    assert_eq!(qr.device_id, DEV_A, "d = A");
    assert_ne!(payload.recovery_key.as_str(), old.recovery_key().as_str(), "jamais l'ancienne clé de secours");
    assert_eq!(payload.recovery_key.as_str(), net.key_of(DEV_A, SYNC_NEXT_KEY_ACCOUNT).recovery_key().as_str());
}

#[test]
fn single_device_switches_at_the_first_scan_and_the_old_recovery_key_imports_nothing() {
    let mut net = Net::new(&[]);
    net.write(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    let old = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    let kid = net.reset_and_open(DEV_A);
    let out = net.read_all(DEV_A).unwrap();
    let view = out.reset.expect("vue");
    assert!(view.switched && !view.resumed, "bascule au premier scan, sans liste");
    assert!(view.waiting.is_empty());
    assert_eq!(net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).as_deref(), Some(kid.as_str()), "K2 sous .v1");
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), ".next effacée");
    assert!(net.reset_file(DEV_A).is_none(), "registre supprimé");
    assert_eq!(net.core(DEV_A).key_status().unwrap().next_kid, None);
    let files = net.files_of(DEV_A);
    assert!(!files.iter().any(|f| f.contains(&epoch(1, DEV_A))), "ancienne époque supprimée : {files:?}");
    assert!(!files.iter().any(|f| f.ends_with("state.next.ctx")));
    assert_eq!(header_kid(&net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap()).as_deref(), Some(kid.as_str()));
    assert_eq!(net.own_json(DEV_A)["kid"], kid, "own.json passé à la nouvelle clé");
    // L'état suivant (écrit par le moteur) va dans state.ctx, sous K2.
    net.publish(DEV_A, Value::Null).unwrap();
    assert!(net.fs.get(&["devices", DEV_A, "state.next.ctx"]).is_none());
    // Ancienne clé de secours : rien ne porte plus son kid.
    let before = net.dev(DEV_A).d.vault.get(SYNC_KEY_ACCOUNT).unwrap();
    assert_eq!(code(net.core(DEV_A).key_import(KeyInput::RecoveryKey(old.recovery_key()), 1)), SyncCode::KeyMismatch);
    assert_eq!(net.dev(DEV_A).d.vault.get(SYNC_KEY_ACCOUNT).unwrap(), before, "rien n'est enregistré");
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
    // Nouvelle clé de secours : acceptée (même clé, sans effet).
    let new = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    assert!(net.core(DEV_A).key_import(KeyInput::RecoveryKey(new.recovery_key()), 1).is_ok());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Autres appareils, réassociation, bascule (critères 8 à 12, 16)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn three_devices_reassociate_then_everyone_switches_and_k_reads_nothing_written_after() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    let k = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    let kid = net.reset_and_open(DEV_A);
    let target = epoch(2, DEV_A);
    // B lit l'annonce authentifiée ; la fenêtre « Associer l'iPhone » refuse de donner l'ancienne clé.
    let seen = net.read_all(DEV_B).unwrap();
    assert_eq!(seen.states[DEV_A].2, Some((epoch(1, DEV_A), true)));
    assert_eq!(code(net.core(DEV_B).pairing_preconditions(true)), SyncCode::StateMismatch, "B ne donne plus K");
    // A attend B et C.
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    assert!(!view.switched);
    assert_eq!(view.waiting, vec![DEV_B.to_owned(), DEV_C.to_owned()]);
    // B se réassocie : K2 sous .next, .v1 (K) intacte, état K2 dans state.next.ctx.
    assert_eq!(net.join(DEV_B, DEV_A), target);
    assert_eq!(net.vault_kid(DEV_B, SYNC_NEXT_KEY_ACCOUNT).as_deref(), Some(kid.as_str()));
    assert_eq!(net.vault_kid(DEV_B, SYNC_KEY_ACCOUNT).as_deref(), Some(k.kid()));
    assert_eq!(net.reset_file(DEV_B).unwrap()["role"], "joined");
    assert!(net.fs.get(&["devices", DEV_B, "state.next.ctx"]).is_some());
    assert_eq!(net.dev(DEV_B).d.ui.last.lock().unwrap().as_ref().unwrap().texts.instruction, "Remplacer la clé de synchronisation de cet appareil ?", "confirmation de remplacement de Y-08");
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    assert_eq!(view.waiting, vec![DEV_C.to_owned()], "B réassocié");
    // B ne bascule pas avant A.
    assert!(!net.read_all(DEV_B).unwrap().reset.unwrap().switched);
    // C se réassocie avec la clé de secours de B (même K2).
    net.join(DEV_C, DEV_B);
    // A bascule ; puis B et C, qui lisent le state.ctx de A sous K2.
    assert!(net.read_all(DEV_A).unwrap().reset.unwrap().switched);
    net.publish(DEV_A, Value::Null).unwrap();
    for id in [DEV_B, DEV_C] {
        let view = net.read_all(id).unwrap().reset.expect("vue");
        assert!(view.switched, "{id} bascule après le gagnant");
        assert_eq!(net.vault_kid(id, SYNC_KEY_ACCOUNT).as_deref(), Some(kid.as_str()));
        assert!(!net.dev(id).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
        net.publish(id, Value::Null).unwrap();
    }
    // Plus aucun fichier sous K dans le dossier ; K ne lit rien de ce qui est écrit après.
    for (path, bytes) in net.fs.all_files() {
        assert_eq!(header_kid(&bytes).as_deref(), Some(kid.as_str()), "{path} : seulement la nouvelle clé");
    }
    let state = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    let h: Value = serde_json::from_slice(&state[..state.iter().position(|&b| b == b'\n').unwrap()]).unwrap();
    let line = std::str::from_utf8(&state[state.iter().position(|&b| b == b'\n').unwrap() + 1..state.len() - 1]).unwrap();
    let place = Place::State { dev: DEV_A, epoch: h["e"].as_str().unwrap(), state_seq: h["n"].as_u64().unwrap() };
    assert!(k.open(&place, line).is_err(), "K ne déchiffre pas le nouvel état");
    // Un détenteur de K seul ne forge rien de lisible : un état K déposé dans le dossier de A serait étranger pour tous (clé différente).
    let scan = net.core(DEV_B).scan(&[]).unwrap();
    assert!(scan.devices.iter().all(|d| d.state_status == "ok"), "tous lisibles sous K2");
}

#[test]
fn a_device_not_yet_reassociated_is_only_forgotten_by_an_explicit_choice() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    let kid = net.reset_and_open(DEV_A);
    // Aucun délai ne fait oublier B : la bascule attend (30, 90, 400 jours).
    for days in [30u64, 60, 310] {
        net.dev(DEV_A).d.clock.advance(days * 86_400_000);
        let view = net.read_all(DEV_A).unwrap().reset.unwrap();
        assert_eq!(view.waiting, vec![DEV_B.to_owned()]);
        assert!(!view.switched);
        net.publish(DEV_A, Value::Null).unwrap();
    }
    // B, qui a lu l'annonce, ne peut pas réinitialiser de son côté ; oublier A (auteur de l'annonce) passe par la boîte (§18 point 14),
    // refusée ici.
    net.read_all(DEV_B).unwrap();
    net.dev(DEV_B).d.ui.answer(false);
    assert_eq!(code(net.core(DEV_B).device_forget(DEV_A, 1)), SyncCode::ConsentDenied);
    net.dev(DEV_B).d.ui.answer(true);
    assert_eq!(code(net.core(DEV_B).reset_key(1)), SyncCode::StateMismatch);
    // A oublie B par un choix explicite (boîte native de Y-10), publie la déclaration sous K2, puis bascule.
    net.core(DEV_A).device_forget(DEV_B, 1).expect("oubli autorisé à l'appareil qui réinitialise");
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    assert!(view.switched, "B oublié : plus aucun appareil attendu");
    net.publish(DEV_A, Value::Null).expect("déclaration publiée sous la nouvelle clé");
    assert_eq!(net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).as_deref(), Some(kid.as_str()));
}

#[test]
fn a_foreign_state_with_a_forged_notice_or_an_unknown_announcer_suspends_nothing() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_A).unwrap();
    // Faux state.ctx d'un appareil inconnu, sous une clé inconnue, avec une annonce forgée.
    let stranger = MasterKey::generate().unwrap();
    let ghost = "abababab-abab-4bab-8bab-abababababab";
    let ep = epoch(1, DEV_A);
    let notice = json!({ "kid": stranger.kid(), "epoch": epoch(9, ghost), "at": hlc(9, ghost) });
    let state = json!({
        "deviceId": ghost, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": SV, "epoch": ep, "stateSeq": 1,
        "head": { "epoch": ep, "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 }, "acks": {}, "snapshot": null, "purgeHorizon": null,
        "lastSyncHlc": hlc(9, ghost), "forgotten": [], "reset": notice
    })
    .to_string();
    let place = Place::State { dev: ghost, epoch: &ep, state_seq: 1 };
    let line = stranger.seal(&place, state.as_bytes(), 1, SV as u32).unwrap();
    let header = json!({ "f": "ct-state", "sm": 1, "kid": stranger.kid(), "dev": ghost, "e": ep, "n": 1 }).to_string();
    net.fs.put(&["devices", ghost, "state.ctx"], format!("{header}\n{line}\n").as_bytes());
    let out = net.read_all(DEV_A).unwrap();
    assert_eq!(out.states[ghost].0, "foreign", "seulement « Clé différente »");
    // Rien n'est suspendu : A peut toujours réinitialiser et donner sa clé.
    assert!(net.core(DEV_A).pairing_preconditions(true).is_ok());
    assert!(net.core(DEV_A).reset_key(1).is_ok());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Bascule interrompue (critère 12)
// ------------------------------------------------------------------------------------------------------------------------------

fn final_shape(net: &Net) -> (Option<String>, bool, Vec<String>, Option<Value>) {
    (net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT), net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), net.files_of(DEV_A), net.reset_file(DEV_A))
}

#[test]
fn a_switch_interrupted_before_each_of_its_writes_is_resumed_at_restart_with_the_same_outcome() {
    let reference = {
        let mut net = Net::new(&[]);
        net.reset_and_open(DEV_A);
        net.read_all(DEV_A).unwrap();
        final_shape(&net)
    };
    assert!(reference.0.is_some() && !reference.1 && reference.3.is_none());
    for step in 1..=6 {
        let mut net = Net::new(&[]);
        let kid = net.reset_and_open(DEV_A);
        net.dev(DEV_A).stop.at(&format!("switch-{step}"));
        assert_eq!(code(net.read_all(DEV_A)), SyncCode::Io, "arrêt avant l'étape {step}");
        // À aucun instant sans clé valide : .v1 est K ou K2, jamais absente.
        let v1 = net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).expect("clé valide");
        assert!(v1 == kid || step <= 4, "étape {step}");
        // Redémarrage : nouveau service, même configuration ; le scan reprend la bascule et le dit.
        net.dev_mut(DEV_A).d.restart();
        let view = net.read_all(DEV_A).unwrap().reset.expect("vue");
        assert!(view.switched, "étape {step} : bascule terminée");
        assert_eq!(view.resumed, step > 1, "étape {step} : reprise signalée");
        let shape = final_shape(&net);
        assert_eq!(shape.0.as_deref(), Some(kid.as_str()));
        assert_eq!((shape.1, shape.3.is_none()), (reference.1, true), "étape {step}");
        assert_eq!(shape.2.len(), reference.2.len(), "étape {step} : mêmes fichiers");
        net.publish(DEV_A, Value::Null).unwrap();
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Deux réinitialisations simultanées (critère 15, §18 point 2)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn concurrent_resets_the_greater_epoch_wins_and_the_loser_steps_back_without_any_keyless_instant() {
    for interrupted in [None, Some("supersede-2"), Some("supersede-3"), Some("supersede-4")] {
        let mut net = Net::new(&[DEV_W, DEV_C]);
        for id in [DEV_W, DEV_C, DEV_A] {
            net.cycle(id).unwrap();
        }
        // A et W réinitialisent ensemble depuis l'époque 1.
        let kid_a = net.core(DEV_A).reset_key(1).unwrap();
        let kid_w = net.core(DEV_W).reset_key(1).unwrap();
        net.announce_and_open(DEV_A, &kid_a);
        net.announce_and_open(DEV_W, &kid_w);
        // C importe K2a (celle de A) avant d'apprendre la perte.
        net.join(DEV_C, DEV_A);
        let base_seq = net.own_json(DEV_A)["stateSeq"].clone();
        // A constate la perte au scan : W (UUID plus grand) l'emporte.
        if let Some(step) = interrupted {
            net.dev(DEV_A).stop.at(step);
            assert_eq!(code(net.read_all(DEV_A)), SyncCode::Io, "{step}");
            assert_eq!(net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT).as_deref(), Some(net.key_of(DEV_W, SYNC_KEY_ACCOUNT).kid()), "{step} : K reste sous .v1");
            net.dev_mut(DEV_A).d.restart();
        }
        let view = net.read_all(DEV_A).unwrap().reset.expect("vue");
        let lost = view.superseded.expect("perte constatée");
        assert_eq!(lost.epoch.as_deref(), Some(epoch(2, DEV_W).as_str()));
        assert_eq!(lost.by.as_deref(), Some(DEV_W));
        let record = net.reset_file(DEV_A).unwrap();
        assert_eq!(record["superseded"]["done"], true, "étapes (1) à (4)");
        assert!(net.fs.get(&["devices", DEV_A, "state.next.ctx"]).is_none(), "(2) state.next.ctx supprimé");
        assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), "(3) .next effacée");
        assert_eq!(net.core(DEV_A).key_status().unwrap().next_kid, None);
        let own = net.own_json(DEV_A);
        assert_eq!(own["epoch"], epoch(1, DEV_A), "(4) own.json ramené à l'époque n");
        assert!(own["stateSeq"].as_u64() >= base_seq.as_u64(), "stateSeq garde son maximum");
        // Son état sous K redevient son état publié (jamais vu comme un rejeu), même après un redémarrage.
        net.dev_mut(DEV_A).d.restart();
        assert_eq!(net.read_all(DEV_A).unwrap().states[DEV_A].0, "ok", "anti-rejeu de soi revenu à son état sous K");
        // Le perdant republie une fois son état sous K, sans annonce ; ni nouvelle réinitialisation ni clé donnée.
        let dev = net.dev_mut(DEV_A);
        dev.epoch = epoch(1, DEV_A);
        dev.head = (0, 0, None);
        dev.snap = Some((1, hlc(5_000_001, DEV_A)));
        dev.seq = own["stateSeq"].as_u64().unwrap();
        net.publish(DEV_A, Value::Null).expect("republication sous K avec reset nul");
        assert_eq!(code(net.core(DEV_A).reset_key(1)), SyncCode::StateMismatch);
        assert_eq!(code(net.core(DEV_A).pairing_preconditions(true)), SyncCode::StateMismatch);
        // C (réassocié à la perdante) l'apprend aussi : .next effacée, K toujours sous .v1.
        let view = net.read_all(DEV_C).unwrap().reset.expect("vue de C");
        assert!(view.superseded.is_some());
        assert!(!net.dev(DEV_C).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
        // W, le gagnant, attend A et C ; puis tous se réassocient avec K2w et basculent.
        let waiting = net.read_all(DEV_W).unwrap().reset.unwrap().waiting;
        assert_eq!(waiting, vec![DEV_A.to_owned(), DEV_C.to_owned()]);
        net.join(DEV_A, DEV_W);
        net.join(DEV_C, DEV_W);
        assert_eq!(net.reset_file(DEV_A).unwrap()["role"], "joined");
        assert!(net.read_all(DEV_W).unwrap().reset.unwrap().switched);
        net.publish(DEV_W, Value::Null).unwrap();
        for id in [DEV_A, DEV_C] {
            assert!(net.read_all(id).unwrap().reset.unwrap().switched, "{id}");
            assert_eq!(net.vault_kid(id, SYNC_KEY_ACCOUNT).as_deref(), Some(kid_w.as_str()));
        }
        // L'époque perdante de A (sous K2a) a disparu avec ses anciens fichiers.
        assert!(!net.files_of(DEV_A).iter().any(|f| f.contains(&epoch(2, DEV_A))));
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Journal technique (critère 20)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn a_complete_reset_logs_no_key_no_recovery_key_and_no_qr_text() {
    let capture = log::capture();
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    let old = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    net.reset_and_open(DEV_A);
    let payload = net.core(DEV_A).pairing_payload(u64::MAX >> 12).unwrap();
    net.join(DEV_B, DEV_A);
    net.read_all(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    net.read_all(DEV_B).unwrap();
    let lines = capture.lines();
    assert!(lines.iter().any(|l| l.contains("reset-switched")));
    let keys = [old, net.key_of(DEV_A, SYNC_KEY_ACCOUNT)];
    for line in &lines {
        for key in &keys {
            let raw = STANDARD.decode(key.to_vault_value().as_str()).unwrap();
            assert!(!line.contains(key.to_vault_value().as_str()) && !line.contains(&URL_SAFE_NO_PAD.encode(&raw)), "{line}");
            assert!(!line.contains(key.recovery_key().as_str()), "{line}");
        }
        assert!(!line.contains(payload.qr_text.as_str()) && !line.contains(payload.recovery_key.as_str()), "{line}");
        assert!(!line.contains(r"C:\"), "aucun chemin : {line}");
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Ce que Y-11 coupe (critère 16)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn the_old_key_still_opens_old_files_but_reads_and_forges_nothing_written_after() {
    let mut net = Net::new(&[DEV_B]);
    net.write(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_A).unwrap();
    let k = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    let old_epoch = epoch(1, DEV_A);
    // Fichier écrit avant : encore lisible avec K tant qu'il existe (copie d'un appareil perdu, « Supprimés récemment »).
    let old_segment = net.fs.get(&["devices", DEV_A, &old_epoch, "j-00000001.ctj"]).expect("segment de l'époque 1");
    let line = std::str::from_utf8(old_segment.split(|&b| b == b'\n').nth(1).unwrap()).unwrap();
    assert!(k.open(&Place::Journal { dev: DEV_A, epoch: &old_epoch, segment: 1, index: 0 }, line).is_ok(), "ancien fichier lisible avec K");
    // Réinitialisation complète (B réassocié, tous basculent), puis A écrit dans la nouvelle époque.
    let kid = net.reset_and_open(DEV_A);
    net.join(DEV_B, DEV_A);
    net.read_all(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    net.read_all(DEV_B).unwrap();
    net.publish(DEV_B, Value::Null).unwrap();
    net.write(DEV_A).unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    let new_epoch = epoch(2, DEV_A);
    let segment = net.fs.get(&["devices", DEV_A, &new_epoch, "j-00000001.ctj"]).expect("segment de l'époque 2");
    assert_eq!(header_kid(&segment).as_deref(), Some(kid.as_str()));
    let line = std::str::from_utf8(segment.split(|&b| b == b'\n').nth(1).unwrap()).unwrap();
    assert!(k.open(&Place::Journal { dev: DEV_A, epoch: &new_epoch, segment: 1, index: 0 }, line).is_err(), "K ne lit rien d'écrit après");
    // Un détenteur de K seul forge un segment et un état dans le dossier de A : ni lus, ni appliqués, aucune suspension.
    let forged_line = k.seal(&Place::Journal { dev: DEV_A, epoch: &new_epoch, segment: 1, index: 0 }, br#"{"forged":true}"#, 1, SV as u32).unwrap();
    let header = json!({ "f": "ct-j", "sm": 1, "kid": k.kid(), "dev": DEV_A, "e": new_epoch, "n": 1 }).to_string();
    net.fs.put(&["devices", DEV_A, &new_epoch, "j-00000001.ctj"], format!("{header}\n{forged_line}\n").as_bytes());
    let from = circletasks_lib::sync::store::RecordCursor { segment: 0, record: 0 };
    assert_eq!(code(net.core(DEV_B).read_journal(DEV_A, &new_epoch, from, None)), SyncCode::KeyMismatch, "segment forgé sous K refusé");
    let mut forged_state = state_json(net.dev(DEV_A), json!({ "kid": k.kid(), "epoch": epoch(3, DEV_A), "at": hlc(NOW_FORGE, DEV_A) }));
    forged_state["stateSeq"] = json!(9_999);
    forged_state["head"]["stateSeq"] = json!(9_999);
    let text = forged_state.to_string();
    let place = Place::State { dev: DEV_A, epoch: &new_epoch, state_seq: 9_999 };
    let sealed = k.seal(&place, text.as_bytes(), 1, SV as u32).unwrap();
    let header = json!({ "f": "ct-state", "sm": 1, "kid": k.kid(), "dev": DEV_A, "e": new_epoch, "n": 9_999 }).to_string();
    net.fs.put(&["devices", DEV_A, "state.ctx"], format!("{header}\n{sealed}\n").as_bytes());
    let seen = net.read_all(DEV_B).unwrap();
    assert_eq!(seen.states[DEV_A].0, "foreign", "état forgé sous K : clé différente, rien de lu");
    assert!(seen.reset.is_none(), "aucune suspension");
    assert_eq!(code(net.core(DEV_B).reset_key(1)), SyncCode::StateMismatch, "précondition : A illisible, jamais une annonce suivie");
}

const NOW_FORGE: u64 = 1_790_000_100_000;

// ------------------------------------------------------------------------------------------------------------------------------
// Revue, audit et décision de l'architecte (ADR 0011 §18 points 14 à 18)
// ------------------------------------------------------------------------------------------------------------------------------

/// UUID inférieur à celui de A (restauration perdante face à l'annonce de A).
const DEV_Z: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

impl Net {
    /// `id` ouvre une époque `e<n+1>-<id>` sous la clé locale (restauration « Appliquer partout ») : instantané, état.
    fn open_restore(&mut self, id: &str) -> Result<String, SyncError> {
        let n = circletasks_lib::sync::names::EpochId::parse(&self.dev(id).epoch).unwrap().n + 1;
        let target = epoch(n, id);
        let dev = self.dev_mut(id);
        dev.epoch = target.clone();
        dev.head = (0, 0, None);
        dev.snap = None;
        self.snapshot(id)?;
        self.dev_mut(id).acks = json!({});
        self.publish(id, Value::Null)?;
        Ok(target)
    }

    fn import_failure(&self, id: &str) -> Option<Value> {
        self.core(id).key_status().unwrap().import_failure.map(|f| serde_json::to_value(f).unwrap())
    }
}

#[test]
fn shared_table_restore_candidates() {
    let cases = table()["restoreCandidates"].as_array().unwrap().clone();
    assert!(cases.len() >= 2);
    for case in cases {
        let announcements: Vec<ResetCandidate> = case["announcements"].as_array().unwrap().iter().map(candidate_of).collect();
        let states: Vec<OpenedEpoch> = case["states"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| OpenedEpoch {
                by: s["by"].as_str().unwrap().to_owned(),
                epoch: s["epoch"].as_str().unwrap().to_owned(),
                snapshot: s["snapshot"].as_bool().unwrap(),
                notice: s["notice"].as_bool().unwrap(),
            })
            .collect();
        let got: Vec<ResetCandidate> = restore_candidates(&states, &announcements);
        let expected: Vec<ResetCandidate> = case["expected"].as_array().unwrap().iter().map(candidate_of).collect();
        assert_eq!(got, expected, "{}", case["name"]);
    }
}

#[test]
fn audit2_membership_comes_from_local_proofs_and_never_overwrites_v1() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_A).unwrap();
    let k = net.vault_kid(DEV_B, SYNC_KEY_ACCOUNT);
    net.reset_and_open(DEV_A);
    let k2 = net.vault_kid(DEV_A, SYNC_NEXT_KEY_ACCOUNT);
    // Le state.ctx de B a disparu du dossier : B reste membre (own.json, registre, déjà publié) et importe K2 sous .next.
    net.fs.remove(&["devices", DEV_B, "state.ctx"]);
    net.join(DEV_B, DEV_A);
    assert_eq!(net.vault_kid(DEV_B, SYNC_KEY_ACCOUNT), k, ".v1 reste K");
    assert_eq!(net.vault_kid(DEV_B, SYNC_NEXT_KEY_ACCOUNT), k2, "K2 sous .next");
    assert_eq!(net.reset_file(DEV_B).unwrap()["role"], "joined");
}

#[test]
fn audit2_own_state_in_the_cloud_is_cloud_pending_never_an_ordinary_import() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    net.cycle(DEV_A).unwrap();
    let k = net.vault_kid(DEV_B, SYNC_KEY_ACCOUNT);
    net.reset_and_open(DEV_A);
    // Son state.ctx est en cours de livraison par iCloud (ligne incomplète) : `cloud-pending`, rien d'écrit.
    let len = net.fs.get(&["devices", DEV_B, "state.ctx"]).unwrap().len();
    net.fs.truncate(&["devices", DEV_B, "state.ctx"], len - 10);
    let payload = net.core(DEV_A).pairing_payload(u64::MAX >> 12).unwrap();
    let first = net.core(DEV_B).key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1);
    assert_eq!(code(first), SyncCode::CloudPending);
    assert_eq!(net.vault_kid(DEV_B, SYNC_KEY_ACCOUNT), k);
    assert!(!net.dev(DEV_B).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
}

#[test]
fn audit3_switch_rechecks_its_own_k2_state_before_erasing_anything() {
    let mut net = Net::new(&[]);
    net.cycle(DEV_A).unwrap();
    let old_state = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    let k = net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT);
    net.reset_and_open(DEV_A);
    net.dev(DEV_A).stop.at("switch-3");
    assert_eq!(code(net.read_all(DEV_A)), SyncCode::Io);
    // Un tiers remet un ancien state.ctx sous K à la place de l'état copié à l'étape 1.
    net.fs.put(&["devices", DEV_A, "state.ctx"], &old_state);
    net.dev_mut(DEV_A).d.restart();
    assert_eq!(code(net.read_all(DEV_A)), SyncCode::StateMismatch, "bascule arrêtée");
    assert_eq!(net.vault_kid(DEV_A, SYNC_KEY_ACCOUNT), k, "K jamais effacée");
    assert!(net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
    assert!(net.files_of(DEV_A).iter().any(|f| f.contains(&epoch(1, DEV_A))), "anciens fichiers gardés");
}

#[test]
fn audit5_own_state_back_only_for_the_last_state_written_under_k() {
    let mut net = Net::new(&[DEV_W]);
    net.cycle(DEV_W).unwrap();
    net.cycle(DEV_A).unwrap();
    net.core(DEV_A).reset_key(1).unwrap();
    let kid_w = net.core(DEV_W).reset_key(1).unwrap();
    // A publie son annonce deux fois (reprise) ; un tiers rejoue ensuite la première copie.
    let notice = serde_json::to_value(net.read_all(DEV_A).unwrap().reset.unwrap().notice.unwrap()).unwrap();
    net.publish(DEV_A, notice.clone()).unwrap();
    let first = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    net.publish(DEV_A, notice).unwrap();
    let dev = net.dev_mut(DEV_A);
    dev.epoch = epoch(2, DEV_A);
    dev.head = (0, 0, None);
    dev.snap = None;
    net.snapshot(DEV_A).unwrap();
    net.dev_mut(DEV_A).acks = json!({});
    net.publish(DEV_A, Value::Null).unwrap();
    net.announce_and_open(DEV_W, &kid_w);
    net.fs.put(&["devices", DEV_A, "state.ctx"], &first);
    let out = net.read_all(DEV_A).unwrap();
    assert!(out.reset.unwrap().superseded.is_some());
    assert_eq!(out.states[DEV_A].0, "rollback", "un état rejoué n'est jamais repris par l'anti-rejeu de soi");
}

#[test]
fn audit6_old_key_withdrawal_fails_closed_when_a_state_is_still_in_the_cloud() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    net.fs.set_availability(&["devices", DEV_A, "state.ctx"], circletasks_lib::sync::files::Availability::Cloud);
    *net.fs.hydrate_error.lock().unwrap() = Some(circletasks_lib::sync::files::FsError::CloudPending);
    assert_eq!(code(net.core(DEV_B).pairing_preconditions(true)), SyncCode::CloudPending, "liste incomplète : refus");
    // Hydraté au contrôle suivant : rien d'annoncé, l'ancienne clé peut être donnée.
    assert!(net.core(DEV_B).pairing_preconditions(true).is_ok());
}

#[test]
fn audit7_and_review10_next_key_is_erased_even_without_a_registry() {
    let net = Net::new(&[]);
    let orphan = MasterKey::generate().unwrap();
    net.dev(DEV_A).d.vault.set(SYNC_NEXT_KEY_ACCOUNT, &orphan.to_vault_value()).unwrap();
    net.core(DEV_A).forget_folder(true, 1).unwrap();
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), "effacement de la clé");
    let net = Net::new(&[]);
    net.dev(DEV_A).d.vault.set(SYNC_NEXT_KEY_ACCOUNT, &orphan.to_vault_value()).unwrap();
    net.core(DEV_A).forget_folder(false, 1).unwrap();
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), "abandon sans registre");
    assert!(net.dev(DEV_A).d.vault.contains(SYNC_KEY_ACCOUNT).unwrap(), ".v1 gardée");
}

#[test]
fn audit8_no_append_nor_snapshot_in_the_target_epoch_before_the_announcement() {
    let mut net = Net::new(&[]);
    net.cycle(DEV_A).unwrap();
    net.core(DEV_A).reset_key(1).unwrap();
    let target = epoch(2, DEV_A);
    let req = AppendRequest { epoch: target.clone(), segment: 1, expect_records: 0, sv: SV, max_hlc: hlc(NOW_FORGE, DEV_A), records: vec!["{}".into()] };
    assert_eq!(code(net.core(DEV_A).append_journal(&req)), SyncCode::StateMismatch);
    assert_eq!(code(net.core(DEV_A).snapshot_begin(&target, 1, SV)), SyncCode::StateMismatch);
    assert!(!net.files_of(DEV_A).iter().any(|f| f.contains(&target)), "rien d'écrit");
}

#[test]
fn review1_withdrawal_needs_a_seen_announcement_and_a_newer_state() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    let before = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    net.reset_and_open(DEV_A);
    net.join(DEV_C, DEV_A);
    // B voit encore l'état de A d'avant l'annonce et pas son state.next.ctx (iCloud en retard) ; il importe K2 par C.
    let saved_next = net.fs.get(&["devices", DEV_A, "state.next.ctx"]).unwrap();
    let saved_state = net.fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    net.fs.put(&["devices", DEV_A, "state.ctx"], &before);
    net.fs.remove(&["devices", DEV_A, "state.next.ctx"]);
    net.join(DEV_B, DEV_C);
    let view = net.read_all(DEV_B).unwrap().reset.unwrap();
    assert!(view.superseded.is_none(), "import avant l'annonce visible : jamais une perte");
    net.fs.put(&["devices", DEV_A, "state.ctx"], &saved_state);
    net.fs.put(&["devices", DEV_A, "state.next.ctx"], &saved_next);
    let view = net.read_all(DEV_B).unwrap().reset.unwrap();
    assert!(view.superseded.is_none());
    assert!(net.reset_file(DEV_B).unwrap()["noticeSeq"].as_u64().is_some(), "annonce apprise ensuite");
}

#[test]
fn review2_old_recovery_key_is_refused_as_key_mismatch_on_a_device_that_moved_on() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    let old = net.key_of(DEV_A, SYNC_KEY_ACCOUNT);
    net.reset_and_open(DEV_A);
    // B, qui a lu l'annonce et détient déjà K : l'ancienne clé de secours n'« associe » rien.
    net.read_all(DEV_B).unwrap();
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(old.recovery_key()), 1)), SyncCode::KeyMismatch);
    net.join(DEV_B, DEV_A);
    // Réassocié : l'ancienne clé (encore sous .v1) n'associe rien non plus.
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(old.recovery_key()), 1)), SyncCode::KeyMismatch);
    net.core(DEV_A).device_forget(DEV_C, 1).unwrap();
    assert!(net.read_all(DEV_A).unwrap().reset.unwrap().switched);
    net.publish(DEV_A, Value::Null).unwrap();
    assert!(net.read_all(DEV_B).unwrap().reset.unwrap().switched);
    net.publish(DEV_B, Value::Null).unwrap();
    // B (sous K2) : K ne déchiffre plus que l'état de C, d'une époque antérieure : key-mismatch, rien d'enregistré.
    net.dev(DEV_B).d.clock.advance(11 * 60_000);
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(old.recovery_key()), 1)), SyncCode::KeyMismatch);
    assert!(!net.dev(DEV_B).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
    assert!(net.reset_file(DEV_B).is_none());
}

#[test]
fn p14_forget_during_a_reset_two_exceptions_only() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    net.reset_and_open(DEV_A);
    net.read_all(DEV_B).unwrap();
    let prompts = net.dev(DEV_B).d.ui.prompts();
    assert_eq!(code(net.core(DEV_B).device_forget(DEV_C, 1)), SyncCode::StateMismatch, "B à réassocier, cible non annonceuse");
    assert_eq!(net.dev(DEV_B).d.ui.prompts(), prompts, "sans boîte");
    net.core(DEV_B).device_forget(DEV_A, 1).expect("cible auteur d'une annonce : permis");
    assert_eq!(net.dev(DEV_B).d.ui.prompts(), prompts + 1);
    // Réassocié : non-annonceur refusé sans boîte, auteur de la réinitialisation rejointe permis.
    net.join(DEV_C, DEV_A);
    let prompts = net.dev(DEV_C).d.ui.prompts();
    assert_eq!(code(net.core(DEV_C).device_forget(DEV_B, 1)), SyncCode::StateMismatch);
    assert_eq!(net.dev(DEV_C).d.ui.prompts(), prompts);
    net.core(DEV_C).device_forget(DEV_A, 1).expect("auteur de la réinitialisation rejointe : permis");
}

#[test]
fn p14_initiator_cannot_forget_once_its_switch_has_begun() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    net.reset_and_open(DEV_A);
    net.join(DEV_B, DEV_A);
    net.join(DEV_C, DEV_A);
    net.dev(DEV_A).stop.at("switch-2");
    assert_eq!(code(net.read_all(DEV_A)), SyncCode::Io);
    let prompts = net.dev(DEV_A).d.ui.prompts();
    assert_eq!(code(net.core(DEV_A).device_forget(DEV_B, 1)), SyncCode::StateMismatch);
    assert_eq!(net.dev(DEV_A).d.ui.prompts(), prompts);
}

#[test]
fn p15_superseded_registry_is_closed_when_its_winner_is_forgotten() {
    let mut net = Net::new(&[DEV_W]);
    net.cycle(DEV_W).unwrap();
    net.cycle(DEV_A).unwrap();
    let kid_a = net.core(DEV_A).reset_key(1).unwrap();
    let kid_w = net.core(DEV_W).reset_key(1).unwrap();
    net.announce_and_open(DEV_A, &kid_a);
    net.announce_and_open(DEV_W, &kid_w);
    assert!(net.read_all(DEV_A).unwrap().reset.unwrap().superseded.is_some());
    net.core(DEV_A).device_forget(DEV_W, 1).expect("le gagnant est l'auteur d'une annonce");
    let view = net.read_all(DEV_A).unwrap().reset.expect("vue");
    assert!(view.closed, "registre clos");
    assert!(net.reset_file(DEV_A).is_none());
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap(), ".next reste effacée");
    assert!(net.read_all(DEV_A).unwrap().reset.is_none());
    // A republie sous K (époque n, sans annonce), puis peut relancer.
    let own = net.own_json(DEV_A);
    let dev = net.dev_mut(DEV_A);
    dev.epoch = epoch(1, DEV_A);
    dev.head = (0, 0, None);
    dev.snap = Some((1, hlc(5_000_001, DEV_A)));
    dev.seq = own["stateSeq"].as_u64().unwrap();
    net.publish(DEV_A, Value::Null).unwrap();
    net.dev(DEV_A).d.clock.advance(11 * 60_000);
    assert!(net.core(DEV_A).reset_key(1).is_ok(), "sync_reset_key permis");
}

#[test]
fn p16_rust_refuses_to_open_any_other_epoch_during_a_reset() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    net.reset_and_open(DEV_A);
    let other = epoch(3, DEV_A);
    assert_eq!(code(net.core(DEV_A).snapshot_begin(&other, 1, SV)), SyncCode::StateMismatch, "autre époque que celle de reset.json");
    net.read_all(DEV_B).unwrap();
    let own = epoch(2, DEV_B);
    assert_eq!(code(net.core(DEV_B).snapshot_begin(&own, 1, SV)), SyncCode::StateMismatch, "annonce lue : aucune autre époque");
    let req = AppendRequest { epoch: own.clone(), segment: 1, expect_records: 0, sv: SV, max_hlc: hlc(NOW_FORGE, DEV_B), records: vec!["{}".into()] };
    assert_eq!(code(net.core(DEV_B).append_journal(&req)), SyncCode::StateMismatch);
    let dev = net.dev_mut(DEV_B);
    dev.epoch = own.clone();
    assert_eq!(code(net.publish(DEV_B, Value::Null)), SyncCode::StateMismatch);
    assert!(!net.files_of(DEV_B).iter().any(|f| f.contains(&own)));
}

#[test]
fn p16_a_restore_applied_before_the_announcement_competes_by_epoch_order() {
    // Restauration d'un appareil à l'UUID plus grand : elle l'emporte, la réinitialisation est perdue.
    let mut net = Net::new(&[DEV_W]);
    net.cycle(DEV_W).unwrap();
    net.cycle(DEV_A).unwrap();
    net.core(DEV_A).reset_key(1).unwrap();
    net.open_restore(DEV_W).unwrap();
    let lost = net.read_all(DEV_A).unwrap().reset.unwrap().superseded.expect("restauration gagnante");
    assert_eq!(lost.epoch.as_deref(), Some(epoch(2, DEV_W).as_str()));
    assert_eq!(lost.by.as_deref(), Some(DEV_W));
    assert!(lost.restore);
    assert!(!net.dev(DEV_A).d.vault.contains(SYNC_NEXT_KEY_ACCOUNT).unwrap());
    // A suit l'époque restaurée (remplacement) : permise par la garde d'époque.
    let dev = net.dev_mut(DEV_A);
    dev.epoch = epoch(2, DEV_W);
    dev.head = (0, 0, None);
    dev.snap = None;
    dev.acks = json!({});
    net.publish(DEV_A, Value::Null).expect("époque gagnante suivie");
    // Suivie : la perte face à une restauration est close (rien à associer, l'ancienne clé reste la clé du dossier) ; A peut donner sa
    // clé et relancer une réinitialisation.
    assert!(net.read_all(DEV_A).unwrap().reset.is_none());
    assert!(net.reset_file(DEV_A).is_none());
    assert!(net.core(DEV_A).pairing_preconditions(true).is_ok());
    net.cycle(DEV_W).unwrap();
    net.cycle(DEV_A).unwrap();
    net.dev(DEV_A).d.clock.advance(11 * 60_000);
    assert!(net.core(DEV_A).reset_key(1).is_ok(), "relance");
    // Plus petite : l'annonce l'emporte.
    let mut net = Net::new(&[DEV_Z]);
    net.cycle(DEV_Z).unwrap();
    net.cycle(DEV_A).unwrap();
    let kid = net.core(DEV_A).reset_key(1).unwrap();
    net.open_restore(DEV_Z).unwrap();
    net.announce_and_open(DEV_A, &kid);
    assert!(net.read_all(DEV_A).unwrap().reset.unwrap().superseded.is_none());
}

#[test]
fn p17_import_failure_is_persisted_and_cleared() {
    let mut net = Net::new(&[DEV_B]);
    net.cycle(DEV_B).unwrap();
    assert!(net.import_failure(DEV_B).is_none());
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(Zeroizing::new("CT1-AAAAA".into())), 1)), SyncCode::InvalidPairing);
    let failure = net.import_failure(DEV_B).unwrap();
    assert_eq!(failure["code"], "invalid-pairing");
    assert!(failure["at"].as_str().unwrap().ends_with('Z'));
    let stranger = MasterKey::generate().unwrap();
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(stranger.recovery_key()), 1)), SyncCode::KeyMismatch);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "key-mismatch");
    // QR expiré : écrit.
    let qr = circletasks_lib::sync::crypto::qr_text_of(&stranger, DEV_A, None, 1);
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::QrText(Zeroizing::new((*qr).clone())), 1)), SyncCode::PairingExpired);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "pairing-expired");
    // Premier plan perdu : montré sur-le-champ, rien d'écrit.
    net.dev(DEV_B).d.ui.ready(false);
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(stranger.recovery_key()), 1)), SyncCode::NotForeground);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "pairing-expired");
    net.dev(DEV_B).d.ui.ready(true);
    // Contrôles de fenêtre et d'instance (commande) : aucune entrée légitime traitée, rien d'écrit.
    net.core(DEV_B).record_import_failure(SyncCode::WrongWindow);
    net.core(DEV_B).record_import_failure(SyncCode::WrongMode);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "pairing-expired");
    // Refus de la boîte de remplacement : choix de l'utilisateur, rien d'écrit ; puis blocage : `rate-limited`, écrit.
    net.reset_and_open(DEV_A);
    net.read_all(DEV_B).unwrap();
    let payload = net.core(DEV_A).pairing_payload(u64::MAX >> 12).unwrap();
    net.dev(DEV_B).d.ui.answer(false);
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1)), SyncCode::ConsentDenied);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "pairing-expired");
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1)), SyncCode::RateLimited);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "rate-limited");
    // Après le blocage : réussite, échec effacé.
    net.dev(DEV_B).d.clock.advance(11 * 60_000);
    net.dev(DEV_B).d.ui.answer(true);
    net.core(DEV_B).key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1).unwrap();
    assert!(net.import_failure(DEV_B).is_none());
    // Fichier illisible : null ; autre dossier : ignoré ; effacé par l'oubli du dossier.
    let path = net.dev(DEV_B).d.base.path().join("sync").join("import-failure.json");
    std::fs::write(&path, b"{pas du json").unwrap();
    assert!(net.import_failure(DEV_B).is_none());
    std::fs::write(&path, br#"{"v":1,"folderId":"autre","code":"io","at":"2026-10-06T08:00:00.000Z","next":false}"#).unwrap();
    assert!(net.import_failure(DEV_B).is_none());
    assert_eq!(code(net.core(DEV_B).key_import(KeyInput::RecoveryKey(stranger.recovery_key()), 1)), SyncCode::KeyMismatch);
    assert_eq!(net.import_failure(DEV_B).unwrap()["code"], "key-mismatch");
    let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(file["next"], true, "réinitialisation en cours");
    net.core(DEV_B).forget_folder(false, 1).unwrap();
    assert!(!path.exists());
}

#[test]
fn p14_switch_waits_until_the_announced_k2_snapshot_covers_each_retained_forgotten() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    net.reset_and_open(DEV_A);
    // C publie dans l'époque n ; B le lit (son accusé dépasse les `covers` de l'instantané d'ouverture de A).
    net.write(DEV_C).unwrap();
    net.publish(DEV_C, Value::Null).unwrap();
    net.cycle(DEV_B).unwrap();
    let cut = net.dev(DEV_B).acks[DEV_C].clone();
    net.core(DEV_A).device_forget(DEV_C, 1).unwrap();
    net.join(DEV_B, DEV_A);
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    assert!(!view.switched, "instantané d'ouverture non couvrant");
    assert_eq!(view.waiting, vec![DEV_C.to_owned()]);
    // A rattrape C jusqu'à la coupure, écrit un nouvel instantané de n+1 qui le couvre, puis republie son état sous K2.
    net.dev_mut(DEV_A).acks = json!({ DEV_C: cut });
    net.snapshot(DEV_A).unwrap();
    net.dev_mut(DEV_A).acks = json!({});
    net.publish(DEV_A, Value::Null).unwrap();
    assert!(net.read_all(DEV_A).unwrap().reset.unwrap().switched, "couvert : bascule");
}

#[test]
fn second_review_forget_after_reassociation_ignores_an_ack_in_an_epoch_the_forgotten_never_published() {
    let mut net = Net::new(&[DEV_B, DEV_C]);
    net.write(DEV_C).unwrap();
    net.publish(DEV_C, Value::Null).unwrap();
    for id in [DEV_B, DEV_C, DEV_A] {
        net.cycle(id).unwrap();
    }
    net.reset_and_open(DEV_A);
    net.join(DEV_B, DEV_A);
    // B (moteur d'avant la correction) publie sous K2 un accusé sur C au début de l'époque visée, où C n'a jamais rien publié.
    let target = epoch(2, DEV_A);
    net.dev_mut(DEV_B).acks = json!({ DEV_C: { "epoch": target, "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 } });
    net.publish(DEV_B, Value::Null).unwrap();
    net.core(DEV_A).device_forget(DEV_C, 1).unwrap();
    let view = net.read_all(DEV_A).unwrap().reset.unwrap();
    assert!(view.switched, "accusé sans objet ignoré : l'instantané d'ouverture couvre C (waiting {:?})", view.waiting);
    net.publish(DEV_A, Value::Null).unwrap();
    assert!(net.read_all(DEV_B).unwrap().reset.unwrap().switched);
}
