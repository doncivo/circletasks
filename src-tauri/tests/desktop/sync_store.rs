//! Y-01 critères 4, 5, 7 et 11 à 16 : dossier mémorisé, appareil figé, noms stricts, `sync_scan`, bornes, fichiers dans le nuage,
//! `own.json`, journaux, état publié, instantanés, suppression, marqueur de restauration ; cas limites de l'avenant « Amorce » (mêmes
//! codes que `memory.ts`). Dossier simulé en mémoire (`sync_support::MemFs`).

use std::path::Path;
use std::sync::atomic::Ordering;

use circletasks_lib::sync::files::{Availability, FsError};
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::limits::{MAX_SCAN_ENTRIES_PER_FOLDER, MAX_SEGMENT_BYTES, MAX_STATE_FILE_BYTES};
use circletasks_lib::sync::marker;
use circletasks_lib::sync::service::AppendRequest;
use circletasks_lib::sync::store::{OwnFileRef, RecordCursor};
use circletasks_lib::sync::SyncCode;
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, DEV_C, FOLDER};

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

fn append(d: &Device, ep: &str, segment: u64, expect: u64, ms: u64, records: &[&str]) -> Result<circletasks_lib::sync::store::AppendResult, circletasks_lib::sync::SyncError> {
    let request = AppendRequest {
        epoch: ep.to_owned(),
        segment,
        expect_records: expect,
        sv: 14,
        max_hlc: hlc(ms, DEV_A),
        records: records.iter().map(|r| (*r).to_owned()).collect(),
    };
    d.core.append_journal(&request)
}

/// État publié minimal (forme JSON canonique).
fn state(dev: &str, ep: &str, seq: u64, segment: u64, record: u64, head_hlc: Option<String>) -> Value {
    json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": segment, "record": record, "hlc": head_hlc, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(seq * 1_000, dev), "forgotten": [], "reset": null
    })
}

fn other(fs: &std::sync::Arc<MemFs>) -> Device {
    Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()))
}

const C0: RecordCursor = RecordCursor { segment: 0, record: 0 };

// ------------------------------------------------------------------------------------------------------------------------------
// Dossier, appareil, mémorisation
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y01_4_folder_is_remembered_after_restart_and_only_a_label_is_returned() {
    let (mut d, _) = device();
    assert!(!d.core.folder_info().unwrap().configured);
    let info = d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!((info.configured, info.name.as_deref(), info.kind), (true, Some("CircleTasks"), "icloud"));
    let shown = serde_json::to_string(&info).unwrap();
    assert!(!shown.contains("Users") && !shown.contains('\\'), "jamais de chemin : {shown}");
    d.restart();
    let again = d.core.folder_info().unwrap();
    assert_eq!(again, info, "même libellé après redémarrage, sans nouvelle boîte");
    let record: Value = serde_json::from_slice(&std::fs::read(d.base.path().join("sync").join("folder.json")).unwrap()).unwrap();
    assert_eq!(record["path"], FOLDER);
}

#[test]
fn y01_5_device_binding_is_frozen_and_a_new_folder_resets_own_json() {
    let (d, fs) = device();
    d.setup(DEV_A);
    assert_eq!(code(d.core.bind_device(DEV_B)), SyncCode::AlreadyBound);
    d.core.bind_device(DEV_A).unwrap();
    assert_eq!(code(d.core.bind_device("pas-un-uuid")), SyncCode::BadName);
    append(&d, &epoch(1, DEV_A), 1, 0, 10, &["{}"]).unwrap();
    let own = d.base.path().join("sync").join("own.json");
    assert!(own.exists());
    // Même dossier rechoisi : own.json gardé.
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert!(own.exists());
    // Autre dossier : own.json remis à zéro.
    d.backend.add(r"C:\Autre\CircleTasks", FolderKind::Local, MemFs::new());
    let info = d.core.choose_folder(Path::new(r"C:\Autre\CircleTasks")).unwrap();
    assert_eq!((info.name.as_deref(), info.kind), (Some("CircleTasks"), "local"));
    assert!(!own.exists());
    drop(fs);
}

#[test]
fn y01_17_forget_removes_own_json_and_keeps_the_key_unless_asked() {
    let (d, _) = device();
    d.setup(DEV_A);
    append(&d, &epoch(1, DEV_A), 1, 0, 10, &["{}"]).unwrap();
    let kid = d.core.key_status().unwrap().kid;
    d.core.forget_folder(false, 1).unwrap();
    assert!(!d.base.path().join("sync").join("own.json").exists());
    assert!(!d.base.path().join("sync").join("folder.json").exists());
    assert!(!d.core.folder_info().unwrap().configured);
    assert_eq!(d.core.key_status().unwrap().kid, kid, "clé gardée");
    assert_eq!(d.ui.prompts(), 0);
    // Rechoisir le même dossier : reprise sans association, nouvelle liaison possible.
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    d.core.bind_device(DEV_A).unwrap();
    append(&d, &epoch(1, DEV_A), 1, 1, 20, &["{}"]).unwrap();
    // Oublier aussi la clé : confirmation native (Annuler par défaut), puis plus de clé.
    d.ui.answer(false);
    assert_eq!(code(d.core.forget_folder(true, 1)), SyncCode::ConsentDenied);
    assert!(d.core.key_status().unwrap().present);
    assert!(d.core.folder_info().unwrap().configured, "refus : rien n'est oublié");
    d.clock.advance(10 * 60_000);
    d.ui.answer(true);
    d.core.forget_folder(true, 1).unwrap();
    assert!(!d.core.key_status().unwrap().present);
    let last = d.ui.last.lock().unwrap().clone().unwrap();
    assert_eq!(last.texts.content, "Sans clé, cet appareil devra être associé de nouveau.");
}

#[test]
fn y01_7_folder_that_became_unsafe_or_unreachable_is_refused_without_writing() {
    let (mut d, fs) = device();
    d.setup(DEV_A);
    // Au chargement : le contrôle du dossier échoue (jonction, dossier déplacé).
    *d.backend.refuse.lock().unwrap() = Some(SyncCode::UnsafeFolder);
    d.restart();
    assert_eq!(code(d.core.folder_info()), SyncCode::UnsafeFolder);
    assert_eq!(code(d.core.scan(&[])), SyncCode::UnsafeFolder);
    *d.backend.refuse.lock().unwrap() = None;
    // Au début d'un scan : revalidation de la racine.
    *fs.revalidate_error.lock().unwrap() = Some(FsError::Unreachable);
    let writes = fs.writes.load(Ordering::SeqCst);
    assert_eq!(code(d.core.scan(&[])), SyncCode::FolderUnreachable);
    assert_eq!(fs.writes.load(Ordering::SeqCst), writes, "aucune écriture");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Noms, scan, bornes, nuage
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y01_11_strict_names_conflict_copies_and_bad_parameters() {
    let (d, fs) = device();
    d.setup(DEV_A);
    d.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    fs.put(&["devices", DEV_A, "state 2.ctx"], b"copie");
    fs.put(&["devices", DEV_A, "state.ctx.tmp"], b"tmp");
    fs.put(&["devices", DEV_A, "state.next.ctx"], b"reserve");
    fs.put(&["devices", "pas-un-uuid", "state.ctx"], b"x");
    fs.put(&["devices", "notes.txt"], b"x");
    let before = fs.get(&["devices", DEV_A, "state 2.ctx"]);
    let scan = d.core.scan(&[]).unwrap();
    assert_eq!(scan.devices.len(), 1);
    assert_eq!(scan.ignored, 5);
    assert_eq!(fs.get(&["devices", DEV_A, "state 2.ctx"]), before, "jamais lu ni supprimé");
    let ep = epoch(1, DEV_A);
    assert_eq!(code(d.core.read_journal("../x", &ep, C0, None)), SyncCode::BadName);
    assert_eq!(code(d.core.read_journal(DEV_B, "e1-x", C0, None)), SyncCode::BadName);
    assert_eq!(code(d.core.read_journal(DEV_B, &ep, RecordCursor { segment: 0, record: 3 }, None)), SyncCode::BadName);
    assert_eq!(code(d.core.read_journal(DEV_B, &ep, C0, Some(0))), SyncCode::BadName);
    assert_eq!(code(d.core.scan(&["..".to_owned()])), SyncCode::BadName);
    assert_eq!(code(append(&d, "..", 1, 0, 10, &["{}"])), SyncCode::BadName);
    assert_eq!(code(append(&d, &ep, 0, 0, 10, &["{}"])), SyncCode::BadName);
    assert_eq!(code(append(&d, &ep, 1, 0, 10, &[])), SyncCode::BadName);
    let bad_hlc = AppendRequest { epoch: ep.clone(), segment: 1, expect_records: 0, sv: 14, max_hlc: "2026".into(), records: vec!["{}".into()] };
    assert_eq!(code(d.core.append_journal(&bad_hlc)), SyncCode::BadName);
    let zero_sv = AppendRequest { sv: 0, max_hlc: hlc(5, DEV_A), ..bad_hlc };
    assert_eq!(code(d.core.append_journal(&zero_sv)), SyncCode::BadName);
    // Toute écriture va dans devices/<appareil lié>/ seulement.
    append(&d, &ep, 1, 0, 10, &["{}"]).unwrap();
    assert!(fs.names().iter().filter(|n| n.contains(".ctj")).all(|n| n.starts_with(&format!("devices/{DEV_A}/"))));
}

#[test]
fn y01_12_scan_reports_headers_states_files_and_availability() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    let first = append(&a, &ep, 1, 0, 10, &["{\"a\":1}", "{\"a\":2}"]).unwrap();
    assert_eq!((first.first_record, first.head), (0, RecordCursor { segment: 1, record: 2 }));
    a.core.write_state(14, state(DEV_A, &ep, 1, 1, 2, Some(hlc(10, DEV_A)))).unwrap();
    let b = other(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.vault.set(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT, &a.vault.get(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    let scan = b.core.scan(&[]).unwrap();
    let dev = &scan.devices[0];
    assert_eq!((dev.device_id.as_str(), dev.state_status), (DEV_A, "ok"));
    assert_eq!(dev.state.as_ref().unwrap().head.record, 2);
    assert_eq!(dev.epochs[0].segments, vec![1]);
    assert!(dev.pending.is_empty());
    assert!(scan.total_bytes > 0 && !scan.incomplete && !scan.too_many_devices);
    // Dossier iCloud : state.ctx et segments annoncés épinglés fichier par fichier, jamais le dossier.
    let pinned = fs.pinned.lock().unwrap().clone();
    assert!(pinned.contains(&format!("devices/{DEV_A}/state.ctx")));
    assert!(pinned.contains(&format!("devices/{DEV_A}/{ep}/j-00000001.ctj")));
    assert!(pinned.iter().all(|p| p.ends_with(".ctx") || p.ends_with(".ctj") || p.ends_with(".cts")));
    // Segment annoncé resté dans le nuage : listé en attente.
    fs.set_availability(&["devices", DEV_A, &ep, "j-00000001.ctj"], Availability::Cloud);
    let scan = b.core.scan(&[]).unwrap();
    assert_eq!(scan.devices[0].pending[0].file, format!("{ep}/j-00000001.ctj"));
    assert_eq!(scan.devices[0].pending[0].availability, "cloud");
}

#[test]
fn y01_12_more_than_sixteen_devices_never_drop_self_or_keep() {
    let (d, fs) = device();
    d.setup(DEV_A);
    fs.mkdir(&["devices", DEV_A]);
    let ids: Vec<String> = (0..20).map(|i| format!("{:08x}-0000-4000-8000-{:012x}", i + 1, i + 1)).collect();
    for id in &ids {
        fs.mkdir(&["devices", id]);
    }
    let keep = vec![ids[0].clone(), ids[1].clone()];
    let scan = d.core.scan(&keep).unwrap();
    assert!(scan.too_many_devices);
    assert_eq!(scan.devices.len(), 16);
    for kept in [DEV_A, &ids[0], &ids[1]] {
        assert!(scan.devices.iter().any(|dev| dev.device_id == kept), "{kept}");
    }
    // Plus de 16 appareils dans `keep` : tous gardés.
    let all: Vec<String> = ids.clone();
    assert_eq!(d.core.scan(&all).unwrap().devices.len(), 21);
}

#[test]
fn y01_12_listing_cut_at_ten_thousand_entries_and_folder_size_limits() {
    let (d, fs) = device();
    d.setup(DEV_A);
    for i in 0..=MAX_SCAN_ENTRIES_PER_FOLDER {
        fs.put(&["devices", &format!("junk-{i}")], b"");
    }
    let scan = d.core.scan(&[]).unwrap();
    assert!(scan.incomplete);
    let (d, fs) = device();
    d.setup(DEV_A);
    fs.put(&["devices", DEV_B, "state.ctx"], b"x");
    fs.set_extra(&["devices", DEV_B, "state.ctx"], 5 * 1024 * 1024 * 1024);
    fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Cloud);
    assert_eq!(code(d.core.scan(&[])), SyncCode::FolderTooLarge);
    assert_eq!(fs.hydrations.load(Ordering::SeqCst), 0, "plus aucune hydratation au-delà de 4 Gio");
}

#[test]
fn y01_13_and_14_bounds_checked_before_hydration_and_cloud_errors_are_not_fatal() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10, &["{}"]).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)))).unwrap();
    // Placeholder qui annonce plus que la borne d'un state.ctx : pas d'hydratation, too-large.
    fs.put(&["devices", DEV_B, "state.ctx"], b"");
    fs.set_extra(&["devices", DEV_B, "state.ctx"], MAX_STATE_FILE_BYTES + 1);
    fs.set_availability(&["devices", DEV_B, "state.ctx"], Availability::Cloud);
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(scan.devices.iter().find(|d| d.device_id == DEV_B).unwrap().state_status, "too-large");
    assert_eq!(fs.hydrations.load(Ordering::SeqCst), 0);
    // state.ctx dans le nuage : hydraté (annoncé par nature).
    fs.set_availability(&["devices", DEV_A, "state.ctx"], Availability::Cloud);
    a.core.scan(&[]).unwrap();
    assert_eq!(fs.hydrations.load(Ordering::SeqCst), 1);
    // Segment annoncé dans le nuage : hydraté à la lecture ; iCloud arrêté ou délai : page « en attente », jamais fatale.
    fs.set_availability(&["devices", DEV_A, &ep, "j-00000001.ctj"], Availability::Cloud);
    *fs.hydrate_error.lock().unwrap() = Some(FsError::ProviderStopped);
    let page = a.core.read_journal(DEV_A, &ep, C0, None).unwrap();
    assert_eq!((page.status, page.records.len()), ("cloud-pending", 0));
    let page = a.core.read_journal(DEV_A, &ep, C0, None).unwrap();
    assert_eq!((page.status, page.records.as_slice()), ("complete", ["{}".to_owned()].as_slice()));
    // Segment au-delà de la borne de lecture : too-large, sans hydratation.
    fs.set_extra(&["devices", DEV_A, &ep, "j-00000001.ctj"], MAX_SEGMENT_BYTES);
    fs.set_availability(&["devices", DEV_A, &ep, "j-00000001.ctj"], Availability::Cloud);
    let hydrations = fs.hydrations.load(Ordering::SeqCst);
    assert_eq!(code(a.core.read_journal(DEV_A, &ep, C0, None)), SyncCode::TooLarge);
    assert_eq!(fs.hydrations.load(Ordering::SeqCst), hydrations);
}

#[test]
fn y01_14_files_beyond_the_head_are_never_hydrated() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10, &["{}"]).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)))).unwrap();
    append(&a, &ep, 2, 0, 20, &["{}"]).unwrap(); // pas encore annoncé
    fs.set_availability(&["devices", DEV_A, &ep, "j-00000002.ctj"], Availability::Cloud);
    let page = a.core.read_journal(DEV_A, &ep, C0, None).unwrap();
    assert_eq!((page.status, page.next), ("complete", RecordCursor { segment: 1, record: 1 }));
    a.core.scan(&[]).unwrap();
    assert_eq!(fs.hydrations.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Journaux : ajout, lecture, cas limites
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y01_13_append_checks_segment_records_and_first_record_is_computed() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    assert_eq!(code(append(&a, &ep, 1, 3, 10, &["{}"])), SyncCode::SegmentMismatch, "segment absent mais 3 enregistrements attendus");
    let r = append(&a, &ep, 1, 0, 10, &["{}", "{}"]).unwrap();
    assert_eq!(r.first_record, 0);
    assert_eq!(code(append(&a, &ep, 1, 1, 20, &["{}"])), SyncCode::SegmentMismatch);
    assert_eq!(append(&a, &ep, 1, 2, 20, &["{}"]).unwrap().first_record, 2);
    // Ligne incomplète en fin de segment : segment-mismatch, le moteur ouvre le suivant.
    let path = ["devices", DEV_A, ep.as_str(), "j-00000001.ctj"];
    let len = fs.get(&path).unwrap().len();
    fs.truncate(&path, len - 10);
    assert_eq!(code(append(&a, &ep, 1, 3, 30, &["{}"])), SyncCode::SegmentMismatch);
    assert_eq!(append(&a, &ep, 2, 0, 30, &["{}"]).unwrap().head, RecordCursor { segment: 2, record: 1 });
    assert_eq!(code(append(&a, &ep, 1, 3, 40, &["{}"])), SyncCode::SegmentMismatch, "jamais en arrière");
    // Le fichier écrit : en-tête en clair, lignes opaques ; aucun texte clair ni nom de table.
    let bytes = fs.get(&["devices", DEV_A, ep.as_str(), "j-00000002.ctj"]).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.starts_with(r#"{"f":"ct-j","sm":1,"kid":""#));
    assert_eq!(text.lines().count(), 2);
}

#[test]
fn y01_13_plaintext_never_reaches_the_folder() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10, &[r#"{"k":"ops","ops":[{"t":"task","f":{"title":["Acheter du pain"]}}]}"#]).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)))).unwrap();
    for (name, bytes) in fs.all_files() {
        let text = String::from_utf8_lossy(&bytes);
        for secret in ["Acheter du pain", "\"task\"", "routine_log", "lastSyncHlc", "appVersion"] {
            assert!(!text.contains(secret), "{name} : {secret}");
        }
    }
}

#[test]
fn y01_13_segment_and_call_limits_match_the_cross_vectors() {
    let vectors: Value = serde_json::from_str(include_str!("../../../tests/fixtures/sync/vectors.json")).unwrap();
    let blocks = |b: u64| format!("\"{}\"", "a".repeat((4096 * b - 4 - 2) as usize));
    let records = |groups: &Value| -> Vec<String> {
        groups.as_array().unwrap().iter().flat_map(|g| std::iter::repeat(blocks(g["blocks"].as_u64().unwrap())).take(g["count"].as_u64().unwrap() as usize)).collect()
    };
    let request = |seg: u64, expect: u64, ms: u64, sv: u64, records: Vec<String>| AppendRequest { epoch: epoch(1, DEV_A), segment: seg, expect_records: expect, sv, max_hlc: hlc(ms, DEV_A), records };
    // Appel de 1 Mio exact : accepté ; 1 Mio + 1 : too-large.
    let (a, fs) = device();
    a.setup(DEV_A);
    let call = &vectors["limits"]["appendCall"];
    assert_eq!(code(a.core.append_journal(&request(1, 0, 10, 1, records(&call["refused"])))), SyncCode::TooLarge);
    a.core.append_journal(&request(1, 0, 10, 1, records(&call["accepted"]))).unwrap();
    // Segment : en-tête + lignes = 1 Mio exact accepté, 1 Mio + 1 refusé (segment-full).
    let s = &vectors["limits"]["segment"];
    let prefix = records(&s["prefix"]);
    let count = prefix.len() as u64;
    a.core.append_journal(&request(2, 0, 20, 1, prefix)).unwrap();
    let path = ["devices", DEV_A, &epoch(1, DEV_A), "j-00000002.ctj"].map(str::to_owned);
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    assert_eq!(fs.get(&path).unwrap().len() as u64, 1024 * 1024 - circletasks_lib::sync::limits::encrypted_line_bytes(4092, 1, 9) as u64);
    let last = vec![blocks(s["last"]["blocks"].as_u64().unwrap())];
    assert_eq!(code(a.core.append_journal(&request(2, count, 30, s["last"]["refusedSv"].as_u64().unwrap(), last.clone()))), SyncCode::SegmentFull);
    a.core.append_journal(&request(2, count, 30, s["last"]["acceptedSv"].as_u64().unwrap(), last.clone())).unwrap();
    assert_eq!(fs.get(&path).unwrap().len() as u64, 1024 * 1024);
    // Segment vide : un enregistrement de 256 Kio passe toujours.
    a.core.append_journal(&request(3, 0, 40, 14, vec![format!("\"{}\"", "a".repeat(256 * 1024 - 2))])).unwrap();
}

#[test]
fn y01_15_hlc_order_and_first_append_of_a_new_epoch() {
    let (a, _) = device();
    a.setup(DEV_A);
    let e1 = epoch(1, DEV_A);
    let e2 = epoch(2, DEV_A);
    append(&a, &e1, 1, 0, 100, &["{}"]).unwrap();
    assert_eq!(code(append(&a, &e1, 1, 1, 100, &["{}"])), SyncCode::HlcOrder);
    assert_eq!(code(append(&a, &e1, 1, 1, 99, &["{}"])), SyncCode::HlcOrder);
    append(&a, &e1, 1, 1, 101, &["{}"]).unwrap();
    // Nouvelle époque : le premier ajout peut porter un maxHlc inférieur.
    append(&a, &e2, 1, 0, 50, &["{}"]).unwrap();
    // Époque antérieure : state-mismatch.
    assert_eq!(code(append(&a, &e1, 2, 0, 200, &["{}"])), SyncCode::StateMismatch);
}

#[test]
fn y01_15_own_json_survives_restart_is_ignored_for_another_key_and_rebuilt_from_acks() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100, &["{}"]).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A)))).unwrap();
    a.restart();
    assert_eq!(code(append(&a, &ep, 1, 1, 100, &["{}"])), SyncCode::HlcOrder, "own.json relu après redémarrage");
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A))))), SyncCode::StateMismatch, "stateSeq non croissant");
    // own.json perdu et state.ctx supprimé : reconstruit depuis les accusés de B sur A et les fichiers listés.
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    fs.remove(&["devices", DEV_A, "state.ctx"]);
    let b = other(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.vault.set(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT, &a.vault.get(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    let mut sb = state(DEV_B, &epoch(1, DEV_B), 1, 0, 0, None);
    sb["acks"] = json!({ DEV_A: { "epoch": ep, "segment": 1, "record": 1, "hlc": hlc(500, DEV_A), "stateSeq": 9 } });
    b.core.write_state(14, sb).unwrap();
    a.restart();
    assert_eq!(code(append(&a, &ep, 1, 1, 500, &["{}"])), SyncCode::HlcOrder, "borne du hlc tirée de l'accusé");
    append(&a, &ep, 1, 1, 501, &["{}"]).unwrap();
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 9, 1, 2, Some(hlc(501, DEV_A))))), SyncCode::StateMismatch, "stateSeq de l'accusé");
    a.core.write_state(14, state(DEV_A, &ep, 10, 1, 2, Some(hlc(501, DEV_A)))).unwrap();
    // own.json d'une autre clé : traité comme absent.
    let own: Value = serde_json::from_slice(&std::fs::read(a.base.path().join("sync").join("own.json")).unwrap()).unwrap();
    assert_eq!(own["stateSeq"], 10);
    let mut foreign = own.clone();
    foreign["kid"] = json!("0000000000000000");
    foreign["stateSeq"] = json!(1_000);
    std::fs::write(a.base.path().join("sync").join("own.json"), serde_json::to_vec(&foreign).unwrap()).unwrap();
    a.restart();
    a.core.write_state(14, state(DEV_A, &ep, 11, 1, 2, Some(hlc(501, DEV_A)))).unwrap();
}

#[test]
fn y01_15_write_state_compares_head_paired_by_and_reserved_fields() {
    let (a, _) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100, &["{}", "{}"]).unwrap();
    for (bad, why) in [
        (state(DEV_A, &ep, 1, 1, 1, Some(hlc(100, DEV_A))), "record"),
        (state(DEV_A, &ep, 1, 2, 2, Some(hlc(100, DEV_A))), "segment"),
        (state(DEV_A, &ep, 1, 1, 2, Some(hlc(99, DEV_A))), "hlc"),
        (state(DEV_B, &ep, 1, 1, 2, Some(hlc(100, DEV_A))), "autre appareil"),
    ] {
        assert_eq!(code(a.core.write_state(14, bad)), SyncCode::StateMismatch, "{why}");
    }
    let mut paired = state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A)));
    paired["pairedBy"] = json!(DEV_B);
    assert_eq!(code(a.core.write_state(14, paired)), SyncCode::StateMismatch, "pairedBy inconnu de Rust");
    let mut forgotten = state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A)));
    forgotten["forgotten"] = json!([{ "deviceId": DEV_B, "at": hlc(1, DEV_A), "lastAck": null }]);
    assert_eq!(code(a.core.write_state(14, forgotten)), SyncCode::StateMismatch);
    let mut reset = state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A)));
    reset["reset"] = json!({ "kid": "0123456789abcdef", "epoch": epoch(2, DEV_A), "at": hlc(1, DEV_A) });
    assert_eq!(code(a.core.write_state(14, reset)), SyncCode::StateMismatch);
    let mut extra = state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A)));
    extra["x"] = json!(1);
    assert_eq!(code(a.core.write_state(14, extra)), SyncCode::BadName);
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 1, 1, 2, Some("x".into())))), SyncCode::BadName);
    assert_eq!(code(a.core.write_state(15, state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A))))), SyncCode::StateMismatch, "sv de l'appel");
    a.core.write_state(14, state(DEV_A, &ep, 1, 1, 2, Some(hlc(100, DEV_A)))).unwrap();
    // Nouvelle époque annoncée avant tout ajout : tête vide ; stateSeq continue (jamais remis à 1).
    let e2 = epoch(2, DEV_A);
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &e2, 1, 0, 0, None))), SyncCode::StateMismatch);
    a.core.write_state(14, state(DEV_A, &e2, 2, 0, 0, None)).unwrap();
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 3, 1, 2, Some(hlc(100, DEV_A))))), SyncCode::StateMismatch, "époque antérieure");
}

#[test]
fn y01_12_reading_edge_cases_cloud_pending_truncated_more_and_rollback() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    let big = format!("\"{}\"", "b".repeat(3000));
    append(&a, &ep, 1, 0, 10, &[&big, &big, &big]).unwrap();
    append(&a, &ep, 2, 0, 20, &["{\"n\":4}"]).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 1, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    // Pages : maxBytes coupe après au moins un enregistrement.
    let page = a.core.read_journal(DEV_A, &ep, C0, Some(4000)).unwrap();
    assert_eq!((page.status, page.records.len(), page.next), ("more", 1, RecordCursor { segment: 1, record: 1 }));
    let page = a.core.read_journal(DEV_A, &ep, page.next, None).unwrap();
    assert_eq!((page.status, page.records.len(), page.next), ("complete", 3, RecordCursor { segment: 2, record: 1 }));
    // Époque autre que celle de la tête : cloud-pending.
    assert_eq!(a.core.read_journal(DEV_A, &epoch(2, DEV_A), C0, None).unwrap().status, "cloud-pending");
    // Segment manquant sous la tête : cloud-pending, jamais sauté.
    let seg1 = ["devices", DEV_A, ep.as_str(), "j-00000001.ctj"];
    let saved = fs.get(&seg1).unwrap();
    fs.remove(&seg1);
    let page = a.core.read_journal(DEV_A, &ep, C0, None).unwrap();
    assert_eq!((page.status, page.next), ("cloud-pending", RecordCursor { segment: 1, record: 0 }));
    // Enregistrement annoncé corrompu : page truncated.
    let mut corrupt = saved.clone();
    let pos = corrupt.len() - 20;
    corrupt[pos] = if corrupt[pos] == b'A' { b'B' } else { b'A' };
    fs.put(&seg1, &corrupt);
    let page = a.core.read_journal(DEV_A, &ep, C0, None).unwrap();
    assert_eq!((page.status, page.records.len()), ("truncated", 2));
    fs.put(&seg1, &saved);
    // state.ctx à ligne incomplète : cloud-pending.
    let state_path = ["devices", DEV_A, "state.ctx"];
    let good_state = fs.get(&state_path).unwrap();
    fs.truncate(&state_path, good_state.len() - 1);
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(scan.devices[0].state_status, "cloud-pending");
    fs.put(&state_path, &good_state);
    // Ancien state.ctx relivré (rejeu) : rollback.
    a.core.write_state(14, state(DEV_A, &ep, 2, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    let b = other(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.vault.set(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT, &a.vault.get(circletasks_lib::sync::service::SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    assert_eq!(b.core.scan(&[]).unwrap().devices[0].state.as_ref().unwrap().state_seq, 2);
    fs.put(&state_path, &good_state);
    let scan = b.core.scan(&[]).unwrap();
    assert_eq!(scan.devices.iter().find(|d| d.device_id == DEV_A).unwrap().state_status, "rollback");
    assert_eq!(code(b.core.read_journal(DEV_A, &ep, C0, None)), SyncCode::Rollback);
    // En-tête qui ne correspond pas au chemin : bad-header.
    let mut moved = saved.clone();
    let header_end = moved.iter().position(|&c| c == b'\n').unwrap();
    let header = String::from_utf8(moved[..header_end].to_vec()).unwrap().replace("\"n\":1", "\"n\":2");
    moved.splice(..header_end, header.into_bytes());
    fs.put(&seg1, &moved);
    a.core.write_state(14, state(DEV_A, &ep, 3, 2, 1, Some(hlc(20, DEV_A)))).unwrap();
    assert_eq!(code(a.core.read_journal(DEV_A, &ep, C0, None)), SyncCode::BadHeader);
}

#[test]
fn y01_12_snapshots_and_own_file_deletion() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10, &["{}"]).unwrap();
    append(&a, &ep, 2, 0, 20, &["{}"]).unwrap();
    let handle = a.core.snapshot_begin(&ep, 1, 14).unwrap();
    a.core.snapshot_append(handle, &["{\"k\":\"snap-rows\"}".to_owned()]).unwrap();
    assert!(fs.get(&["devices", DEV_A, &ep, "s-00000001.cts"]).is_none(), "visible seulement après le dernier appel");
    a.core.snapshot_commit(handle).unwrap();
    assert!(fs.get(&["devices", DEV_A, &ep, "s-00000001.cts"]).is_some());
    assert!(fs.get(&["devices", DEV_A, &ep, "s-00000001.cts.tmp"]).is_none());
    assert_eq!(code(a.core.snapshot_begin(&ep, 1, 14)), SyncCode::SegmentMismatch, "numéro déjà pris");
    let mut s = state(DEV_A, &ep, 1, 2, 1, Some(hlc(20, DEV_A)));
    s["snapshot"] = json!({ "seq": 1, "endHlc": hlc(20, DEV_A) });
    a.core.write_state(14, s).unwrap();
    let page = a.core.read_snapshot(DEV_A, &ep, 1, 0, None).unwrap();
    assert_eq!((page.status, page.records.as_slice()), ("complete", ["{\"k\":\"snap-rows\"}".to_owned()].as_slice()));
    assert_eq!(a.core.read_snapshot(DEV_A, &ep, 2, 0, None).unwrap().status, "cloud-pending", "non annoncé");
    // Suppression : jamais l'époque courante ni son segment de tête ; les segments sous la tête oui.
    let file = |kind: &str, n: Option<u64>| OwnFileRef { epoch: ep.clone(), kind: kind.to_owned(), n };
    assert_eq!(code(a.core.delete_own(&[file("epoch", None)])), SyncCode::CurrentEpoch);
    assert_eq!(code(a.core.delete_own(&[file("j", Some(2))])), SyncCode::CurrentEpoch);
    assert_eq!(code(a.core.delete_own(&[file("x", Some(2))])), SyncCode::BadName);
    assert_eq!(a.core.delete_own(&[file("j", Some(1))]).unwrap(), 1);
    // Ancienne époque : supprimée entière (noms stricts seulement).
    append(&a, &epoch(2, DEV_A), 1, 0, 5, &["{}"]).unwrap();
    fs.put(&["devices", DEV_A, &ep, "notes.txt"], b"etranger");
    assert_eq!(a.core.delete_own(&[OwnFileRef { epoch: ep.clone(), kind: "epoch".into(), n: None }]).unwrap(), 2);
    assert!(fs.get(&["devices", DEV_A, &ep, "notes.txt"]).is_some(), "fichier étranger jamais supprimé");
}

#[test]
fn y01_16_restore_marker_written_only_when_a_folder_is_configured() {
    let (d, _) = device();
    let base = d.base.path();
    assert!(!marker::write_after_restore(base, "circletasks-2026-10-05.db", "2026-10-05T03:00:00.000Z", "2026-10-05T09:00:00.000Z", 14).unwrap());
    assert_eq!(d.core.restore_marker().unwrap(), None);
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert!(marker::write_after_restore(base, "circletasks-2026-10-05.db", "2026-10-05T03:00:00.000Z", "2026-10-05T09:00:00.000Z", 14).unwrap());
    let read = d.core.restore_marker().unwrap().unwrap();
    assert_eq!((read.backup.as_str(), read.schema_version), ("circletasks-2026-10-05.db", 14));
    let raw: Value = serde_json::from_slice(&std::fs::read(base.join("restore-marker.json")).unwrap()).unwrap();
    assert_eq!(raw["v"], 1);
    assert_eq!(serde_json::to_value(&read).unwrap(), json!({ "backup": "circletasks-2026-10-05.db", "backupTakenAt": "2026-10-05T03:00:00.000Z", "restoredAt": "2026-10-05T09:00:00.000Z", "schemaVersion": 14 }));
    d.core.clear_restore_marker().unwrap();
    assert_eq!(d.core.restore_marker().unwrap(), None);
}

#[test]
fn y01_12_device_without_state_reports_its_kid_and_a_third_device_folder() {
    let (a, fs) = device();
    a.setup(DEV_A);
    append(&a, &epoch(1, DEV_A), 1, 0, 10, &["{}"]).unwrap();
    fs.mkdir(&["devices", DEV_C]);
    let scan = a.core.scan(&[]).unwrap();
    let me = scan.devices.iter().find(|d| d.device_id == DEV_A).unwrap();
    assert_eq!((me.state_status, me.kid.as_deref()), ("missing", a.core.key_status().unwrap().kid.as_deref()));
    assert_eq!(scan.devices.iter().find(|d| d.device_id == DEV_C).unwrap().state_status, "missing");
}
