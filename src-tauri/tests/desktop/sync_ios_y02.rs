//! Y-IOS-02 (ADR 0011 §23) : Trousseau (comptes, relecture, erreurs, clé gardée en mémoire), confirmation native de l'iPhone
//! (`IosConsentUi` : textes compilés, « Annuler » par défaut, refus sur erreur, aucune alerte hors du premier plan) et import de la clé
//! depuis `main` (`import_ios` : `qrText`, `recoveryKey`, `scan` refusé), sur le faux du plugin folder-bookmark.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::bookmark::{choose_with_picker, import_ios, ios_core, BookmarkBackend};
use circletasks_lib::sync::consent::{dialog_spec, dialog_spec_with, dialog_texts, ConsentKind, ConsentUi};
use circletasks_lib::sync::consent_ios::{confirm_args, IosConsentUi};
use circletasks_lib::sync::folder::config_dir;
use circletasks_lib::sync::limits::PAIRING_VALIDITY_MS;
use circletasks_lib::sync::service::{SyncCore, IMPORT_FAILURE_FILE, SYNC_KEY_ACCOUNT};
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::{MemoryVault, SecretVault, VaultError};
use circletasks_lib::vault_ios::{
    is_sync_key_account, keychain_delete, keychain_get, keychain_set, read_outcome, CachedVault, KeychainOps, ERR_SEC_INTERACTION_NOT_ALLOWED, ERR_SEC_ITEM_NOT_FOUND,
    SYNC_KEY_ACCOUNTS,
};
use serde_json::{json, Value};

use crate::support::fake_bookmark::{FakePlugin, SharedPlugin};
use crate::sync_support::{epoch, hlc, FakeUi, DEV_A, DEV_B, NOW};

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Trousseau (critères 1 à 4)
// ------------------------------------------------------------------------------------------------------------------------------

/// Faux Trousseau : éléments en mémoire, erreur injectée à la prochaine lecture, relecture altérée.
#[derive(Default)]
struct FakeKeychain {
    items: Mutex<HashMap<String, Vec<u8>>>,
    copy_error: Mutex<Option<i32>>,
    corrupt_reread: AtomicBool,
    deletes: Mutex<Vec<String>>,
}

impl KeychainOps for FakeKeychain {
    fn add(&self, account: &str, secret: &[u8]) -> Result<(), i32> {
        self.items.lock().unwrap().insert(account.to_owned(), secret.to_vec());
        Ok(())
    }
    fn copy(&self, account: &str) -> Result<Vec<u8>, i32> {
        if let Some(code) = *self.copy_error.lock().unwrap() {
            return Err(code);
        }
        let mut bytes = self.items.lock().unwrap().get(account).cloned().ok_or(ERR_SEC_ITEM_NOT_FOUND)?;
        if self.corrupt_reread.load(Ordering::SeqCst) {
            bytes.push(b'!');
        }
        Ok(bytes)
    }
    fn delete(&self, account: &str) -> Result<(), i32> {
        self.deletes.lock().unwrap().push(account.to_owned());
        self.items.lock().unwrap().remove(account).map(|_| ()).ok_or(ERR_SEC_ITEM_NOT_FOUND)
    }
}

#[test]
fn y_ios_02_1_only_the_two_sync_key_accounts_are_accepted() {
    assert_eq!(SYNC_KEY_ACCOUNTS, ["circletasks.sync.key.v1", "circletasks.sync.key.next"]);
    let keychain = FakeKeychain::default();
    for refused in ["circletasks.sync.key.v2", "circletasks.sync.key.", "circletasks.calendar.google.x", "circletasks.sync.key.v1 "] {
        assert!(!is_sync_key_account(refused), "{refused}");
        assert_eq!(keychain_set(&keychain, refused, "x"), Err(VaultError::Unavailable));
        assert_eq!(keychain_get(&keychain, refused), Err(VaultError::Unavailable));
        assert_eq!(keychain_delete(&keychain, refused), Err(VaultError::Unavailable));
    }
    assert!(keychain.items.lock().unwrap().is_empty());
}

#[test]
fn y_ios_02_1_write_is_delete_add_then_identical_reread_or_nothing() {
    let keychain = FakeKeychain::default();
    keychain_set(&keychain, "circletasks.sync.key.v1", "cle-1").unwrap();
    assert_eq!(keychain_get(&keychain, "circletasks.sync.key.v1").unwrap().as_deref(), Some("cle-1"));
    assert_eq!(keychain.deletes.lock().unwrap().as_slice(), ["circletasks.sync.key.v1"], "suppression avant l'ajout");
    // Relecture différente : élément supprimé, `vault-unavailable` (jamais une clé à moitié écrite).
    keychain.corrupt_reread.store(true, Ordering::SeqCst);
    assert_eq!(keychain_set(&keychain, "circletasks.sync.key.next", "cle-2"), Err(VaultError::Unavailable));
    keychain.corrupt_reread.store(false, Ordering::SeqCst);
    assert_eq!(keychain_get(&keychain, "circletasks.sync.key.next").unwrap(), None);
}

#[test]
fn y_ios_02_4_locked_or_failing_keychain_is_unavailable_never_absent() {
    assert_eq!(read_outcome(ERR_SEC_ITEM_NOT_FOUND), Ok(None));
    for failing in [ERR_SEC_INTERACTION_NOT_ALLOWED, -34018, -25291, -1] {
        assert_eq!(read_outcome(failing), Err(VaultError::Unavailable), "{failing}");
    }
    let keychain = FakeKeychain::default();
    keychain_set(&keychain, "circletasks.sync.key.v1", "cle").unwrap();
    *keychain.copy_error.lock().unwrap() = Some(ERR_SEC_INTERACTION_NOT_ALLOWED);
    assert_eq!(keychain_get(&keychain, "circletasks.sync.key.v1"), Err(VaultError::Unavailable), "iPhone verrouillé : jamais « absent »");
    assert_eq!(keychain_delete(&keychain, "circletasks.sync.key.next"), Ok(()), "suppression d'un élément absent : sans erreur");
}

#[test]
fn y_ios_02_3_ios_vault_is_compiled_for_ios_and_keyring_serves_only_calendars() {
    let vault = include_str!("../../src/vault.rs");
    let start = vault.find("pub fn sync_key_vault()").unwrap();
    let body = &vault[start..];
    assert!(body.contains("#[cfg(target_os = \"ios\")]\n    {\n        Box::new(crate::vault_ios::IosSyncKeyVault)"));
    let ios = include_str!("../../src/vault_ios.rs");
    assert!(ios.contains("ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly") && ios.contains("set_access_synchronized(Some(sync_key_attributes().synchronizable))"));
    assert!(!ios.contains("keyring::") && !ios.contains("use keyring"), "la clé de synchro ne passe jamais par keyring");
    for (name, text) in [("lib.rs", include_str!("../../src/lib.rs")), ("sync/service.rs", include_str!("../../src/sync/service.rs")), ("calendars/mod.rs", include_str!("../../src/calendars/mod.rs"))] {
        assert!(!text.contains("keyring::"), "{name}");
    }
    let cargo = include_str!("../../Cargo.toml");
    assert!(cargo.contains("security-framework = { version = \"3\""));
}

/// Coffre dont les lectures peuvent échouer (iPhone verrouillé).
struct LockableVault {
    inner: MemoryVault,
    locked: AtomicBool,
    reads: AtomicU64,
}

impl SecretVault for LockableVault {
    fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
        self.inner.set(account, secret)
    }
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.locked.load(Ordering::SeqCst) {
            return Err(VaultError::Unavailable);
        }
        self.inner.get(account)
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.inner.delete(account)
    }
}

#[test]
fn y_ios_02_4_key_stays_in_memory_once_read_and_errors_are_never_kept() {
    let inner = Arc::new(LockableVault { inner: MemoryVault::default(), locked: AtomicBool::new(true), reads: AtomicU64::new(0) });
    struct Shared(Arc<LockableVault>);
    impl SecretVault for Shared {
        fn set(&self, a: &str, s: &str) -> Result<(), VaultError> {
            self.0.set(a, s)
        }
        fn get(&self, a: &str) -> Result<Option<String>, VaultError> {
            self.0.get(a)
        }
        fn delete(&self, a: &str) -> Result<(), VaultError> {
            self.0.delete(a)
        }
    }
    let cached = CachedVault::new(Box::new(Shared(inner.clone())));
    // Verrouillé au premier usage : indisponible, rien de gardé.
    assert_eq!(cached.get(SYNC_KEY_ACCOUNT), Err(VaultError::Unavailable));
    inner.locked.store(false, Ordering::SeqCst);
    inner.inner.set(SYNC_KEY_ACCOUNT, "cle").unwrap();
    assert_eq!(cached.get(SYNC_KEY_ACCOUNT).unwrap().as_deref(), Some("cle"));
    // Écran verrouillé ensuite : la clé déjà lue reste disponible, sans relire le Trousseau.
    inner.locked.store(true, Ordering::SeqCst);
    let reads = inner.reads.load(Ordering::SeqCst);
    assert_eq!(cached.get(SYNC_KEY_ACCOUNT).unwrap().as_deref(), Some("cle"));
    assert!(cached.contains(SYNC_KEY_ACCOUNT).unwrap());
    assert_eq!(inner.reads.load(Ordering::SeqCst), reads);
    // Écriture et suppression faites par l'app : le cache suit.
    cached.set(SYNC_KEY_ACCOUNT, "cle-2").unwrap();
    assert_eq!(cached.get(SYNC_KEY_ACCOUNT).unwrap().as_deref(), Some("cle-2"));
    cached.delete(SYNC_KEY_ACCOUNT).unwrap();
    assert_eq!(cached.get(SYNC_KEY_ACCOUNT).unwrap(), None);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Confirmation native de l'iPhone (critères 11 et 13)
// ------------------------------------------------------------------------------------------------------------------------------

fn ios_ui() -> (Arc<FakePlugin>, IosConsentUi) {
    let plugin = FakePlugin::new(Arc::new(AtomicU64::new(NOW)));
    let ui = IosConsentUi::new(Arc::new(SharedPlugin(plugin.clone())));
    (plugin, ui)
}

#[test]
fn y_ios_02_11_each_dialog_sends_compiled_texts_cancel_first() {
    let (plugin, ui) = ios_ui();
    let specs = [
        dialog_spec(ConsentKind::ReplaceKey, 0),
        dialog_spec(ConsentKind::EraseKey, 0),
        dialog_spec_with(ConsentKind::ForgetDevice, 0, Some("PC Windows · identifiant 5c6d7e8f…")),
        dialog_spec(ConsentKind::ResetKey, 0),
    ];
    for spec in &specs {
        assert!(ui.ask(spec));
    }
    let calls = plugin.calls("confirm");
    assert_eq!(calls.len(), 4);
    for ((kind, spec), call) in [ConsentKind::ReplaceKey, ConsentKind::EraseKey, ConsentKind::ForgetDevice, ConsentKind::ResetKey].iter().zip(&specs).zip(&calls) {
        let texts = dialog_texts(*kind);
        assert_eq!(call["title"], json!(texts.instruction));
        assert_eq!(call["confirm"], json!(texts.confirm));
        assert_eq!(call["cancel"], json!("Annuler"));
        assert_eq!(call, &confirm_args(spec));
        assert_eq!(spec.owner, 0, "une seule fenêtre sur iPhone");
    }
    assert!(calls[2]["message"].as_str().unwrap().starts_with("PC Windows · identifiant 5c6d7e8f…\n\n"), "détail de Y-10 compris");
    // Jamais « Afficher la clé » sur iPhone : aucune commande de la fenêtre `pairing` n'y existe.
    let lib = include_str!("../../src/lib.rs");
    let ios = &lib[lib.find("#[cfg(target_os = \"ios\")]\n    let builder = builder.invoke_handler").unwrap()..];
    assert!(!ios[..ios.find("]);").unwrap()].contains("sync_pairing_"));
}

#[test]
fn y_ios_02_11_cancel_dismissal_or_plugin_error_is_a_refusal_and_no_alert_outside_the_foreground() {
    let (plugin, ui) = ios_ui();
    let spec = dialog_spec(ConsentKind::ReplaceKey, 0);
    plugin.with(|s| s.confirm_answer = Ok(false));
    assert!(!ui.ask(&spec), "« Annuler » ou alerte fermée au passage en arrière-plan");
    plugin.with(|s| s.confirm_answer = Err("io"));
    assert!(!ui.ask(&spec), "erreur du plugin");
    plugin.with(|s| {
        s.confirm_answer = Ok(true);
        s.app_state = "inactive";
    });
    assert!(!ui.owner_ready(0));
    assert!(!ui.ask(&spec), "Swift refuse hors du premier plan");
    plugin.with(|s| s.app_state = "active");
    assert!(ui.owner_ready(0));
    assert!(ui.ask(&spec));
}

#[test]
fn y_ios_02_13_swift_alert_uses_cancel_style_and_preferred_action_without_any_label() {
    let swift = include_str!("../../plugins/folder-bookmark/ios/Sources/FolderBookmarkPlugin.swift");
    let confirm = &swift[swift.find("@objc public func confirm(_ invoke: Invoke)").unwrap()..];
    let confirm = &confirm[..confirm.find("// MARK:").unwrap()];
    assert!(confirm.contains("preferredStyle: .alert"));
    assert!(confirm.contains("UIAlertAction(title: input.cancel, style: .cancel)"));
    assert!(confirm.contains("UIAlertAction(title: input.confirm, style: .default)"));
    assert!(confirm.contains("alert.preferredAction = cancelAction"));
    assert!(confirm.contains("UIApplication.shared.applicationState != .active"));
    assert!(swift.contains("UIApplication.didEnterBackgroundNotification") && swift.contains("answer(false)"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Import de la clé depuis `main` (critères 5 et 6, chemin JS de §23 point 2)
// ------------------------------------------------------------------------------------------------------------------------------

struct Phone {
    core: Arc<SyncCore>,
    backend: Arc<BookmarkBackend>,
    base: tempfile::TempDir,
}

fn phone(plugin: &Arc<FakePlugin>, clock: &Arc<AtomicU64>, vault: Arc<dyn SecretVault>) -> Phone {
    let base = tempfile::tempdir().unwrap();
    let now = clock.clone();
    let transport = Arc::new(SharedPlugin(plugin.clone()));
    let ui: Arc<dyn ConsentUi> = Arc::new(IosConsentUi::new(transport.clone()));
    let (core, backend) = ios_core(base.path().to_path_buf(), transport, vault, ui, Arc::new(move || now.load(Ordering::SeqCst)));
    Phone { core, backend, base }
}

fn state(dev: &str, ep: &str) -> Value {
    json!({
        "deviceId": dev, "platform": "ios", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": 1,
        "head": { "epoch": ep, "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000, dev), "forgotten": [], "reset": null
    })
}

/// Un premier appareil (le « PC ») sur le même dossier iCloud simulé, qui publie son état ; rend son QR et sa clé de secours.
fn first_device(plugin: &Arc<FakePlugin>, clock: &Arc<AtomicU64>) -> (Phone, String, String) {
    let pc = phone(plugin, clock, Arc::new(MemoryVault::default()));
    choose_with_picker(&pc.core, &pc.backend).unwrap().unwrap();
    pc.core.key_create().unwrap();
    pc.core.bind_device(DEV_A).unwrap();
    pc.core.write_state(14, state(DEV_A, &epoch(1, DEV_A))).unwrap();
    let payload = pc.core.pairing_payload(clock.load(Ordering::SeqCst) + PAIRING_VALIDITY_MS).unwrap();
    (pc, payload.qr_text.clone(), payload.recovery_key.clone())
}

#[test]
fn y_ios_02_5_scanned_text_and_recovery_key_are_imported_from_main_and_scan_true_is_refused() {
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    let (_pc, qr, recovery) = first_device(&plugin, &clock);
    let iphone = phone(&plugin, &clock, Arc::new(MemoryVault::default()));
    // Dossier d'abord (section 10.3).
    assert_eq!(code(import_ios(&iphone.core, Some(qr.clone()), None, None)), SyncCode::NotConfigured);
    choose_with_picker(&iphone.core, &iphone.backend).unwrap().unwrap();
    iphone.core.bind_device(DEV_B).unwrap();
    // `{ scan: true }` (scan lancé par Rust, inexistant) : refusé et inscrit, comme sur PC.
    assert_eq!(code(import_ios(&iphone.core, None, None, Some(true))), SyncCode::InvalidPairing);
    assert!(config_dir(iphone.base.path()).join(IMPORT_FAILURE_FILE).exists());
    assert_eq!(code(import_ios(&iphone.core, Some("CTPAIR1.autre-format".into()), None, None)), SyncCode::InvalidPairing);
    // Texte du QR passé aussitôt par le JS : clé importée, `pairedBy` et époque rendus, jamais la clé.
    let result = import_ios(&iphone.core, Some(qr), None, None).unwrap();
    assert_eq!(result.paired_by.as_deref(), Some(DEV_A));
    assert!(!config_dir(iphone.base.path()).join(IMPORT_FAILURE_FILE).exists(), "échec effacé à la réussite");
    let json = serde_json::to_string(&result).unwrap();
    assert!(!json.contains("CTPAIR1") && !json.contains("CT1-"));
    // Clé de secours, même clé : aucune confirmation (rien à remplacer).
    let before = plugin.calls("confirm").len();
    import_ios(&iphone.core, None, Some(recovery), None).unwrap();
    assert_eq!(plugin.calls("confirm").len(), before);
}

#[test]
fn y_ios_02_6_import_needs_the_foreground_and_replacing_another_key_asks_first() {
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    let (_pc, _qr, recovery) = first_device(&plugin, &clock);
    let vault = Arc::new(MemoryVault::default());
    vault.set(SYNC_KEY_ACCOUNT, &circletasks_lib::sync::crypto::MasterKey::generate().unwrap().to_vault_value()).unwrap();
    let iphone = phone(&plugin, &clock, vault.clone());
    choose_with_picker(&iphone.core, &iphone.backend).unwrap().unwrap();
    iphone.core.bind_device(DEV_B).unwrap();
    let other = iphone.core.key_status().unwrap().kid;
    // Hors du premier plan : `not-foreground`, aucune alerte.
    plugin.with(|s| s.app_state = "background");
    assert_eq!(code(import_ios(&iphone.core, None, Some(recovery.clone()), None)), SyncCode::NotForeground);
    assert!(plugin.calls("confirm").is_empty());
    // Une autre clé est déjà là (audit M8) : alerte ; « Annuler » : clé inchangée, `consent-denied`.
    plugin.with(|s| {
        s.app_state = "active";
        s.confirm_answer = Ok(false);
    });
    assert_eq!(code(import_ios(&iphone.core, None, Some(recovery.clone()), None)), SyncCode::ConsentDenied);
    assert_eq!(plugin.calls("confirm").len(), 1);
    assert_eq!(plugin.calls("confirm")[0]["title"], json!(dialog_texts(ConsentKind::ReplaceKey).instruction));
    assert_eq!(iphone.core.key_status().unwrap().kid, other, "clé inchangée");
    let _ = FakeUi::new();
}
