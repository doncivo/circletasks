//! Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : parité de la règle de comptage de `canPublish` (`listedFilesForPublish`, TypeScript) avec
//! `rebuild_own` (Rust, lu sans modification) sur la table commune `tests/fixtures/sync/publish-bound.json`, et écriture de l'état d'un
//! appareil dont `own.json` n'a plus d'époque alors que l'instantané de son orpheline reste listé (état réel de la séance 0.3.2).

use serde_json::{json, Value};

use circletasks_lib::sync::service::AppendRequest;
use circletasks_lib::sync::store::OwnFileRef;

use crate::sync_support::{device, epoch, hlc, Device};

const TABLE: &str = include_str!("../../../tests/fixtures/sync/publish-bound.json");
/// L'appareil local est l'iPhone : son orpheline `e0001-ef50…` est ouverte par lui-même (comme sur l'appareil d'Ali).
const IPHONE: &str = "ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PC: &str = "56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn state(ep: &str, seq: u64) -> Value {
    json!({
        "deviceId": IPHONE, "platform": "windows", "appVersion": "0.3.2", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": seq,
        "head": { "epoch": ep, "segment": 0, "record": 0, "hlc": null, "stateSeq": seq },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(seq * 1_000, IPHONE), "forgotten": [], "reset": null
    })
}

fn snapshot(d: &Device, ep: &str, seq: u64) {
    let handle = d.core.snapshot_begin(ep, seq, 14).unwrap();
    d.core.snapshot_append(handle, &["{\"k\":\"snap-rows\"}".to_owned()]).unwrap();
    d.core.snapshot_commit(handle).unwrap();
}

fn segment(d: &Device, ep: &str, n: u64) {
    let request = AppendRequest { epoch: ep.to_owned(), segment: n, expect_records: 0, sv: 14, max_hlc: hlc(100 * n, IPHONE), records: vec!["{}".to_owned()] };
    d.core.append_journal(&request).unwrap();
}

/// `own.json` perdu (absent s'il n'a jamais été écrit : un instantané seul ne l'écrit pas) ; redémarrage, reconstruction au premier appel.
fn forget_own_json(d: &mut Device) {
    let path = d.base.path().join("sync").join("own.json");
    if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
    d.restart();
}

/// Critère 5 : pour chaque cas qui porte `rustBounds` (époque non courante jamais annoncée), `rebuild_own` retient l'époque (l'état d'une
/// époque plus petite est alors refusé) si et seulement si la règle TypeScript compte un fichier qui borne.
#[test]
fn y_ios_02_fix_02_rebuild_own_matches_the_publish_bound_table() {
    let table: Value = serde_json::from_str(TABLE).unwrap();
    let high = epoch(1, IPHONE);
    let low = epoch(1, PC);
    let mut checked = 0;
    for case in table["cases"].as_array().unwrap() {
        let Some(bounds) = case["rustBounds"].as_bool() else { continue };
        let name = case["name"].as_str().unwrap();
        let listing = &case["epochs"][0];
        assert_eq!((listing["role"].as_str(), listing["announced"].as_bool()), (Some("other"), Some(false)), "{name}");
        let (mut a, _fs) = device();
        a.setup(IPHONE);
        for n in 1..=listing["snapshots"].as_u64().unwrap() {
            snapshot(&a, &high, n);
        }
        for n in 1..=listing["segments"].as_u64().unwrap() {
            segment(&a, &high, n);
        }
        // `own.json` perdu, aucun état, aucun accusé : seul le listing décide.
        forget_own_json(&mut a);
        let written = a.core.write_state(14, state(&low, 1));
        assert_eq!(written.is_err(), bounds, "{name} : {written:?}");
        checked += 1;
    }
    assert!(checked >= 4, "cas de parité lus : {checked}");
}

/// État réel de la séance : `own.json` sans époque après l'abandon, `s-00000001.cts` de l'orpheline toujours listé : `sync_write_state`
/// accepte l'état dans l'époque du PC (tête vide, `stateSeq` 1), puis `sync_delete_own` supprime l'orpheline (non courante). Même résultat
/// quand `own.json` est perdu (reconstruit sans l'orpheline).
#[test]
fn y_ios_02_fix_02_state_is_written_with_the_orphan_snapshot_still_listed() {
    let high = epoch(1, IPHONE);
    let low = epoch(1, PC);
    for lost in [false, true] {
        let (mut a, fs) = device();
        a.setup(IPHONE);
        snapshot(&a, &high, 1);
        // `own.json` désigne l'orpheline (état écrit puis retiré, `stateSeq` remis à 0), puis abandon (§24 point 4 (b)).
        a.core.write_state(14, state(&high, 1)).unwrap();
        fs.remove(&["devices", IPHONE, "state.ctx"]);
        let path = a.base.path().join("sync").join("own.json");
        let mut own: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        own["stateSeq"] = json!(0);
        std::fs::write(&path, serde_json::to_vec(&own).unwrap()).unwrap();
        a.restart();
        a.core.abandon_orphan_epoch(&high).unwrap();
        if lost {
            forget_own_json(&mut a);
        }
        assert!(fs.get(&["devices", IPHONE, &high, "s-00000001.cts"]).is_some());
        a.core.write_state(14, state(&low, 1)).unwrap_or_else(|e| panic!("own.json perdu = {lost} : {e:?}"));
        assert_eq!(a.core.delete_own(&[OwnFileRef { epoch: high.clone(), kind: "epoch".into(), n: None }]).unwrap(), 1);
        assert!(fs.get(&["devices", IPHONE, &high, "s-00000001.cts"]).is_none());
        assert!(fs.get(&["devices", IPHONE, "state.ctx"]).is_some());
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Cause racine (2026-10-16) : fichier évincé par iOS, substitut `.s-00000001.cts.icloud`
// ------------------------------------------------------------------------------------------------------------------------------

const SWIFT: &str = include_str!("../../plugins/folder-bookmark/ios/Sources/FolderBookmarkPlugin.swift");

/// Corps d'une fonction du Swift, de sa déclaration à la fin de son bloc (indentation de la classe).
fn swift_fn(signature: &str) -> &'static str {
    let start = SWIFT.find(signature).unwrap_or_else(|| panic!("{signature} absent"));
    let body = &SWIFT[start..];
    &body[..body.find("\n  }\n").expect("fin de fonction")]
}

/// Y-IOS-02-FIX-02, cause racine : iOS a évincé `s-00000001.cts` de l'orpheline (« Optimiser le stockage ») ; seul reste le substitut
/// `.s-00000001.cts.icloud`, que `list` présente sous le nom réel (disponibilité `cloud`). Avant : `remove` ne trouvait pas le nom réel,
/// répondait « rien supprimé », le dossier restait non vide, `sync_delete_own` rendait 0 et le moteur effaçait le mémo (fichier resté dans
/// iCloud). Contrat Swift attendu, reflété par le faux : supprimer le substitut (coordination `forDeleting`), `removed` vrai ; le dossier
/// d'époque est alors vide et disparaît.
#[test]
fn y_ios_02_fix_02_delete_own_removes_an_evicted_orphan_snapshot_placeholder() {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use circletasks_lib::sync::bookmark::{choose_with_picker, ios_core};
    use circletasks_lib::vault::MemoryVault;

    use crate::support::fake_bookmark::{FakePlugin, SharedPlugin};
    use crate::sync_support::{FakeUi, NOW};

    let base = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    let now = clock.clone();
    let clock_fn: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || now.load(Ordering::SeqCst));
    let (core, backend) = ios_core(base.path().to_path_buf(), Arc::new(SharedPlugin(plugin.clone())), Arc::new(MemoryVault::default()), FakeUi::new(), clock_fn);
    choose_with_picker(&core, &backend).unwrap().expect("dossier choisi");
    core.key_create().unwrap();
    core.bind_device(IPHONE).unwrap();
    let high = epoch(1, IPHONE);
    // L'instantané de l'orpheline, écrit puis évincé : seul le substitut reste.
    let handle = core.snapshot_begin(&high, 1, 14).unwrap();
    core.snapshot_append(handle, &["{\"k\":\"snap-rows\"}".to_owned()]).unwrap();
    core.snapshot_commit(handle).unwrap();
    let file = ["devices", IPHONE, high.as_str(), "s-00000001.cts"];
    let bytes = plugin.get(&file).expect("instantané écrit");
    plugin.with(|s| s.nodes.remove(&file.join("/")));
    plugin.put_evicted(&file, &bytes);
    assert!(plugin.has_placeholder(&file) && plugin.get(&file).is_none());
    // Le scan le voit sous son nom réel (dans le nuage).
    let scan = core.scan(&[]).unwrap();
    let own = scan.devices.iter().find(|d| d.device_id == IPHONE).expect("dossier de l'iPhone listé");
    assert_eq!(serde_json::to_value(own).unwrap()["epochs"][0]["epoch"], json!(high));
    // `sync_delete_own` de l'époque (non courante : own.json sans époque) : substitut supprimé, dossier d'époque disparu, 1 supprimé.
    assert_eq!(core.delete_own(&[OwnFileRef { epoch: high.clone(), kind: "epoch".into(), n: None }]).unwrap(), 1);
    assert!(!plugin.has_placeholder(&file), "substitut supprimé");
    assert!(!plugin.exists(&["devices", IPHONE, high.as_str()]), "dossier d'époque supprimé");
    assert!(plugin.calls("remove").iter().all(|args| !args.to_string().contains(".icloud")), "Rust ne demande que le nom réel");
}

/// Relecture statique du Swift (aucune compilation locale) : `remove` et `removeEmptyDir` sous `forDeleting` ; un fichier absent dont le
/// substitut existe : substitut supprimé (fichier ordinaire, un seul lien physique), `removed` vrai ; aucune chaîne d'interface ni nom de
/// fichier dans une erreur (codes seulement).
#[test]
fn y_ios_02_fix_02_swift_remove_deletes_the_icloud_placeholder_under_for_deleting() {
    let delete = swift_fn("private func coordinatedDelete<T>(");
    assert!(delete.contains("coordinate(writingItemAt: url, options: .forDeleting, error: &coordinationError)"));
    let remove = swift_fn("@objc public func remove(");
    assert!(remove.contains("self.coordinatedDelete(url)") && !remove.contains("coordinatedWrite("));
    assert!(remove.contains("return try self.removePlaceholder(dirFd, name)"));
    assert!(remove.find("errno != ENOENT").unwrap() < remove.find("removePlaceholder").unwrap(), "substitut cherché seulement si le nom réel est absent");
    let stub = swift_fn("private func removePlaceholder(");
    assert!(stub.contains("placeholderName(name)") && stub.contains("AT_SYMLINK_NOFOLLOW"));
    assert!(stub.contains("!isRegular(st.st_mode) || st.st_nlink > 1") && stub.contains("Failure(code: .unsafeFolder)"));
    assert!(stub.contains("unlinkat(dirFd, placeholder, 0)") && stub.contains("return [\"removed\": true]"));
    for body in [delete, stub] {
        // Erreurs en codes seulement (`Failure(code: …)`, un seul argument), jamais un nom interpolé.
        assert_eq!(body.matches("Failure(").count(), body.matches("Failure(code: ").count(), "codes seulement");
        assert!(!body.contains("Failure(code: .io, ") && !body.contains("message:"), "aucun texte");
        assert!(!body.contains(r"\(name)") && !body.contains(r"\(placeholder)"), "aucun nom dans un message");
    }
    let remove_dir = swift_fn("@objc public func removeEmptyDir(");
    assert!(remove_dir.contains("self.coordinatedDelete(url)"));
}
