//! Y-TECH-03 (B13 de docs/audit-1.0.md), phase B : le plan de pannes d'iCloud (`tests/fixtures/sync/fault-plan.json`) côté Rust.
//! Lecture stricte (critères 1 et 3), pannes armées par nom et rang d'appel sur `MemFs` et sur le faux du plugin (critères 2, 12 à 15),
//! déterminisme (critère 4). Aucun délai, aucun retry : un rang d'appel et un compteur de cycles seulement.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::bookmark::BookmarkFs;
use circletasks_lib::sync::files::{AppendMode, Availability, FsError, SyncFs};
use serde_json::{json, Map, Value};

use crate::support::fake_bookmark::{FakePlugin, SharedPlugin, BOOKMARK, ROOT};
use crate::support::fault_plan::{self, Effect, Plan};
use crate::sync_support::{MemFs, SharedFs};

const EPOCH: &str = "e0001-0f8fad5b-d9cb-469f-a165-70867728950e";
const S1: [&str; 4] = ["devices", "a", EPOCH, "s-00000001.cts"];
const S2: [&str; 4] = ["devices", "a", EPOCH, "s-00000002.cts"];
const J1: [&str; 4] = ["devices", "a", EPOCH, "j-00000001.ctj"];
const S1_PATH: &str = "devices/a/e0001-0f8fad5b-d9cb-469f-a165-70867728950e/s-00000001.cts";
const J1_PATH: &str = "devices/a/e0001-0f8fad5b-d9cb-469f-a165-70867728950e/j-00000001.ctj";
const DIR: [&str; 3] = ["devices", "a", EPOCH];

fn plan(faults: Value) -> Plan {
    fault_plan::parse_plan(&json!({ "name": "essai", "faults": faults })).expect("plan valide")
}

fn bookmark() -> (Arc<FakePlugin>, BookmarkFs) {
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let plugin = FakePlugin::new(clock.clone());
    let now = clock;
    let fs = BookmarkFs::new(
        Arc::new(SharedPlugin(plugin.clone())),
        ROOT.to_owned(),
        BOOKMARK.to_owned(),
        Arc::new(Mutex::new(None)),
        Arc::new(move || now.load(Ordering::SeqCst)),
    );
    fs.start_cycle().expect("racine joignable");
    (plugin, fs)
}

fn names(fs: &dyn SyncFs) -> Vec<String> {
    let mut out: Vec<String> = fs
        .list(&DIR, 100)
        .expect("listage")
        .entries
        .iter()
        .map(|e| if e.availability == Availability::Cloud { format!("{}~", e.name) } else { e.name.clone() })
        .collect();
    out.sort();
    out
}

// --- Critères 1 et 3 : lecture stricte -----------------------------------------------------------------------------------------------

fn valid_entry() -> Map<String, Value> {
    json!({ "id": "e1", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "error", "code": "io" }).as_object().unwrap().clone()
}

fn refusal(change: impl FnOnce(&mut Map<String, Value>)) -> String {
    let mut entry = valid_entry();
    change(&mut entry);
    fault_plan::parse_plan(&json!({ "name": "essai", "faults": [Value::Object(entry)] })).expect_err("plan refusé")
}

#[test]
fn y_tech_03_1_the_reference_plans_are_read_strictly_with_one_plan_per_effect() {
    let plans = fault_plan::reference_plans();
    let effects: Vec<&Effect> = plans.iter().flat_map(|p| p.faults.iter().map(|e| &e.effect)).collect();
    assert!(effects.iter().any(|e| matches!(e, Effect::Error(_))));
    assert!(effects.iter().any(|e| matches!(e, Effect::AcceptNotPropagated { .. })));
    assert!(effects.iter().any(|e| matches!(e, Effect::EvictAfterRead)));
    assert!(effects.iter().any(|e| matches!(e, Effect::Placeholder)));
    assert!(effects.iter().any(|e| matches!(e, Effect::OverwriteBeforeRead { .. })));
    assert!(effects.iter().any(|e| matches!(e, Effect::DownloadError)));
    assert!(effects.iter().any(|e| matches!(e, Effect::Mute)));
    // Mode historique du plugin : option du plan.
    assert!(fault_plan::reference_plan("exemple-placeholder-historique").remove_leaves_placeholder);
    assert!(!fault_plan::reference_plan("exemple-placeholder").remove_leaves_placeholder);
}

#[test]
fn y_tech_03_3_the_strict_reader_refuses_and_names_the_entry() {
    let cases: Vec<(&str, String, &str)> = vec![
        ("champ inconnu", refusal(|e| drop(e.insert("surprise".into(), json!(1)))), "champ inconnu « surprise »"),
        ("effet inconnu", refusal(|e| drop(e.insert("effect".into(), json!("explode")))), "effet inconnu « explode »"),
        ("opération inconnue", refusal(|e| drop(e.insert("op".into(), json!("chmod")))), "opération inconnue « chmod »"),
        ("rang absent", refusal(|e| drop(e.remove("nth"))), "rang « nth » absent"),
        ("rang nul", refusal(|e| drop(e.insert("nth".into(), json!(0)))), "rang « nth » invalide"),
        ("times invalide", refusal(|e| drop(e.insert("times".into(), json!("souvent")))), "« times » invalide"),
        ("durée delayMs", refusal(|e| drop(e.insert("delayMs".into(), json!(5)))), "champ de durée « delayMs » interdit"),
        ("durée timeoutMs", refusal(|e| drop(e.insert("timeoutMs".into(), json!(5)))), "champ de durée « timeoutMs » interdit"),
        ("durée expiresAt", refusal(|e| drop(e.insert("expiresAt".into(), json!(5)))), "champ de durée « expiresAt » interdit"),
        ("durée wait", refusal(|e| drop(e.insert("wait".into(), json!(5)))), "champ de durée « wait » interdit"),
        ("effet non rejouable sur l'opération", refusal(|e| drop(e.insert("effect".into(), json!("placeholder")))), "non rejouable sur l'opération « remove »"),
        ("code absent", refusal(|e| drop(e.remove("code"))), "« code » attendu"),
        ("code inconnu", refusal(|e| drop(e.insert("code".into(), json!("boom")))), "« code » attendu"),
        ("paramètre en trop", refusal(|e| drop(e.insert("content".into(), json!(["a"])))), "« content » sans objet"),
        ("horodatage dans le chemin", refusal(|e| drop(e.insert("file".into(), json!("devices/a/s-1800000000000.cts")))), "horodatage interdit"),
        ("date ISO dans le chemin", refusal(|e| drop(e.insert("file".into(), json!("devices/a/2026-10-17T10:00/s.cts")))), "horodatage interdit"),
        ("chemin hors devices", refusal(|e| drop(e.insert("file".into(), json!("autre/s.cts")))), "chemin « autre/s.cts » invalide"),
        ("chemin qui remonte", refusal(|e| drop(e.insert("file".into(), json!("devices/../s.cts")))), "invalide"),
        ("dossier pour une suppression", refusal(|e| drop(e.insert("file".into(), json!("devices/a/")))), "désigne un fichier"),
        ("partialLastLine sur une suppression", refusal(|e| drop(e.insert("partialLastLine".into(), json!(true)))), "« partialLastLine » sans objet"),
    ];
    for (what, message, expected) in cases {
        assert!(message.contains(expected), "{what} : « {message} » devrait contenir « {expected} »");
        assert!(message.contains("plan « essai »") && message.contains("entrée « e1 »"), "{what} : le message nomme le plan et l'entrée : {message}");
    }
    // Identifiant absent ou en double, plan sans nom, option inconnue, racine inconnue.
    let two = json!({ "name": "p", "faults": [Value::Object(valid_entry()), Value::Object(valid_entry())] });
    assert!(fault_plan::parse_plan(&two).unwrap_err().contains("« id » en double"));
    assert!(fault_plan::parse_plan(&json!({ "faults": [] })).unwrap_err().contains("« name » absent"));
    assert!(fault_plan::parse_plan(&json!({ "name": "p", "faults": [], "options": { "vite": true } })).unwrap_err().contains("option inconnue « vite »"));
    assert!(fault_plan::parse_plan(&json!({ "name": "p", "faults": [], "timeoutMs": 3 })).unwrap_err().contains("champ de durée « timeoutMs »"));
    assert!(fault_plan::parse_file(&json!({ "schema": 1, "plans": [], "extra": 1 }).to_string()).unwrap_err().contains("champ inconnu « extra »"));
    assert!(fault_plan::parse_file(&json!({ "schema": 2, "plans": [] }).to_string()).unwrap_err().contains("« schema » 1 attendu"));
}

/// Revue I2 : table commune des refus (`tests/fixtures/sync/fault-plan-invalid.json`), lue aussi par `faultPlan.test.ts` : chaque plan est
/// refusé avec exactement le même message des deux côtés.
const INVALID_PLANS: &str = include_str!("../../../tests/fixtures/sync/fault-plan-invalid.json");

#[test]
fn y_tech_03_3_the_shared_refusal_table_gives_the_same_message_as_typescript() {
    let table: Value = serde_json::from_str(INVALID_PLANS).expect("fault-plan-invalid.json");
    let cases = table["cases"].as_array().expect("cases");
    assert!(cases.len() >= 40, "cas de refus : {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let text = case["planText"].as_str().expect("planText");
        let raw: Value = serde_json::from_str(text).unwrap_or_else(|e| panic!("« {name} » : planText illisible ({e})"));
        let message = fault_plan::parse_plan(&raw).expect_err(name);
        assert_eq!(message, case["message"].as_str().expect("message"), "« {name} »");
    }
}

#[test]
fn y_tech_03_3_an_entry_a_fake_cannot_replay_fails_at_arming_and_names_it() {
    let mute = plan(json!([{ "id": "mute-list", "op": "list", "file": "devices/a/", "nth": 1, "effect": "mute" }]));
    for (fake, result) in [("MemFs", MemFs::new().arm(mute.clone())), ("fake_bookmark", FakePlugin::new(Arc::new(AtomicU64::new(0))).arm(mute.clone()))] {
        let message = result.expect_err("mute refusé");
        assert!(message.contains("« essai »") && message.contains("« mute-list »") && message.contains(fake), "{fake} : {message}");
    }
}

// --- Critère 2 : seule la première suppression du fichier désigné échoue ----------------------------------------------------------------

fn remove_io_plan() -> Plan {
    plan(json!([{ "id": "remove-s1", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "error", "code": "io" }]))
}

#[test]
fn y_tech_03_2_only_the_first_removal_of_the_designated_file_fails_on_mem_fs() {
    let mem = MemFs::new();
    mem.put(&S1, b"snap\n");
    mem.put(&S2, b"autre\n");
    mem.arm(remove_io_plan()).unwrap();
    let fs = SharedFs(mem.clone());
    assert_eq!(fs.remove_file(&S2), Ok(true), "un autre fichier se supprime normalement");
    assert_eq!(fs.remove_file(&S1), Err(FsError::Io));
    assert_eq!(fs.remove_file(&S1), Ok(true), "la deuxième suppression du même fichier réussit");
    assert_eq!(mem.unfired(), Vec::<String>::new());
}

#[test]
fn y_tech_03_2_only_the_first_removal_of_the_designated_file_fails_on_the_fake_plugin() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.put(&S2, b"autre\n");
    plugin.arm(remove_io_plan()).unwrap();
    assert_eq!(fs.remove_file(&S2), Ok(true), "un autre fichier se supprime normalement");
    assert_eq!(fs.remove_file(&S1), Err(FsError::Io));
    assert_eq!(fs.remove_file(&S1), Ok(true), "la deuxième suppression du même fichier réussit");
    assert_eq!(plugin.unfired(), Vec::<String>::new());
}

// --- Critère 12 : MemFs ------------------------------------------------------------------------------------------------------------

#[test]
fn y_tech_03_12_mem_fs_remove_file_fails_with_the_armed_code_and_keeps_the_file() {
    for (code, expected) in [("io", FsError::Io), ("cloud-pending", FsError::CloudPending)] {
        let mem = MemFs::new();
        mem.put(&S1, b"snap\n");
        mem.arm(plan(json!([{ "id": "r", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "error", "code": code }]))).unwrap();
        let fs = SharedFs(mem.clone());
        assert_eq!(fs.remove_file(&S1), Err(expected), "{code}");
        assert_eq!(names(&fs), ["s-00000001.cts"], "le fichier reste listé");
        assert_eq!(fs.read(&S1, 100, false), Ok(b"snap\n".to_vec()), "et lisible");
    }
}

#[test]
fn y_tech_03_12_mem_fs_without_a_plan_still_never_fails_a_removal() {
    let mem = MemFs::new();
    mem.put(&S1, b"snap\n");
    let fs = SharedFs(mem);
    assert_eq!(fs.remove_file(&S1), Ok(true));
    assert_eq!(fs.remove_file(&S1), Ok(false));
}

#[test]
fn y_tech_03_12_mem_fs_a_removal_accepted_but_not_propagated_comes_back_after_exactly_n_cycles() {
    for (cycles, back_after) in [(2u64, Some(2usize)), (0, None)] {
        let mem = MemFs::new();
        mem.put(&S1, b"snap\n");
        mem.arm(plan(json!([{ "id": "r", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "accept-not-propagated", "resurrectAfterCycles": cycles }]))).unwrap();
        let fs = SharedFs(mem.clone());
        assert_eq!(fs.remove_file(&S1), Ok(true));
        assert_eq!(names(&fs), Vec::<String>::new());
        for cycle in 1..=3usize {
            mem.advance_cycle();
            let expected = if back_after.is_some_and(|n| cycle >= n) { vec!["s-00000001.cts".to_owned()] } else { Vec::new() };
            assert_eq!(names(&fs), expected, "N = {cycles}, après {cycle} cycle(s)");
        }
        if back_after.is_some() {
            assert_eq!(fs.read(&S1, 100, false), Ok(b"snap\n".to_vec()), "même nom, même contenu");
        }
    }
}

#[test]
fn y_tech_03_12_mem_fs_write_refused_leaves_no_partial_byte_unless_the_plan_asks_for_it() {
    let mem = MemFs::new();
    mem.put(&J1, b"l1\n");
    mem.arm(plan(json!([
        { "id": "w1", "op": "write", "file": J1_PATH, "nth": 1, "effect": "error", "code": "cloud-pending" },
        { "id": "w2", "op": "write", "file": J1_PATH, "nth": 2, "effect": "error", "code": "io", "partialLastLine": true }
    ])))
    .unwrap();
    let fs = SharedFs(mem.clone());
    assert_eq!(fs.append(&J1, b"l2\nl3\n", AppendMode::Existing), Err(FsError::CloudPending));
    assert_eq!(mem.get(&J1), Some(b"l1\n".to_vec()), "aucun octet partiel");
    assert_eq!(fs.append(&J1, b"l2\nl3\n", AppendMode::Existing), Err(FsError::Io));
    assert_eq!(mem.get(&J1), Some(b"l1\nl2\nl".to_vec()), "partialLastLine : lignes complètes, dernière coupée");
}

#[test]
fn y_tech_03_12_mem_fs_a_refused_rename_keeps_the_temporary_file() {
    let mem = MemFs::new();
    mem.put(&["devices", "a", EPOCH, "s-00000001.cts.tmp"], b"snap\n");
    mem.arm(plan(json!([{ "id": "rn", "op": "rename", "file": S1_PATH, "nth": 1, "effect": "error", "code": "io" }]))).unwrap();
    let fs = SharedFs(mem.clone());
    assert_eq!(fs.rename(&DIR, "s-00000001.cts.tmp", "s-00000001.cts"), Err(FsError::Io));
    assert_eq!(names(&fs), ["s-00000001.cts.tmp"]);
    assert_eq!(fs.rename(&DIR, "s-00000001.cts.tmp", "s-00000001.cts"), Ok(()));
    assert_eq!(names(&fs), ["s-00000001.cts"]);
}

// --- Critère 13 : fake_bookmark, substitut, mode correct ---------------------------------------------------------------------------

#[test]
fn y_tech_03_13_the_fake_plugin_lists_the_placeholder_under_the_real_name_in_the_cloud_and_remove_takes_it_away() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.arm(plan(json!([{ "id": "ph", "op": "list", "file": S1_PATH, "nth": 1, "effect": "placeholder" }]))).unwrap();
    assert_eq!(names(&fs), ["s-00000001.cts~"], "substitut listé sous le vrai nom, disponibilité cloud");
    assert!(plugin.has_placeholder(&S1) && plugin.get(&S1).is_none(), "seul le substitut .<nom>.icloud reste dans le dossier");
    assert_eq!(fs.read(&S1, 100, false), Err(FsError::CloudPending), "sans hydratation");
    assert_eq!(fs.remove_file(&S1), Ok(true), "remove du vrai nom");
    assert!(!plugin.has_placeholder(&S1), "supprime aussi le substitut (Y-IOS-02-FIX-02)");
    assert_eq!(names(&fs), Vec::<String>::new());
}

#[test]
fn y_tech_03_13_a_read_with_hydration_downloads_the_placeholder() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.arm(plan(json!([{ "id": "ph", "op": "list", "file": S1_PATH, "nth": 1, "effect": "placeholder" }]))).unwrap();
    assert_eq!(names(&fs), ["s-00000001.cts~"]);
    assert_eq!(fs.read(&S1, 100, true), Ok(b"snap\n".to_vec()), "la lecture déclenche l'hydratation");
    assert_eq!(names(&fs), ["s-00000001.cts"], "puis il est local");
    assert!(!plugin.has_placeholder(&S1));
    assert_eq!(plugin.calls("download").len(), 1);
}

// --- Critère 14 : mode historique --------------------------------------------------------------------------------------------------

#[test]
fn y_tech_03_14_in_historic_mode_the_placeholder_stays_and_the_file_reappears_at_the_next_listing() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    let historic = fault_plan::reference_plan("exemple-placeholder-historique");
    // Le plan de référence vise `devices/*/*/s-00000001.cts` : le dossier `a` / époque convient.
    plugin.arm(historic).unwrap();
    assert_eq!(names(&fs), ["s-00000001.cts~"]);
    assert_eq!(fs.remove_file(&S1), Ok(false), "rien supprimé, sans erreur : le bug du 8 octobre est reproductible");
    assert!(plugin.has_placeholder(&S1), "le substitut reste");
    assert_eq!(names(&fs), ["s-00000001.cts~"], "le fichier réapparaît au listage suivant");
    assert_eq!(fs.remove_file(&S1), Ok(false), "et ce, à chaque cycle");
    // Mode correct, même scénario : la suppression emporte le substitut.
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.arm(fault_plan::reference_plan("exemple-placeholder")).unwrap();
    assert_eq!(names(&fs), ["s-00000001.cts~"]);
    assert_eq!(fs.remove_file(&S1), Ok(true));
    assert_eq!(names(&fs), Vec::<String>::new());
}

#[test]
fn y_tech_03_14_in_historic_mode_mem_fs_leaves_the_evicted_file_too() {
    let mem = MemFs::new();
    mem.put(&S1, b"snap\n");
    mem.arm(fault_plan::reference_plan("exemple-placeholder-historique")).unwrap();
    let fs = SharedFs(mem.clone());
    assert_eq!(names(&fs), ["s-00000001.cts~"]);
    assert_eq!(fs.remove_file(&S1), Ok(false));
    assert_eq!(names(&fs), ["s-00000001.cts~"]);
    assert_eq!(fs.read(&S1, 100, true), Ok(b"snap\n".to_vec()), "hydraté puis local : la suppression réussit");
    assert_eq!(fs.remove_file(&S1), Ok(true));
}

// --- Critère 15 : éviction, écrasement, hydratation en échec, par nom et rang, jamais par le temps ------------------------------------

fn eviction_plan() -> Plan {
    plan(json!([{ "id": "ev", "op": "read", "file": J1_PATH, "nth": 2, "effect": "evict-after-read" }]))
}

#[test]
fn y_tech_03_15_eviction_after_a_read_is_armed_by_name_and_rank_on_both_fakes() {
    let mem = MemFs::new();
    mem.put(&J1, b"l1\n");
    mem.arm(eviction_plan()).unwrap();
    let fs = SharedFs(mem.clone());
    let (plugin, bookmark_fs) = bookmark();
    plugin.put(&J1, b"l1\n");
    plugin.arm(eviction_plan()).unwrap();
    for (fake, fs) in [("MemFs", &fs as &dyn SyncFs), ("fake_bookmark", &bookmark_fs as &dyn SyncFs)] {
        assert_eq!(fs.read(&J1, 100, false), Ok(b"l1\n".to_vec()), "{fake} : rang 1, pas d'éviction");
        assert_eq!(names(fs), ["j-00000001.ctj"], "{fake}");
        assert_eq!(fs.read(&J1, 100, false), Ok(b"l1\n".to_vec()), "{fake} : rang 2, lu puis évincé");
        assert_eq!(names(fs), ["j-00000001.ctj~"], "{fake} : la disponibilité repasse à cloud");
        assert_eq!(fs.read(&J1, 100, false), Err(FsError::CloudPending), "{fake} : une nouvelle lecture suppose une hydratation");
        assert_eq!(fs.read(&J1, 100, true), Ok(b"l1\n".to_vec()), "{fake}");
        assert_eq!(names(fs), ["j-00000001.ctj"], "{fake}");
    }
}

#[test]
fn y_tech_03_15_overwrite_before_read_returns_the_other_devices_content_on_both_fakes() {
    let armed = || plan(json!([{ "id": "ow", "op": "read", "file": J1_PATH, "nth": 1, "effect": "overwrite-before-read", "content": ["autre", "appareil"] }]));
    let mem = MemFs::new();
    mem.put(&J1, b"l1\n");
    mem.arm(armed()).unwrap();
    let fs = SharedFs(mem);
    let (plugin, bookmark_fs) = bookmark();
    plugin.put(&J1, b"l1\n");
    plugin.arm(armed()).unwrap();
    for (fake, fs) in [("MemFs", &fs as &dyn SyncFs), ("fake_bookmark", &bookmark_fs as &dyn SyncFs)] {
        assert_eq!(names(fs), ["j-00000001.ctj"], "{fake}");
        assert_eq!(fs.read(&J1, 100, false), Ok(b"autre\nappareil\n".to_vec()), "{fake} : le contenu de l'autre appareil, pas celui listé");
        assert_eq!(fs.read(&J1, 100, false), Ok(b"autre\nappareil\n".to_vec()), "{fake} : il reste");
        let size = fs.list(&DIR, 100).unwrap().entries[0].size;
        assert_eq!(size, 15, "{fake} : le listage suivant montre la nouvelle taille");
    }
}

#[test]
fn y_tech_03_15_download_error_leaves_the_file_in_the_cloud_until_its_rank_is_past() {
    let armed = || plan(json!([{ "id": "dl", "op": "hydrate", "file": J1_PATH, "nth": 1, "times": 2, "effect": "download-error" }]));
    let mem = MemFs::new();
    mem.put(&J1, b"l1\n");
    mem.set_availability(&J1, Availability::Cloud);
    mem.arm(armed()).unwrap();
    let fs = SharedFs(mem);
    let (plugin, bookmark_fs) = bookmark();
    plugin.put_cloud(&J1, b"l1\n", 0, false);
    plugin.arm(armed()).unwrap();
    for (fake, fs) in [("MemFs", &fs as &dyn SyncFs), ("fake_bookmark", &bookmark_fs as &dyn SyncFs)] {
        assert_eq!(fs.read(&J1, 100, false), Err(FsError::CloudPending), "{fake} : sans hydratation, aucune tentative comptée");
        assert_eq!(fs.read(&J1, 100, true), Err(FsError::CloudError), "{fake} : téléchargement 1 en échec");
        assert_eq!(names(fs), ["j-00000001.ctj~"], "{fake} : reste dans le nuage");
        assert_eq!(fs.read(&J1, 100, true), Err(FsError::CloudError), "{fake} : téléchargement 2, encore couvert par times");
        assert_eq!(fs.read(&J1, 100, true), Ok(b"l1\n".to_vec()), "{fake} : téléchargement 3 réussi");
        assert_eq!(names(fs), ["j-00000001.ctj"], "{fake}");
    }
}

#[test]
fn y_tech_03_15_the_fake_plugin_never_uses_delay_ms_nor_the_clock_for_a_bank_test() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.put(&J1, b"l1\n");
    plugin.put_cloud(&S2, b"snap2\n", 0, false);
    plugin.arm(plan(json!([
        { "id": "ph", "op": "list", "file": S1_PATH, "nth": 1, "effect": "placeholder" },
        { "id": "ev", "op": "read", "file": J1_PATH, "nth": 1, "effect": "evict-after-read" },
        { "id": "dl", "op": "hydrate", "file": "devices/a/e0001-0f8fad5b-d9cb-469f-a165-70867728950e/s-00000002.cts", "nth": 1, "effect": "download-error" }
    ])))
    .unwrap();
    let _ = names(&fs);
    let _ = fs.read(&J1, 100, false);
    let _ = fs.read(&S2, 100, true);
    assert_eq!(plugin.unfired(), Vec::<String>::new());
    plugin.with(|state| {
        for (path, node) in &state.nodes {
            if let crate::support::fake_bookmark::Node::File { delay_ms, .. } = node {
                assert_eq!(*delay_ms, 0, "{path} : delay_ms jamais utilisé par le banc");
            }
        }
    });
    assert_eq!(plugin.clock.load(Ordering::SeqCst), 1_000_000, "l'horloge simulée n'a pas bougé : aucune attente, même simulée");
}

#[test]
fn y_tech_03_15_the_fake_plugin_comes_back_after_exactly_n_cycles() {
    let (plugin, fs) = bookmark();
    plugin.put(&S1, b"snap\n");
    plugin.arm(plan(json!([{ "id": "r", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "accept-not-propagated", "resurrectAfterCycles": 2 }]))).unwrap();
    assert_eq!(fs.remove_file(&S1), Ok(true));
    assert_eq!(names(&fs), Vec::<String>::new());
    assert_eq!(plugin.advance_cycle(), 0);
    assert_eq!(names(&fs), Vec::<String>::new(), "pas encore après 1 cycle");
    assert_eq!(plugin.advance_cycle(), 1);
    assert_eq!(names(&fs), ["s-00000001.cts"], "revenu après exactement 2 cycles");
    assert_eq!(fs.read(&S1, 100, false), Ok(b"snap\n".to_vec()));
}

#[test]
fn y_tech_03_15_the_fake_plugin_write_refused_leaves_no_partial_byte_unless_asked() {
    let (plugin, fs) = bookmark();
    plugin.put(&J1, b"l1\n");
    plugin.arm(plan(json!([
        { "id": "w1", "op": "write", "file": J1_PATH, "nth": 1, "effect": "error", "code": "cloud-pending" },
        { "id": "w2", "op": "write", "file": J1_PATH, "nth": 2, "effect": "error", "code": "io", "partialLastLine": true }
    ])))
    .unwrap();
    assert_eq!(fs.append(&J1, b"l2\nl3\n", AppendMode::Existing), Err(FsError::CloudPending));
    assert_eq!(plugin.get(&J1), Some(b"l1\n".to_vec()));
    assert_eq!(fs.append(&J1, b"l2\nl3\n", AppendMode::Existing), Err(FsError::Io));
    assert_eq!(plugin.get(&J1), Some(b"l1\nl2\nl".to_vec()));
}

// --- Critère 4 : déterminisme, aucun délai -----------------------------------------------------------------------------------------

/// Même plan, même suite d'appels : mêmes résultats et même journal des pannes.
fn run_sequence(fs: &dyn SyncFs, cycle: &dyn Fn()) -> Vec<String> {
    let mut out = Vec::new();
    for _ in 0..2 {
        out.push(format!("{:?}", fs.remove_file(&S1)));
        out.push(format!("{:?}", fs.read(&J1, 100, false)));
        out.push(format!("{:?}", fs.list(&DIR, 100).map(|l| l.entries.iter().map(|e| (e.name.clone(), e.availability == Availability::Cloud)).collect::<Vec<_>>())));
        cycle();
    }
    out
}

fn determinism_plan() -> Plan {
    plan(json!([
        { "id": "r", "op": "remove", "file": S1_PATH, "nth": 1, "effect": "accept-not-propagated", "resurrectAfterCycles": 1 },
        { "id": "e", "op": "read", "file": J1_PATH, "nth": 1, "effect": "evict-after-read" },
        { "id": "p", "op": "list", "file": "devices/a/e0001-0f8fad5b-d9cb-469f-a165-70867728950e/", "nth": 2, "effect": "error", "code": "io" }
    ]))
}

#[test]
fn y_tech_03_4_two_runs_of_the_same_plan_and_calls_give_identical_results_and_logs() {
    let mut runs = Vec::new();
    for _ in 0..2 {
        let mem = MemFs::new();
        mem.put(&S1, b"snap\n");
        mem.put(&J1, b"l1\n");
        mem.arm(determinism_plan()).unwrap();
        let results = run_sequence(&SharedFs(mem.clone()), &|| {
            mem.advance_cycle();
        });
        runs.push((results, mem.fired()));
    }
    assert_eq!(runs[0], runs[1], "MemFs");
    assert!(!runs[0].1.is_empty());
    let mut runs = Vec::new();
    for _ in 0..2 {
        let (plugin, fs) = bookmark();
        plugin.put(&S1, b"snap\n");
        plugin.put(&J1, b"l1\n");
        plugin.arm(determinism_plan()).unwrap();
        let results = run_sequence(&fs, &|| {
            plugin.advance_cycle();
        });
        runs.push((results, plugin.fired()));
    }
    assert_eq!(runs[0], runs[1], "fake_bookmark");
    assert!(!runs[0].1.is_empty());
}

#[test]
fn y_tech_03_4_the_bank_files_contain_no_delay_no_retry_and_no_skipped_test() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("desktop");
    // Les mots interdits sont construits pour que ce fichier ne se désigne pas lui-même.
    let forbidden = [format!("thread::{}", "sleep"), format!("#[{}]", "ignore"), format!("{}(", "retry"), format!("{}(", "sleep"), format!("set{}", "Timeout"), format!("tokio::time::{}", "sleep"), format!("Instant::{}", "now"), format!("SystemTime::{}", "now")];
    for file in ["support/fault_plan.rs", "support/fake_bookmark.rs", "sync_support.rs", "sync_fault_plan.rs", "sync_fs_conformance.rs"] {
        let text = std::fs::read_to_string(root.join(file)).expect("fichier du banc");
        for word in &forbidden {
            assert!(!text.contains(word.as_str()), "{file} contient « {word} »");
        }
    }
}
