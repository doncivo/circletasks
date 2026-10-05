//! Y-08 critères 6, 7, 9, 14, 16, 17 et 18 : clé au coffre, création refusée sur un dossier qui a des données, import (dossier
//! d'abord, clé ensuite), clé jamais écrite ailleurs qu'au coffre, journaux sans secret, attributs du Trousseau, budget de nonces.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use circletasks_lib::sync::crypto::{qr_text_of, MasterKey};
use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::limits::PAIRING_VALIDITY_MS;
use circletasks_lib::sync::service::{KeyInput, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::{log, SyncCode};
use circletasks_lib::vault::SecretVault;
use circletasks_lib::vault_ios::{is_sync_key_account, sync_key_attributes};
use zeroize::Zeroizing;

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, FOLDER};

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

fn vault_key(d: &Device) -> MasterKey {
    MasterKey::from_vault_value(&d.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap()
}

/// Un second appareil sur le même dossier (« iCloud » qui propage tout immédiatement).
fn second(fs: &std::sync::Arc<MemFs>) -> Device {
    Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()))
}

fn publish_state(d: &Device, dev: &str, seq: u64) {
    let state = serde_json::json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": epoch(1, dev), "stateSeq": seq,
        "head": { "epoch": epoch(1, dev), "segment": 0, "record": 0, "hlc": null, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000, dev), "forgotten": [], "reset": null
    });
    d.core.write_state(14, state).expect("état");
}

#[test]
fn y08_6_create_status_and_key_exists() {
    let (d, _) = device();
    assert_eq!(d.core.key_status().unwrap(), circletasks_lib::sync::service::KeyStatus { present: false, kid: None });
    assert_eq!(code(d.core.key_create()), SyncCode::NotConfigured);
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    let kid = d.core.key_create().unwrap();
    assert_eq!(kid.len(), 16);
    let status = d.core.key_status().unwrap();
    assert!(status.present);
    assert_eq!(status.kid.as_deref(), Some(kid.as_str()));
    assert_eq!(code(d.core.key_create()), SyncCode::KeyExists);
    // Valeur du coffre : K en base64, 32 octets ; compte et service fixés.
    let value = d.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap();
    assert_eq!(STANDARD.decode(value).unwrap().len(), 32);
    assert_eq!(SYNC_KEY_ACCOUNT, "circletasks.sync.key.v1");
    assert_eq!(circletasks_lib::vault::VAULT_SERVICE, "fr.circletasks.planner");
}

#[test]
fn y08_6_create_refused_on_a_folder_with_data_even_in_the_cloud() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish_state(&a, DEV_A, 1);
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert_eq!(code(b.core.key_create()), SyncCode::FolderHasData);
    assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None, "aucune clé écrite");
    // Fichier resté dans le nuage : compte aussi comme donnée.
    fs.set_availability(&["devices", DEV_A, "state.ctx"], circletasks_lib::sync::files::Availability::Cloud);
    assert_eq!(code(b.core.key_create()), SyncCode::FolderHasData);
    // Un dossier d'appareil sans fichier ct-* valide n'est pas une donnée.
    let empty = MemFs::new();
    empty.mkdir(&["devices", DEV_B]);
    empty.put(&["devices", DEV_B, "state 2.ctx"], b"copie de conflit");
    let c = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, empty));
    c.core.choose_folder(Path::new(FOLDER)).unwrap();
    assert!(c.core.key_create().is_ok());
}

#[test]
fn y08_7_and_16_key_never_leaves_the_vault_and_logs_hold_no_secret() {
    let _ = log::take_log();
    let (a, fs) = device();
    a.setup(DEV_A);
    publish_state(&a, DEV_A, 1);
    let key = vault_key(&a);
    let raw = qr_text_of(&key, DEV_A, None, 0); // contient K en base64url
    let k_b64 = STANDARD.encode(&*Zeroizing::new(STANDARD.decode(a.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap()));
    let k_url = {
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw.strip_prefix("CTPAIR1.").unwrap()).unwrap();
        serde_json::from_slice::<serde_json::Value>(&json).unwrap()["k"].as_str().unwrap().to_owned()
    };
    let k_bytes = STANDARD.decode(&k_b64).unwrap();
    // Appairage complet : charge utile, import sur un second appareil.
    let payload = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1).unwrap();
    b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1).unwrap();
    let secrets = [k_b64.as_str(), k_url.as_str(), payload.qr_text.as_str(), payload.recovery_key.as_str()];
    // Dossier iCloud : ni la clé, ni sa forme base64, ni le QR.
    for (name, bytes) in fs.all_files() {
        assert!(!bytes.windows(32).any(|w| w == k_bytes.as_slice()), "{name}");
        let text = String::from_utf8_lossy(&bytes);
        for secret in secrets {
            assert!(!text.contains(secret), "{name}");
        }
    }
    // Dossiers de configuration (own.json, usage.json, consent.json, folder.json).
    for base in [a.base.path(), b.base.path()] {
        for entry in walk(base) {
            let bytes = std::fs::read(&entry).unwrap();
            assert!(!bytes.windows(32).any(|w| w == k_bytes.as_slice()), "{}", entry.display());
            let text = String::from_utf8_lossy(&bytes);
            for secret in secrets {
                assert!(!text.contains(secret), "{}", entry.display());
            }
            assert!(!text.contains("CircleTasks") || entry.ends_with("folder.json"), "chemin hors de folder.json : {}", entry.display());
        }
    }
    // Journal technique : aucun secret, aucun chemin complet.
    let lines = log::take_log();
    assert!(lines.iter().any(|l| l.starts_with("sync:key-imported")), "lignes de CE test (journal par fil) : {lines:?}");
    for line in lines {
        for secret in secrets {
            assert!(!line.contains(secret), "{line}");
        }
        assert!(!line.contains(r"C:\"), "{line}");
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn y08_16_errors_never_copy_the_input() {
    let (a, _) = device();
    a.core.choose_folder(Path::new(FOLDER)).unwrap();
    let secret = "CT1-SECRE-TSECR-ETSEC C:\\Users\\Ali";
    let error = a.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(secret.to_owned())), 1).unwrap_err();
    let shown = format!("{error} {error:?} {}", serde_json::to_string(&error).unwrap());
    assert!(!shown.contains("SECRE") && !shown.contains("Users"), "{shown}");
    assert_eq!(serde_json::to_value(error).unwrap(), serde_json::json!({ "code": "invalid-pairing", "message": "synchro" }));
}

#[test]
fn y08_14_import_requires_the_folder_and_a_matching_kid() {
    let (a, fs) = device();
    a.setup(DEV_A);
    let payload = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    let b = second(&fs);
    // Sans dossier : not-configured.
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1)), SyncCode::NotConfigured);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    // Dossier encore vide (aucun state.ctx lisible) : cloud-pending.
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1)), SyncCode::CloudPending);
    publish_state(&a, DEV_A, 1);
    // Clé d'un autre dossier : key-mismatch, rien d'enregistré.
    let stranger = MasterKey::generate().unwrap();
    let wrong = qr_text_of(&stranger, DEV_A, None, a.clock.now() + PAIRING_VALIDITY_MS);
    assert_eq!(code(b.core.key_import(KeyInput::QrText(wrong), 1)), SyncCode::KeyMismatch);
    assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
    // QR expiré de plus de 2 minutes : pairing-expired.
    b.clock.advance(PAIRING_VALIDITY_MS + 2 * 60_000 + 1);
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1)), SyncCode::PairingExpired);
    // Texte invalide : invalid-pairing.
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new("CTPAIR1.xx".into())), 1)), SyncCode::InvalidPairing);
    // Clé de secours valide (au-delà de la limite de 5 appels par 10 minutes) : enregistrée, même kid ; pairedBy inconnu.
    b.clock.advance(10 * 60_000);
    let result = b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1).unwrap();
    assert_eq!(result.kid, a.core.key_status().unwrap().kid.unwrap());
    assert_eq!(result.paired_by, None);
    assert!(vault_key(&b).same_as(&vault_key(&a)));
}

#[test]
fn y08_14_qr_import_sets_paired_by_and_epoch_and_replacing_a_key_asks_first() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish_state(&a, DEV_A, 1);
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    // B a déjà une autre clé : la confirmation « Remplacer la clé ? » est demandée.
    b.vault.set(SYNC_KEY_ACCOUNT, &MasterKey::generate().unwrap().to_vault_value()).unwrap();
    let payload = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    b.ui.answer(false);
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1)), SyncCode::ConsentDenied);
    assert!(!vault_key(&b).same_as(&vault_key(&a)), "refus : clé inchangée");
    assert_eq!(b.ui.prompts(), 1);
    let last = b.ui.last.lock().unwrap().clone().unwrap();
    assert_eq!(last.texts.instruction, "Remplacer la clé de synchronisation de cet appareil ?");
    // Après le refus, 10 minutes de blocage.
    b.ui.answer(true);
    assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1)), SyncCode::RateLimited);
    b.clock.advance(10 * 60_000);
    let fresh = a.core.pairing_payload(b.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    let result = b.core.key_import(KeyInput::QrText(Zeroizing::new(fresh.qr_text.clone())), 1).unwrap();
    assert_eq!(result.paired_by.as_deref(), Some(DEV_A));
    assert_eq!(result.epoch.as_deref(), Some(epoch(1, DEV_A).as_str()), "époque annoncée par A");
    assert!(vault_key(&b).same_as(&vault_key(&a)));
    // Même clé : sans effet, aucune boîte.
    let prompts = b.ui.prompts();
    b.core.key_import(KeyInput::QrText(Zeroizing::new(fresh.qr_text.clone())), 1).unwrap();
    assert_eq!(b.ui.prompts(), prompts);
    // pairedBy mémorisé par Rust (own.json) : un état sans pairedBy est refusé, avec pairedBy accepté.
    let state = |paired: Option<&str>| {
        let mut s = serde_json::json!({
            "deviceId": DEV_B, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": epoch(1, DEV_A), "stateSeq": 1,
            "head": { "epoch": epoch(1, DEV_A), "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 },
            "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(5, DEV_B), "forgotten": [], "reset": null
        });
        if let Some(p) = paired {
            s["pairedBy"] = serde_json::json!(p);
        }
        s
    };
    assert_eq!(code(b.core.write_state(14, state(None))), SyncCode::StateMismatch);
    b.core.write_state(14, state(Some(DEV_A))).unwrap();
}

#[test]
fn y08_14_import_is_limited_to_five_calls_per_ten_minutes_and_needs_the_foreground() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish_state(&a, DEV_A, 1);
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.ui.ready(false);
    assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::ConsentDenied);
    b.ui.ready(true);
    for _ in 0..5 {
        assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::InvalidPairing);
    }
    assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::RateLimited);
    // Compteurs persistés : un redémarrage ne remet rien à zéro.
    let mut b = b;
    b.restart();
    assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::RateLimited);
    b.clock.advance(10 * 60_000);
    assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new("x".into())), 1)), SyncCode::InvalidPairing);
}

#[test]
fn y08_9_foreign_device_is_marked_per_device() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish_state(&a, DEV_A, 1);
    // B écrit avec une autre clé dans le même dossier.
    let b = second(&fs);
    b.core.choose_folder(Path::new(FOLDER)).unwrap();
    b.vault.set(SYNC_KEY_ACCOUNT, &MasterKey::generate().unwrap().to_vault_value()).unwrap();
    b.core.bind_device(DEV_B).unwrap();
    publish_state(&b, DEV_B, 1);
    let scan = a.core.scan(&[]).unwrap();
    let status = |dev: &str| scan.devices.iter().find(|d| d.device_id == dev).unwrap().state_status;
    assert_eq!(status(DEV_A), "ok");
    assert_eq!(status(DEV_B), "foreign", "statut par appareil, l'autre est lu normalement");
    assert_ne!(scan.devices.iter().find(|d| d.device_id == DEV_B).unwrap().kid, scan.devices.iter().find(|d| d.device_id == DEV_A).unwrap().kid);
    // Lecture du journal de l'appareil étranger : key-mismatch, jamais déchiffré.
    assert_eq!(code(a.core.read_journal(DEV_B, &epoch(1, DEV_B), circletasks_lib::sync::store::RecordCursor { segment: 0, record: 0 }, None)), SyncCode::KeyMismatch);
}

#[test]
fn y08_17_keychain_attributes_and_accounts() {
    let attributes = sync_key_attributes();
    assert_eq!(attributes.accessible, "kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    assert!(!attributes.synchronizable);
    assert_eq!(attributes.service, "fr.circletasks.planner");
    assert!(is_sync_key_account("circletasks.sync.key.v1"));
    assert!(is_sync_key_account("circletasks.sync.key.next"));
    assert!(!is_sync_key_account("circletasks.calendar.google.x"));
    assert!(!is_sync_key_account("circletasks.sync.key."));
    assert!(!is_sync_key_account("circletasks.sync.key.V1"));
}

#[test]
fn y08_18_nonce_budget_warns_then_refuses() {
    let fs = MemFs::new();
    let d = Device::with_options(FakeBackend::with(FOLDER, FolderKind::Icloud, fs), |o| {
        o.nonce_warn = 2;
        o.nonce_max = 3;
    });
    d.setup(DEV_A);
    let append = |seg: u64, expect: u64, ms: u64, n: usize| {
        let request = circletasks_lib::sync::service::AppendRequest {
            epoch: epoch(1, DEV_A),
            segment: seg,
            expect_records: expect,
            sv: 14,
            max_hlc: hlc(ms, DEV_A),
            records: vec!["{}".to_owned(); n],
        };
        d.core.append_journal(&request)
    };
    append(1, 0, 10, 2).unwrap();
    assert_eq!(d.core.sealed_records(), 2);
    assert!(!d.core.nonce_warning());
    append(1, 2, 20, 1).unwrap();
    assert!(d.core.nonce_warning(), "alerte au-delà du seuil");
    assert_eq!(code(append(1, 3, 30, 1)), SyncCode::KeyExhausted);
}

#[test]
fn y08_7_calendar_vault_moved_without_behaviour_change() {
    // Les agendas lisent toujours le coffre par `calendars::vault` (réexport) ; même service.
    use circletasks_lib::calendars::vault::{MemoryVault, SecretVault as CalendarVault};
    let vault = MemoryVault::default();
    vault.set("circletasks.calendar.icloud.x", "pw").unwrap();
    assert_eq!(vault.get("circletasks.calendar.icloud.x").unwrap().as_deref(), Some("pw"));
    assert_eq!(circletasks_lib::calendars::VAULT_SERVICE, circletasks_lib::vault::VAULT_SERVICE);
}
