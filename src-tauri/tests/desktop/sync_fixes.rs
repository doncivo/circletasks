//! Lot Y1, corrections de la revue de code et de l'audit de sécurité : un test par point (S1 à S10, revues 1 à 22).

use std::path::Path;
use std::sync::atomic::Ordering;

use circletasks_lib::sync::crypto::{aad_bytes, qr_text_of, MasterKey, Place};
use circletasks_lib::sync::files::{is_safe_component, Availability, FsError};
use circletasks_lib::sync::folder::{chosen_target, FolderKind};
use circletasks_lib::sync::limits::{MAX_STATE_CANDIDATES, PAIRING_VALIDITY_MS};
use circletasks_lib::sync::pairing::pairing_page_listed;
use circletasks_lib::sync::service::{AppendRequest, KeyInput, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::store::RecordCursor;
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::SecretVault;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, FOLDER};

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

fn state(dev: &str, ep: &str, seq: u64, segment: u64, record: u64, head_hlc: Option<String>) -> Value {
    json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": segment, "record": record, "hlc": head_hlc, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(seq * 1_000, dev), "forgotten": [], "reset": null
    })
}

fn append(d: &Device, ep: &str, segment: u64, expect: u64, ms: u64) -> Result<circletasks_lib::sync::store::AppendResult, SyncError> {
    d.core.append_journal(&AppendRequest { epoch: ep.to_owned(), segment, expect_records: expect, sv: 14, max_hlc: hlc(ms, DEV_A), records: vec!["{}".into()] })
}

fn second(fs: &std::sync::Arc<MemFs>) -> Device {
    Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()))
}

/// S1 : la page `pairing.html` absente (Tauri servirait `index.html`) : refus avant toute boîte et toute fenêtre.
#[test]
fn s1_missing_pairing_page_is_refused_before_any_dialog_or_window() {
    // Audit A2 : présence lue dans les clés des actifs embarqués, jamais par le résolveur (repli sur index.html).
    assert!(!pairing_page_listed(["/index.html", "/capture.html", "/assets/x.js"].into_iter()));
    assert!(!pairing_page_listed(["/pairing.html.map", "/x/pairing.html", "/Pairing.html"].into_iter()));
    assert!(pairing_page_listed(["/index.html", "/pairing.html"].into_iter()));
    assert!(pairing_page_listed(["pairing.html"].into_iter()));
    let commands = include_str!("../../src/sync/commands.rs");
    let available = &commands[commands.find("fn pairing_page_available").unwrap()..];
    let available = &available[..available.find("
}
").unwrap()];
    assert!(available.contains("resolver.iter()") && !available.contains(".get("), "aucun repli, aucune comparaison d'octets");
    let source = include_str!("../../src/sync/commands.rs");
    let check = source.find("pairing_page_available(&page_app)").expect("contrôle de la page");
    let open = source.find("registry.begin_open(").expect("ouverture");
    assert!(check < open, "aucune boîte ni fenêtre avant le contrôle");
}

/// S2 : budget d'entrées par scan ; état lu seulement pour soi, `keep` et 64 candidats ; époques listées pour les seuls retenus.
#[test]
fn s2_scan_reads_states_only_for_candidates_and_lists_epochs_only_for_kept_devices() {
    let (d, fs) = device();
    d.setup(DEV_A);
    d.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    let ids: Vec<String> = (0..100).map(|i| format!("{:08x}-0000-4000-8000-{:012x}", i + 1, i + 1)).collect();
    for id in &ids {
        fs.put(&["devices", id, "state.ctx"], b"x");
        fs.put(&["devices", id, &epoch(1, id), "j-00000001.ctj"], b"x");
    }
    let reads = fs.reads.load(Ordering::SeqCst);
    let scan = d.core.scan(&[]).unwrap();
    let state_reads = fs.reads.load(Ordering::SeqCst) - reads;
    assert!(state_reads <= MAX_STATE_CANDIDATES + 1 + 16, "{state_reads} lectures");
    assert!(scan.incomplete, "candidats au-delà de 64 : scan signalé incomplet");
    assert_eq!(scan.devices.len(), 16);
    assert!(scan.devices.iter().any(|dev| dev.device_id == DEV_A));
    // Époques par appareil plafonnées à 64 (les plus récentes).
    let (d, fs) = device();
    d.setup(DEV_A);
    for n in 1..=70 {
        fs.put(&["devices", DEV_A, &epoch(n, DEV_A), "j-00000001.ctj"], b"x");
    }
    let scan = d.core.scan(&[]).unwrap();
    assert!(scan.incomplete);
    let me = &scan.devices[0];
    assert_eq!(me.epochs.len(), 64);
    assert_eq!(me.epochs.last().unwrap().epoch, epoch(70, DEV_A), "les plus récentes");
}

/// S2 : budget global de 50 000 entrées, puis `incomplete`.
#[test]
fn s2_global_entry_budget_cuts_the_scan() {
    let (d, fs) = device();
    d.setup(DEV_A);
    for dev in 0..6 {
        let id = format!("{:08x}-0000-4000-8000-{:012x}", dev + 1, dev + 1);
        for i in 0..9_500 {
            fs.put(&["devices", &id, &format!("junk-{i}")], b"");
        }
    }
    let scan = d.core.scan(&[]).unwrap();
    assert!(scan.incomplete);
    assert!(scan.ignored <= 50_000);
}

/// S3 (revue 3) : un `.tmp` lien physique vers un autre fichier n'est jamais tronqué ni écrit.
#[cfg(windows)]
#[test]
fn s3_write_atomic_never_truncates_a_hard_linked_temp_file() {
    use circletasks_lib::sync::files::{StdFs, SyncFs};
    use circletasks_lib::sync::folder::{check_sync_path, normalize_final_path};
    let dir = tempfile::tempdir().unwrap();
    let root = std::path::PathBuf::from(normalize_final_path(&std::fs::canonicalize(dir.path()).unwrap().to_string_lossy()).unwrap());
    let folder = root.join("CircleTasks");
    std::fs::create_dir_all(folder.join("devices")).unwrap();
    let victim = root.join("victime.txt");
    std::fs::write(&victim, b"contenu precieux").unwrap();
    std::fs::hard_link(&victim, folder.join("devices").join("state.ctx.tmp")).unwrap();
    let fs = StdFs::new(check_sync_path(&folder).unwrap().path);
    fs.write_atomic(&["devices", "state.ctx"], b"nouvel etat").unwrap();
    assert_eq!(std::fs::read(&victim).unwrap(), b"contenu precieux");
    assert_eq!(std::fs::read(folder.join("devices").join("state.ctx")).unwrap(), b"nouvel etat");
}

/// S4 : un `state.ctx` qui recopie le `kid` en clair mais ne se déchiffre pas avec la clé candidate : `key-mismatch`.
#[test]
fn s4_import_requires_a_state_that_decrypts_with_the_candidate_key() {
    let (a, fs) = device();
    a.setup(DEV_A);
    a.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    let real = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    // Le tiers remplace l'état par un fichier au bon kid (en clair) et au contenu illisible.
    let original = fs.get(&["devices", DEV_A, "state.ctx"]).unwrap();
    let header_end = original.iter().position(|&b| b == b'\n').unwrap();
    let mut forged = original[..=header_end].to_vec();
    forged.extend_from_slice(format!("1.14.{}\n", "A".repeat(5504 - 6)).as_bytes());
    fs.put(&["devices", DEV_A, "state.ctx"], &forged);
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(real.recovery_key.clone())), 1)), SyncCode::KeyMismatch);
    // Un attaquant qui recopie le kid avec SA clé n'est pas accepté non plus.
    let attacker = MasterKey::generate().unwrap();
    assert_eq!(code(b.core.key_import(KeyInput::QrText(qr_text_of(&attacker, DEV_A, None, b.clock.now() + 60_000)), 1)), SyncCode::KeyMismatch);
    assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
    // État authentique de retour : la vraie clé est acceptée.
    fs.put(&["devices", DEV_A, "state.ctx"], &original);
    b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(real.recovery_key.clone())), 1).unwrap();
}

/// S5 (revue 12) : la charge utile est effacée à la destruction ; le QR est analysé sans copie intermédiaire de la clé.
#[test]
fn s5_payload_is_zeroized_and_qr_parsing_keeps_no_intermediate_map() {
    assert!(std::mem::needs_drop::<circletasks_lib::sync::service::PairingPayload>());
    let service = include_str!("../../src/sync/service.rs");
    assert!(service.contains("impl Drop for PairingPayload") && service.contains("zeroize(&mut self.recovery_key)"));
    let crypto = include_str!("../../src/sync/crypto.rs");
    let parse = &crypto[crypto.find("pub fn parse_qr_text").unwrap()..];
    let parse = &parse[..parse.find("\n}\n").unwrap()];
    assert!(!parse.contains("serde_json::Map") && !parse.contains("Value"), "aucune copie intermédiaire");
    // La clé `e` reste obligatoire.
    let key = MasterKey::generate().unwrap();
    let k = {
        let text = qr_text_of(&key, DEV_A, None, 1);
        let json = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, text.strip_prefix("CTPAIR1.").unwrap()).unwrap();
        serde_json::from_slice::<Value>(&json).unwrap()["k"].as_str().unwrap().to_owned()
    };
    let encode = |json: &str| format!("CTPAIR1.{}", base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, json));
    assert!(circletasks_lib::sync::crypto::parse_qr_text(&encode(&format!(r#"{{"v":1,"k":"{k}","d":"{DEV_A}","x":1}}"#))).is_none());
    assert!(circletasks_lib::sync::crypto::parse_qr_text(&encode(&format!(r#"{{"v":1,"k":"{k}","d":"{DEV_A}","e":null,"x":1}}"#))).is_some());
}

/// S7 : un segment déposé (`j-99999999.ctj`, en-tête d'une autre clé ou illisible) ne bloque ni l'ajout ni la reconstruction.
#[test]
fn s7_a_dropped_high_segment_never_blocks_appends_nor_rebuilds() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10).unwrap();
    let real = fs.get(&["devices", DEV_A, &ep, "j-00000001.ctj"]).unwrap();
    let header = String::from_utf8(real[..real.iter().position(|&b| b == b'\n').unwrap()].to_vec()).unwrap();
    // Même kid en clair, numéro maximal, ligne illisible.
    let forged = format!("{}\n1.14.{}\n", header.replace("\"n\":1", "\"n\":99999999"), "A".repeat(5498));
    fs.put(&["devices", DEV_A, &ep, "j-99999999.ctj"], forged.as_bytes());
    fs.put(&["devices", DEV_A, &ep, "j-99999998.ctj"], b"pas d'en-tete");
    append(&a, &ep, 1, 1, 20).unwrap();
    append(&a, &ep, 2, 0, 30).unwrap();
    // own.json perdu : reconstruit depuis le seul segment authentifié.
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    assert_eq!(code(append(&a, &ep, 2, 0, 40)), SyncCode::SegmentMismatch, "tête reconstruite : segment 2, 1 enregistrement");
    let r = append(&a, &ep, 2, 1, 40).unwrap();
    assert_eq!(r.head, RecordCursor { segment: 2, record: 2 });
}

/// S8 (revue 7) : un affichage impossible détruit la fenêtre et efface l'instance.
#[test]
fn s8_show_failure_destroys_the_window_and_clears_the_instance() {
    let source = include_str!("../../src/sync/commands.rs");
    let show = &source[source.find("if window.show().is_err() {").expect("échec de show")..];
    let block = &show[..show.find("return fail(SyncCode::Io);").unwrap()];
    assert!(block.contains("destroy_pairing(app, registry, hwnd);") && block.contains("registry.clear(hwnd);"));
}

/// S9 : oublier la clé puis réimporter la même ne remet pas le budget de nonces à zéro.
#[test]
fn s9_usage_is_kept_when_the_same_key_comes_back() {
    let (a, fs) = device();
    a.setup(DEV_A);
    a.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    append(&a, &epoch(1, DEV_A), 1, 0, 10).unwrap();
    let recovery = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap().recovery_key.clone();
    assert_eq!(a.core.sealed_records(), 2);
    a.core.forget_folder(true, 1).unwrap();
    a.core.choose_folder(Path::new(FOLDER)).unwrap();
    a.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(recovery)), 1).unwrap();
    assert_eq!(a.core.sealed_records(), 2, "même kid : compteur gardé");
    drop(fs);
}

/// S10 : rien n'est créé avant la validation ; choisir « iCloud Drive » lie (et crée) son sous-dossier CircleTasks.
#[test]
fn s10_proposed_folder_is_created_only_after_validation() {
    let drive = Path::new(r"C:\Users\Ali\iCloudDrive");
    assert_eq!(chosen_target(drive, Some(drive)), (drive.join("CircleTasks"), true));
    assert_eq!(chosen_target(Path::new(r"c:\users\ali\iclouddrive\"), Some(drive)).1, true);
    assert_eq!(chosen_target(&drive.join("CircleTasks"), Some(drive)), (drive.join("CircleTasks"), false));
    assert_eq!(chosen_target(Path::new(r"C:\Temp\ct"), None), (Path::new(r"C:\Temp\ct").to_path_buf(), false));
    let source = include_str!("../../src/sync/commands.rs");
    let choose = &source[source.find("pub async fn sync_folder_choose").unwrap()..];
    let choose = &choose[..choose.find("\n}\n").unwrap()];
    let dialog = choose.find("blocking_pick_folder").unwrap();
    let create = choose.find("create_dir").unwrap();
    assert!(dialog < create, "création après la boîte seulement");
}

/// Revue 1 : `sync_folder_info` revalide la racine et rend l'erreur.
#[test]
fn r1_folder_info_revalidates_the_root() {
    let (d, fs) = device();
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    *fs.revalidate_error.lock().unwrap() = Some(FsError::Unsafe);
    assert_eq!(code(d.core.folder_info()), SyncCode::UnsafeFolder);
    *fs.revalidate_error.lock().unwrap() = None;
    assert!(d.core.folder_info().is_ok());
}

/// Revue 2 : `key_create` et `key_import` revalident la racine (nouveau cycle d'hydratation).
#[test]
fn r2_key_create_and_import_revalidate_the_root() {
    let (d, fs) = device();
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    *fs.revalidate_error.lock().unwrap() = Some(FsError::Unreachable);
    assert_eq!(code(d.core.key_create()), SyncCode::FolderUnreachable);
    assert_eq!(code(d.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::FolderUnreachable);
    assert_eq!(d.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
}

/// Revue 4 : propre `state.ctx` présent mais dans le nuage, sans accusé qui borne : `cloud-pending`, rien en cache ; lisible ensuite.
#[test]
fn r4_rebuild_waits_for_its_own_state_in_the_cloud() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A)))).unwrap();
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    fs.set_availability(&["devices", DEV_A, "state.ctx"], Availability::Cloud);
    *fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    assert_eq!(code(append(&a, &ep, 1, 1, 200)), SyncCode::CloudPending);
    assert!(!a.base.path().join("sync").join("own.json").exists(), "rien n'est retenu");
    // Hydraté au cycle suivant : la tête vient de l'état authentifié (hlc 100, stateSeq 5).
    assert_eq!(code(append(&a, &ep, 1, 1, 100)), SyncCode::HlcOrder);
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A))))), SyncCode::StateMismatch);
}

/// Revue 5 : même époque et même numéro qu'un écrivain ouvert refusés ; au plus 4 écrivains ouverts (le plus ancien abandonné).
#[test]
fn r5_snapshot_writers_are_unique_and_capped() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    let first = a.core.snapshot_begin(&ep, 1, 14).unwrap();
    assert_eq!(code(a.core.snapshot_begin(&ep, 1, 14)), SyncCode::SegmentMismatch);
    for seq in 2..=5 {
        a.core.snapshot_begin(&ep, seq, 14).unwrap();
    }
    assert!(fs.get(&["devices", DEV_A, &ep, "s-00000001.cts.tmp"]).is_none(), "le plus ancien est abandonné, .tmp supprimé");
    assert_eq!(code(a.core.snapshot_append(first, &["{}".into()])), SyncCode::BadName);
}

/// Revue 11 : les 37 codes Rust (35, plus `not-foreground`, `already-open` et `window-unprotected` de Y-06) sont exactement `SYNC_ERROR_CODES` de format.ts, dans le même ordre.
#[test]
fn r11_error_codes_match_typescript() {
    let format = include_str!("../../../src/domain/sync/format.ts");
    let start = format.find("export const SYNC_ERROR_CODES = [").unwrap();
    let body = &format[start..start + format[start..].find("] as const").unwrap()];
    let ts: Vec<&str> = body.split('\'').skip(1).step_by(2).collect();
    let rust: Vec<&str> = SyncCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(rust.len(), 38);
    assert_eq!(rust, ts);
}

/// Revue 15 : un instantané lu par pages n'est lu qu'une fois sur le disque.
#[test]
fn r15_snapshot_pages_do_not_reread_the_file() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10).unwrap();
    let handle = a.core.snapshot_begin(&ep, 1, 14).unwrap();
    let big = format!("\"{}\"", "s".repeat(3_000));
    a.core.snapshot_append(handle, &vec![big; 6]).unwrap();
    a.core.snapshot_commit(handle).unwrap();
    let mut s = state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)));
    s["snapshot"] = json!({ "seq": 1, "endHlc": hlc(10, DEV_A) });
    a.core.write_state(14, s).unwrap();
    let snapshot_reads = || fs.reads.load(Ordering::SeqCst);
    let mut from = 0;
    let mut pages = 0;
    let before = snapshot_reads();
    loop {
        let page = a.core.read_snapshot(DEV_A, &ep, 1, from, Some(4_000)).unwrap();
        pages += 1;
        from = page.next.record;
        if page.status != "more" {
            assert_eq!(page.status, "complete");
            break;
        }
    }
    assert_eq!(pages, 6);
    // Une lecture de state.ctx par page (anti-rejeu), une seule de l'instantané.
    assert_eq!(snapshot_reads() - before, pages + 1);
}

/// Revue 16 : état resté dans le nuage : `kid` tiré d'un fichier présent (segment, sinon instantané), comme memory.ts.
#[test]
fn r16_kid_of_a_device_whose_state_is_in_the_cloud() {
    let (a, fs) = device();
    a.setup(DEV_A);
    append(&a, &epoch(1, DEV_A), 1, 0, 10).unwrap();
    a.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 1, 1, Some(hlc(10, DEV_A)))).unwrap();
    fs.set_availability(&["devices", DEV_A, "state.ctx"], Availability::Cloud);
    *fs.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(scan.devices[0].state_status, "cloud-pending");
    assert_eq!(scan.devices[0].kid, a.core.key_status().unwrap().kid);
}

/// Revue 17 : `pairedBy` reçu avant la liaison n'est jamais perdu ; la clé existante est relue sous le verrou.
#[test]
fn r17_paired_by_received_before_binding_is_kept() {
    let (a, fs) = device();
    a.setup(DEV_A);
    a.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    let qr = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap().qr_text.clone();
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.core.key_import(KeyInput::QrText(Zeroizing::new(qr)), 1).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    let mut s = state(DEV_B, &epoch(1, DEV_A), 1, 0, 0, None);
    s["pairedBy"] = json!(DEV_B);
    assert_eq!(code(b.core.write_state(14, s.clone())), SyncCode::StateMismatch, "pairedBy différent de celui de Rust : refusé");
    // Omis : complété par Rust (maître, décision Y-06) avec la valeur reçue avant la liaison.
    s.as_object_mut().unwrap().remove("pairedBy");
    b.core.write_state(14, s).unwrap();
    let scan = a.core.scan(&[]).unwrap();
    let published = scan.devices.iter().find(|d| d.device_id == DEV_B).and_then(|d| d.state.as_ref()).and_then(|s| s.paired_by.clone());
    assert_eq!(published.as_deref(), Some(DEV_A));
    let source = include_str!("../../src/sync/service.rs");
    let create = &source[source.find("pub fn key_create").unwrap()..];
    assert!(create.find("self.lock()").unwrap() < create.find("read_vault_key").unwrap(), "contrôle sous le verrou");
}

/// Revue 18 : budget de nonces contrôlé avant tout chiffrement d'un instantané.
#[test]
fn r18_snapshot_budget_checked_before_sealing() {
    let fs = MemFs::new();
    let d = Device::with_options(FakeBackend::with(FOLDER, FolderKind::Icloud, fs), |o| o.nonce_max = 2);
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    let handle = d.core.snapshot_begin(&ep, 1, 14).unwrap();
    assert_eq!(code(d.core.snapshot_append(handle, &vec!["{}".to_owned(); 3])), SyncCode::KeyExhausted);
    assert_eq!(d.core.sealed_records(), 0);
}

/// Revue 19 : noms de périphérique, point ou espace final, flux, caractères interdits refusés.
#[test]
fn r19_unsafe_path_components_are_refused() {
    for good in ["state.ctx", "j-00000001.ctj", "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "devices", "console.txt", "COM10"] {
        assert!(is_safe_component(good), "{good}");
    }
    for bad in ["", ".", "..", "CON", "con.txt", "NUL", "aux.ctx", "COM1", "lpt9.cts", "COM¹", "CONIN$", "a.", "a ", "a:b", "x::$DATA", "a\\b", "a/b", "a*", "a?", "a|b", "a\u{1}"] {
        assert!(!is_safe_component(bad), "{bad:?}");
    }
    assert!(!is_safe_component(&"a".repeat(256)));
}

/// Revue 20 : un champ d'AAD de plus de 65 535 octets est une erreur, jamais tronqué.
#[test]
fn r20_aad_fields_are_never_truncated() {
    let long = "x".repeat(70_000);
    assert!(aad_bytes(&[long.clone()]).is_none());
    assert_eq!(aad_bytes(&["ct/1".into()]).unwrap(), b"\x00\x04ct/1");
    let key = MasterKey::generate().unwrap();
    let place = Place::Journal { dev: &long, epoch: "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", segment: 1, index: 0 };
    assert!(key.seal(&place, b"{}", 1, 1).is_err());
}

/// Revue B1 (jumeau de `memory.fixes.test.ts`) : propre `state.ctx` remplacé (corrompu) : reconstruction avec le `stateSeq` lu en
/// clair dans l'en-tête du fichier remplacé, puis réécriture possible ; seul un état en transfert fait attendre.
#[test]
fn b1_replaced_own_state_is_rebuilt_from_its_clear_header_and_can_be_rewritten() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A)))).unwrap();
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    let path = ["devices", DEV_A, "state.ctx"];
    let mut bytes = fs.get(&path).unwrap();
    let pos = bytes.len() - 20;
    bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
    fs.put(&path, &bytes);
    append(&a, &ep, 1, 1, 200).unwrap();
    let head = Some(hlc(200, DEV_A));
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 5, 1, 2, head.clone()))), SyncCode::StateMismatch);
    a.core.write_state(14, state(DEV_A, &ep, 6, 1, 2, head)).unwrap();
}

/// Audit A1 : le budget d'entrées est d'abord pour soi et `keep` ; cinq dossiers hostiles de 10 000 entrées, nommés pour passer en
/// premier, ne les rendent pas incomplets.
#[test]
fn a1_self_and_keep_are_listed_before_hostile_folders() {
    let (d, fs) = device();
    d.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&d, &ep, 1, 0, 10).unwrap();
    d.core.write_state(14, state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)))).unwrap();
    fs.put(&["devices", DEV_B, &epoch(1, DEV_B), "j-00000001.ctj"], b"x");
    for i in 0..5 {
        let id = format!("00000000-0000-4000-8000-{i:012}");
        for j in 0..10_000 {
            fs.put(&["devices", &id, &format!("junk-{j}")], b"");
        }
    }
    let scan = d.core.scan(&[DEV_B.to_owned()]).unwrap();
    assert!(scan.incomplete, "les hostiles épuisent le reste du budget");
    let me = scan.devices.iter().find(|x| x.device_id == DEV_A).unwrap();
    assert_eq!((me.state_status, me.epochs.len(), me.epochs[0].segments.len()), ("ok", 1, 1));
    let keep = scan.devices.iter().find(|x| x.device_id == DEV_B).unwrap();
    assert_eq!(keep.epochs.len(), 1, "keep listé avant les dossiers hostiles");
}

/// Audit A3 : 65 dossiers factices ne font pas écarter un appareil en cours d'association (`pairedBy` = soi).
#[test]
fn a3_a_pairing_device_is_never_crowded_out_by_fake_folders() {
    let (a, fs) = device();
    a.setup(DEV_A);
    a.core.write_state(14, state(DEV_A, &epoch(1, DEV_A), 1, 0, 0, None)).unwrap();
    for i in 0..65 {
        fs.put(&["devices", &format!("00000000-0000-4000-8000-{i:012}"), "state.ctx"], b"{\"f\":\"ct-state\"}\nfaux\n");
    }
    // Appareil réel, nommé pour passer en dernier, qui s'associe à A.
    let joiner = "ffffffff-0000-4000-8000-000000000001";
    let qr = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap().qr_text.clone();
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.core.key_import(KeyInput::QrText(Zeroizing::new(qr)), 1).unwrap();
    b.core.bind_device(joiner).unwrap();
    let mut s = state(joiner, &epoch(1, DEV_A), 1, 0, 0, None);
    s["pairedBy"] = json!(DEV_A);
    b.core.write_state(14, s).unwrap();
    let scan = a.core.scan(&[]).unwrap();
    let found = scan.devices.iter().find(|x| x.device_id == joiner).expect("appareil en cours d'association gardé");
    assert_eq!(found.state_status, "ok");
    assert_eq!(scan.devices.len(), 16);
}

/// Audit A4 : 16 faux segments élevés (en-tête d'une autre clé) n'épuisent pas les essais : le segment authentifié est retrouvé.
#[test]
fn a4_fake_high_segments_are_filtered_on_their_header_only() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10).unwrap();
    append(&a, &ep, 2, 0, 20).unwrap();
    let real = fs.get(&["devices", DEV_A, &ep, "j-00000002.ctj"]).unwrap();
    let header = String::from_utf8(real[..real.iter().position(|&b| b == b'\n').unwrap()].to_vec()).unwrap();
    let kid = a.core.key_status().unwrap().kid.unwrap();
    for i in 0..16u32 {
        let n = 99_999_999 - i;
        let fake = header.replace("\"n\":2", &format!("\"n\":{n}")).replace(&kid, "0000000000000000");
        fs.put(&["devices", DEV_A, &ep, &format!("j-{n:08}.ctj")], format!("{fake}\n1.14.{}\n", "A".repeat(5499)).as_bytes());
    }
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    let reads = fs.reads.load(Ordering::SeqCst);
    assert_eq!(code(append(&a, &ep, 2, 0, 30)), SyncCode::SegmentMismatch, "tête reconstruite au segment 2");
    append(&a, &ep, 2, 1, 30).unwrap();
    assert!(fs.reads.load(Ordering::SeqCst) - reads < 16, "les faux segments ne sont jamais lus en entier");
}

/// Revue B4 : `sync_folder_info` recontrôle la racine sans ouvrir de cycle d'hydratation ; scan, création et import de clé en ouvrent un.
#[test]
fn b4_folder_info_checks_the_root_without_starting_a_cycle() {
    let (d, fs) = device();
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    let cycles = || fs.cycles.load(Ordering::SeqCst);
    let before = cycles();
    d.core.folder_info().unwrap();
    d.core.folder_info().unwrap();
    assert_eq!(cycles(), before, "folder_info : racine seulement");
    d.core.key_create().unwrap();
    d.core.bind_device(DEV_A).unwrap();
    d.core.scan(&[]).unwrap();
    assert_eq!(cycles(), before + 2, "création de clé et scan ouvrent chacun un cycle");
}

/// Revue B3 : le cache d'instantané est vidé au début d'un scan (puis au choix du dossier et à l'import de clé).
#[test]
fn b3_snapshot_cache_is_dropped_at_the_start_of_a_scan() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 10).unwrap();
    let handle = a.core.snapshot_begin(&ep, 1, 14).unwrap();
    a.core.snapshot_append(handle, &vec![format!("\"{}\"", "s".repeat(3_000)); 3]).unwrap();
    a.core.snapshot_commit(handle).unwrap();
    let mut s = state(DEV_A, &ep, 1, 1, 1, Some(hlc(10, DEV_A)));
    s["snapshot"] = json!({ "seq": 1, "endHlc": hlc(10, DEV_A) });
    a.core.write_state(14, s).unwrap();
    let snapshot_reads = || fs.reads.load(Ordering::SeqCst);
    let first = a.core.read_snapshot(DEV_A, &ep, 1, 0, Some(4_000)).unwrap();
    assert_eq!(first.status, "more");
    let before = snapshot_reads();
    a.core.read_snapshot(DEV_A, &ep, 1, first.next.record, Some(4_000)).unwrap();
    assert_eq!(snapshot_reads() - before, 1, "page suivante : seul state.ctx est relu");
    a.core.scan(&[]).unwrap();
    let before = snapshot_reads();
    a.core.read_snapshot(DEV_A, &ep, 1, 2, Some(4_000)).unwrap();
    assert_eq!(snapshot_reads() - before, 2, "après un scan : state.ctx et l'instantané relus");
    let service = include_str!("../../src/sync/service.rs");
    assert_eq!(service.matches("inner.snapshot_cache = None;").count(), 3, "choose_folder, scan, key_import");
}

/// Revue B5 : en production, aucun tampon de journal (événement vide) ; la capture n'existe qu'en développement et voit tous les fils
/// (test des secrets : `sync_key.rs`, import fait depuis un fil annexe).
#[test]
fn b5_no_log_buffer_in_production() {
    let source = include_str!("../../src/sync/mod.rs");
    let log = &source[source.find("pub mod log {").unwrap()..];
    assert!(log.contains("#[cfg(not(debug_assertions))]\n    #[inline]\n    pub fn event(_event: &'static str, _detail: &str) {}"));
    for item in ["static SINKS", "pub fn capture()", "pub struct Capture"] {
        let at = log.find(item).unwrap();
        assert!(log[..at].trim_end().ends_with("#[cfg(debug_assertions)]"), "{item} réservé au développement");
    }
}

/// Revue B1, décision 1 (jumeau de `memory.fixes.test.ts`) : son propre `state.ctx` d'un format plus récent n'est jamais réécrit ;
/// l'appareil n'écrit rien (`newer-format`, Y-07 « Mettez à jour l'app »).
#[test]
fn b1_own_state_of_a_newer_format_is_never_rewritten() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A)))).unwrap();
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    let path = ["devices", DEV_A, "state.ctx"];
    let newer = String::from_utf8(fs.get(&path).unwrap()).unwrap().replacen("\"sm\":1", "\"sm\":2", 1);
    fs.put(&path, newer.as_bytes());
    assert_eq!(code(append(&a, &ep, 1, 1, 200)), SyncCode::NewerFormat);
    assert_eq!(code(a.core.write_state(14, state(DEV_A, &ep, 6, 1, 1, Some(hlc(100, DEV_A))))), SyncCode::NewerFormat);
    assert_eq!(fs.get(&path).unwrap(), newer.as_bytes(), "aucune réécriture");
}

/// Revue B1, décision 2 : un numéro d'en-tête en clair au-delà des sources authentifiées + 1 000 000 (ici 2^53 - 1) est ignoré :
/// l'appareil peut toujours réécrire son état.
#[test]
fn b1_an_absurd_clear_header_number_is_ignored() {
    let (mut a, fs) = device();
    a.setup(DEV_A);
    let ep = epoch(1, DEV_A);
    append(&a, &ep, 1, 0, 100).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 5, 1, 1, Some(hlc(100, DEV_A)))).unwrap();
    std::fs::remove_file(a.base.path().join("sync").join("own.json")).unwrap();
    a.restart();
    let path = ["devices", DEV_A, "state.ctx"];
    let forged = String::from_utf8(fs.get(&path).unwrap()).unwrap().replacen("\"n\":5", "\"n\":9007199254740991", 1);
    fs.put(&path, forged.as_bytes());
    append(&a, &ep, 1, 1, 200).unwrap();
    a.core.write_state(14, state(DEV_A, &ep, 6, 1, 2, Some(hlc(200, DEV_A)))).unwrap();
}
