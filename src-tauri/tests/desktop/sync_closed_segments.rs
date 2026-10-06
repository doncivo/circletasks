//! Y-TECH-02, ADR 0011 §21 point 2 : nombre d'enregistrements des segments clos (`closed` de `state.ctx`, maître Rust). Table commune avec
//! Vitest (`tests/fixtures/sync/closed-segments.json`), schéma (`state.rs`), écriture (`own.json`, `sync_write_state`).

use serde_json::{json, Value};

use circletasks_lib::sync::files::Availability;
use circletasks_lib::sync::limits::MAX_STATE_CLOSED_SEGMENTS;
use circletasks_lib::sync::service::AppendRequest;
use circletasks_lib::sync::state::PublishedState;
use circletasks_lib::sync::store::{OwnFileRef, RecordCursor};
use circletasks_lib::sync::SyncCode;

use crate::sync_support::{device, epoch, hlc, Device, MemFs, DEV_A, DEV_B};

const TABLE: &str = include_str!("../../../tests/fixtures/sync/closed-segments.json");

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

fn append(d: &Device, ep: &str, segment: u64, ms: u64, n: u64) -> Result<circletasks_lib::sync::store::AppendResult, circletasks_lib::sync::SyncError> {
    let records = (0..n).map(|i| format!("{{\"k\":\"ops\",\"s\":{segment},\"i\":{i}}}")).collect();
    d.core.append_journal(&AppendRequest { epoch: ep.to_owned(), segment, expect_records: 0, sv: 14, max_hlc: hlc(ms, DEV_A), records })
}

fn state(ep: &str, seq: u64, segment: u64, record: u64, head_hlc: Option<String>) -> Value {
    json!({
        "deviceId": DEV_A, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": segment, "record": record, "hlc": head_hlc, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(seq * 1_000, DEV_A), "forgotten": [], "reset": null
    })
}

fn segment_path(ep: &str, n: u64) -> Vec<String> {
    vec!["devices".to_owned(), DEV_A.to_owned(), ep.to_owned(), format!("j-{n:08}.ctj")]
}

fn published(fs: &MemFs, d: &Device) -> PublishedState {
    // L'état de soi relu par le scan (déchiffré par Rust) : le champ `closed` tel qu'il est publié.
    let scan = d.core.scan(&[]).unwrap();
    let _ = fs;
    scan.devices.into_iter().find(|s| s.device_id == DEV_A).and_then(|s| s.state).expect("état publié")
}

/// `own.json` écrit avant la story : aucune entrée `closed` (le prochain état est publié sans `closed`).
fn clear_own_closed(d: &mut Device) {
    let path = d.base.path().join("sync").join("own.json");
    let mut own: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    own.as_object_mut().unwrap().insert("closed".to_owned(), json!([]));
    std::fs::write(&path, serde_json::to_vec(&own).unwrap()).unwrap();
    d.restart();
}

/// Lignes du fichier (en-tête compris) : modifiées selon le cas, puis réécrites.
fn alter(fs: &MemFs, ep: &str, case: &Value) {
    let n = case["segment"].as_u64().unwrap();
    let path = segment_path(ep, n);
    let parts: Vec<&str> = path.iter().map(String::as_str).collect();
    let bytes = fs.get(&parts).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let mut lines: Vec<String> = text.split_terminator('\n').map(str::to_owned).collect();
    let header = lines.remove(0);
    if let Some(keep) = case["keep"].as_u64() {
        lines.truncate(keep as usize);
    }
    for _ in 0..case["extra"].as_u64().unwrap_or(0) {
        let last = lines.last().unwrap().clone();
        lines.push(last);
    }
    if let Some(i) = case["corrupt"].as_u64() {
        let line = &mut lines[i as usize];
        let middle = line.len() - 8;
        let flipped = if &line[middle..middle + 1] == "A" { "B" } else { "A" };
        line.replace_range(middle..middle + 1, flipped);
    }
    let mut out = format!("{header}\n");
    for line in &lines {
        out.push_str(line);
        out.push('\n');
    }
    if case["partial"].as_bool() == Some(true) {
        out.push_str("AAAA");
    }
    fs.put(&parts, out.as_bytes());
    if case["cloud"].as_bool() == Some(true) {
        fs.set_availability(&parts, Availability::Cloud);
    }
}

#[test]
fn y_tech_02_closed_segments_common_table() {
    let table: Value = serde_json::from_str(TABLE).unwrap();
    assert_eq!(table["maxEntries"].as_u64().unwrap() as usize, MAX_STATE_CLOSED_SEGMENTS, "plafond commun à Rust et TypeScript");
    for case in table["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (mut d, fs) = device();
        d.setup(DEV_A);
        let ep = epoch(1, DEV_A);
        let mut ms = 10;
        let mut last = (0, 0, None);
        for s in case["segments"].as_array().unwrap() {
            ms += 10;
            let n = s["segment"].as_u64().unwrap();
            let written = s["written"].as_u64().unwrap();
            append(&d, &ep, n, ms, written).unwrap_or_else(|e| panic!("{name} : ajout {e:?}"));
            last = (n, written, Some(hlc(ms, DEV_A)));
        }
        if case["announce"].as_bool() == Some(false) {
            clear_own_closed(&mut d);
        }
        d.core.write_state(14, state(&ep, 1, last.0, last.1, last.2.clone())).unwrap_or_else(|e| panic!("{name} : état {e:?}"));
        for s in case["segments"].as_array().unwrap() {
            alter(&fs, &ep, s);
        }
        let from = RecordCursor { segment: case["from"]["segment"].as_u64().unwrap(), record: case["from"]["record"].as_u64().unwrap() };
        let page = d.core.read_journal(DEV_A, &ep, from, None).unwrap_or_else(|e| panic!("{name} : lecture {e:?}"));
        let expect = &case["expect"];
        assert_eq!(page.status, expect["status"].as_str().unwrap(), "{name}");
        assert_eq!(page.next, RecordCursor { segment: expect["next"]["segment"].as_u64().unwrap(), record: expect["next"]["record"].as_u64().unwrap() }, "{name}");
        assert_eq!(page.records.len() as u64, expect["records"].as_u64().unwrap(), "{name}");
    }
}

#[test]
fn y_tech_02_closed_schema() {
    let ep = epoch(1, DEV_A);
    let with = |closed: Value, head_segment: u64| -> Option<PublishedState> {
        let mut s = state(&ep, 4, head_segment, 2, Some(hlc(30, DEV_A)));
        s.as_object_mut().unwrap().insert("closed".to_owned(), closed);
        PublishedState::parse(&s.to_string())
    };
    // Absent et [] : liste vide ; texte canonique sans la clé.
    let absent = PublishedState::parse(&state(&ep, 4, 3, 2, Some(hlc(30, DEV_A))).to_string()).unwrap();
    assert!(absent.closed.is_empty());
    let empty = with(json!([]), 3).unwrap();
    assert!(empty.closed.is_empty());
    assert!(!empty.canonical_json().contains("closed"));
    // Valide : gardé, en dernière clé (même texte que publishedStateToJson).
    let valid = with(json!([{ "segment": 1, "records": 3 }, { "segment": 2, "records": 5 }]), 3).unwrap();
    assert!(valid.canonical_json().ends_with(r#""closed":[{"segment":1,"records":3},{"segment":2,"records":5}]}"#), "{}", valid.canonical_json());
    // Refusés.
    for bad in [
        json!([{ "segment": 2, "records": 1 }, { "segment": 1, "records": 1 }]),
        json!([{ "segment": 1, "records": 1 }, { "segment": 1, "records": 2 }]),
        json!([{ "segment": 3, "records": 1 }]),
        json!([{ "segment": 0, "records": 1 }]),
        json!([{ "segment": 1, "records": 0 }]),
        json!([{ "segment": 1, "records": 1, "extra": 1 }]),
        json!("x"),
    ] {
        assert!(with(bad.clone(), 3).is_none(), "{bad}");
    }
    let many: Vec<Value> = (1..=MAX_STATE_CLOSED_SEGMENTS as u64 + 1).map(|n| json!({ "segment": n, "records": 1 })).collect();
    assert!(with(Value::Array(many.clone()), MAX_STATE_CLOSED_SEGMENTS as u64 + 2).is_none());
    assert_eq!(with(Value::Array(many[1..].to_vec()), MAX_STATE_CLOSED_SEGMENTS as u64 + 2).unwrap().closed.len(), MAX_STATE_CLOSED_SEGMENTS);
}

#[test]
fn y_tech_02_closed_written_by_rust() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&d, &ep, 1, 10, 2).unwrap();
    append(&d, &ep, 2, 20, 1).unwrap();
    // Omis par le moteur → complété depuis own.json ; différent → state-mismatch ; égal → accepté.
    d.core.write_state(14, state(&ep, 1, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    let closed: Vec<(u64, u64)> = published(&fs, &d).closed.iter().map(|c| (c.segment, c.records)).collect();
    assert_eq!(closed, vec![(1, 2)]);
    let mut wrong = state(&ep, 2, 2, 1, Some(hlc(20, DEV_A)));
    wrong.as_object_mut().unwrap().insert("closed".to_owned(), json!([{ "segment": 1, "records": 1 }]));
    assert_eq!(code(d.core.write_state(14, wrong)), SyncCode::StateMismatch);
    let mut same = state(&ep, 3, 2, 1, Some(hlc(20, DEV_A)));
    same.as_object_mut().unwrap().insert("closed".to_owned(), json!([{ "segment": 1, "records": 2 }]));
    d.core.write_state(14, same).unwrap();
    // Suppression d'un segment : entrée retirée ; nouvelle époque : liste vide.
    append(&d, &ep, 3, 30, 1).unwrap();
    d.core.delete_own(&[OwnFileRef { epoch: ep.clone(), kind: "j".to_owned(), n: Some(1) }]).unwrap();
    d.core.write_state(14, state(&ep, 4, 3, 1, Some(hlc(30, DEV_A)))).unwrap();
    let closed: Vec<(u64, u64)> = published(&fs, &d).closed.iter().map(|c| (c.segment, c.records)).collect();
    assert_eq!(closed, vec![(2, 1)]);
    let ep2 = epoch(2, DEV_A);
    d.core.write_state(14, state(&ep2, 5, 0, 0, None)).unwrap();
    assert!(published(&fs, &d).closed.is_empty());
}

#[test]
fn y_tech_02_closed_after_an_interrupted_append_counts_what_the_state_could_announce() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&d, &ep, 1, 10, 2).unwrap();
    // Ligne incomplète laissée par un arrêt : l'ajout suivant au même segment est refusé, le moteur ouvre j-2.
    let path = segment_path(&ep, 1);
    let parts: Vec<&str> = path.iter().map(String::as_str).collect();
    let mut bytes = fs.get(&parts).unwrap();
    bytes.extend_from_slice(b"AAAA");
    fs.put(&parts, &bytes);
    let request = AppendRequest { epoch: ep.clone(), segment: 1, expect_records: 2, sv: 14, max_hlc: hlc(20, DEV_A), records: vec!["{}".to_owned()] };
    assert_eq!(code(d.core.append_journal(&request)), SyncCode::SegmentMismatch);
    append(&d, &ep, 2, 20, 1).unwrap();
    d.core.write_state(14, state(&ep, 1, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    let closed: Vec<(u64, u64)> = published(&fs, &d).closed.iter().map(|c| (c.segment, c.records)).collect();
    assert_eq!(closed, vec![(1, 2)]);
    let page = d.core.read_journal(DEV_A, &ep, RecordCursor { segment: 0, record: 0 }, None).unwrap();
    assert_eq!((page.status, page.records.len()), ("complete", 3), "aucune attente sans fin sur la ligne incomplète");
}

#[test]
fn y_tech_02_closed_cap_drops_the_oldest() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    let last = MAX_STATE_CLOSED_SEGMENTS as u64 + 2;
    for n in 1..=last {
        append(&d, &ep, n, 10 * n, 1).unwrap();
    }
    d.core.write_state(14, state(&ep, 1, last, 1, Some(hlc(10 * last, DEV_A)))).unwrap();
    let closed = published(&fs, &d).closed;
    assert_eq!(closed.len(), MAX_STATE_CLOSED_SEGMENTS);
    assert_eq!((closed[0].segment, closed[0].records), (2, 1));
}

#[test]
fn y_tech_02_closed_rebuilt_from_its_own_state_only() {
    let (mut d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&d, &ep, 1, 10, 2).unwrap();
    append(&d, &ep, 2, 20, 1).unwrap();
    d.core.write_state(14, state(&ep, 1, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    // own.json perdu : entrée reprise de son propre état authentifié.
    std::fs::remove_file(d.base.path().join("sync").join("own.json")).unwrap();
    d.restart();
    d.core.write_state(14, state(&ep, 2, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    let closed: Vec<(u64, u64)> = published(&fs, &d).closed.iter().map(|c| (c.segment, c.records)).collect();
    assert_eq!(closed, vec![(1, 2)]);
    // Un accusé authentifié sur soi dépasse l'entrée dans ce segment : écartée à la reconstruction.
    let b = Device::new(circletasks_lib_backend(&fs));
    b.core.choose_folder(std::path::Path::new(crate::sync_support::FOLDER)).unwrap();
    let account = circletasks_lib::sync::service::SYNC_KEY_ACCOUNT;
    use circletasks_lib::vault::SecretVault;
    b.vault.set(account, &d.vault.get(account).unwrap().unwrap()).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    let mut bs = state(&ep, 1, 0, 0, None);
    bs["deviceId"] = json!(DEV_B);
    bs["head"]["stateSeq"] = json!(1);
    bs["lastSyncHlc"] = json!(hlc(1_000, DEV_B));
    bs["acks"] = json!({ DEV_A: { "epoch": ep, "segment": 1, "record": 3, "hlc": hlc(10, DEV_A), "stateSeq": 2 } });
    b.core.write_state(14, bs).unwrap();
    std::fs::remove_file(d.base.path().join("sync").join("own.json")).unwrap();
    d.restart();
    d.core.write_state(14, state(&ep, 3, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    assert!(published(&fs, &d).closed.is_empty(), "entrée dépassée par l'accusé de B : écartée");
    // État absent et own.json perdu : aucune entrée (règle d'avant), jamais inventée ; tête reconstruite des fichiers, sans hlc.
    fs.remove(&["devices", DEV_B, "state.ctx"]);
    fs.remove(&["devices", DEV_A, "state.ctx"]);
    std::fs::remove_file(d.base.path().join("sync").join("own.json")).unwrap();
    d.restart();
    d.core.write_state(14, state(&ep, 4, 2, 1, None)).unwrap();
    assert!(published(&fs, &d).closed.is_empty());
}

fn circletasks_lib_backend(fs: &std::sync::Arc<MemFs>) -> std::sync::Arc<crate::sync_support::FakeBackend> {
    crate::sync_support::FakeBackend::with(crate::sync_support::FOLDER, circletasks_lib::sync::folder::FolderKind::Icloud, fs.clone())
}
