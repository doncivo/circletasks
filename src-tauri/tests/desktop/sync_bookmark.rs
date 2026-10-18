//! Y-IOS-01 (ADR 0011 §22) : contrat du plugin folder-bookmark (contrôle statique Swift, Rust, fixture), `BookmarkFs` sur le faux du
//! plugin (hydratation et budgets, liens, signet obsolète ou perdu, dossier déplacé), `BookmarkBackend` dans `SyncCore` (`folder.json`,
//! chemin jamais rendu), `sync_scan({ hydrateBudgetMs })`, et lecture en flux de la fin d'un instantané (`read_from`, mémoire bornée).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::ThreadId;
use std::time::Duration;

use circletasks_lib::sync::bookmark::{
    choose_with_picker, deadline_for, ios_core, BookmarkBackend, BookmarkFs, BookmarkTransport, DeadlineLimits, DeadlineTransport, PLUGIN_COMMANDS, PLUGIN_REJECT_CODES, UNBOUNDED_COMMANDS,
};
use circletasks_lib::sync::crypto::{FileHeader, HeaderKind, MasterKey};
use circletasks_lib::sync::files::{AppendMode, Chunk, FsError, Listing, SyncFs};
use circletasks_lib::sync::folder::{config_dir, read_config_file, FolderRecord, FOLDER_FILE};
use circletasks_lib::sync::limits::{MAX_PLUGIN_CHUNK_BYTES, MAX_SNAPSHOT_BYTES};
use circletasks_lib::sync::service::{FolderBackend, SyncCore};
use circletasks_lib::sync::store::{parse_file, stream_last_line, stream_last_line_with, ParseError, StreamHeader};
use circletasks_lib::sync::{SyncCode, SyncError};
use circletasks_lib::vault::MemoryVault;
use serde_json::{json, Value};

use crate::support::fake_bookmark::{FakePlugin, Pick, SharedPlugin, BOOKMARK, CONTRACT, FRESH_BOOKMARK, ROOT};
use crate::sync_support::{epoch, FakeUi, MemFs, SharedFs, DEV_A, NOW};

const SWIFT: &str = include_str!("../../plugins/folder-bookmark/ios/Sources/FolderBookmarkPlugin.swift");
const BOOKMARK_RS: &str = include_str!("../../src/sync/bookmark.rs");
const CONSENT_IOS_RS: &str = include_str!("../../src/sync/consent_ios.rs");
const PLUGIN_LIB: &str = include_str!("../../plugins/folder-bookmark/src/lib.rs");
const PLUGIN_BUILD: &str = include_str!("../../plugins/folder-bookmark/build.rs");
const COMMANDS_IOS_RS: &str = include_str!("../../src/sync/commands_ios.rs");

fn code<T>(result: Result<T, SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 1 : contrat, contrôle statique
// ------------------------------------------------------------------------------------------------------------------------------

/// Lignes du Swift sans commentaires (`//` en début de ligne ou en fin de ligne hors chaîne).
fn swift_code() -> String {
    SWIFT
        .lines()
        .map(|line| {
            let mut in_string = false;
            let bytes = line.as_bytes();
            for i in 0..bytes.len() {
                if bytes[i] == b'"' && (i == 0 || bytes[i - 1] != b'\\') {
                    in_string = !in_string;
                }
                if !in_string && bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
                    return &line[..i];
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Littéraux de chaîne du Swift (hors commentaires).
fn swift_literals() -> Vec<String> {
    let code = swift_code();
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut previous = ' ';
    for c in code.chars() {
        match (&mut current, c) {
            (None, '"') => current = Some(String::new()),
            (Some(text), '"') if previous != '\\' => {
                out.push(std::mem::take(text));
                current = None;
            }
            (Some(text), c) => text.push(c),
            (None, _) => {}
        }
        previous = c;
    }
    out
}

/// Corps de la méthode Swift `name` (jusqu'à la méthode suivante).
fn swift_method(name: &str) -> String {
    let code = swift_code();
    let start = code.find(&format!("@objc public func {name}(_ invoke: Invoke)")).unwrap_or_else(|| panic!("méthode Swift absente : {name}"));
    let rest = &code[start + 1..];
    let end = rest.find("@objc public func ").map_or(rest.len(), |i| i);
    rest[..end].to_owned()
}

/// Champs (`let x:`) d'une structure Swift `Decodable`.
fn swift_struct_fields(name: &str) -> BTreeSet<String> {
    let code = swift_code();
    let start = code.find(&format!("struct {name}: Decodable {{")).unwrap_or_else(|| panic!("structure absente : {name}"));
    let body = &code[start..start + code[start..].find('}').unwrap()];
    body.lines().filter_map(|l| l.trim().strip_prefix("let ")).map(|l| l.split(':').next().unwrap().trim().to_owned()).collect()
}

#[test]
fn y_ios_01_1_every_contract_command_exists_in_swift_and_rust_with_the_same_fields() {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let commands = contract["commands"].as_object().unwrap();
    let rust_commands: BTreeSet<&str> = PLUGIN_COMMANDS.iter().copied().collect();
    // Appels Rust : fichiers (`bookmark.rs`) et confirmation native (`consent_ios.rs`, Y-IOS-02).
    let rust = format!("{BOOKMARK_RS}\n{CONSENT_IOS_RS}");
    for (name, spec) in commands {
        // Swift : méthode exactement nommée (lowerCamelCase, aucune conversion), arguments décodés dans une structure aux champs du contrat.
        let body = swift_method(name);
        let input: BTreeSet<String> = spec["input"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        let decoded = body.split("args(invoke, ").nth(1).map(|rest| rest[..rest.find(".self").unwrap()].to_owned());
        match decoded {
            Some(structure) => assert_eq!(swift_struct_fields(&structure), input, "{name} : champs d'entrée Swift"),
            None => assert!(input.is_empty(), "{name} : aucune structure d'arguments"),
        }
        // Sorties : chaque clé de réponse figure dans le Swift.
        for shape in spec["output"].as_array().unwrap() {
            for key in shape.as_array().unwrap() {
                let key = key.as_str().unwrap();
                assert!(SWIFT.contains(&format!("\"{key}\":")) || SWIFT.contains(&format!("[\"{key}\"]")), "{name} : clé de sortie {key} absente du Swift");
            }
        }
        // Rust : commande appelée par son nom exact, avec les champs du contrat.
        assert!(rust_commands.contains(name.as_str()), "{name} absent de PLUGIN_COMMANDS");
        assert!(rust.contains(&format!("\"{name}\"")), "{name} : jamais appelé par Rust");
        for field in &input {
            assert!(rust.contains(&format!("\"{field}\":")), "{name} : champ {field} absent des appels Rust");
        }
    }
    // Aucune autre méthode `@objc public func … (_ invoke: Invoke)` que celles du contrat.
    let swift_methods: BTreeSet<String> = swift_code()
        .split("@objc public func ")
        .skip(1)
        .filter(|rest| rest.contains("(_ invoke: Invoke)") && rest.find("(_ invoke: Invoke)") < rest.find('\n'))
        .map(|rest| rest[..rest.find('(').unwrap()].to_owned())
        .collect();
    let contract_names: BTreeSet<String> = commands.keys().cloned().collect();
    assert_eq!(swift_methods, contract_names, "méthodes Swift = commandes du contrat");
}

#[test]
fn y_ios_01_1_reject_codes_are_known_sync_error_codes_on_both_sides() {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let codes: BTreeSet<&str> = contract["rejectCodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let known: BTreeSet<&str> = SyncCode::ALL.iter().map(|c| c.as_str()).collect();
    assert!(codes.is_subset(&known), "codes du contrat : tous des SyncErrorCode existants");
    assert_eq!(codes, PLUGIN_REJECT_CODES.iter().copied().collect::<BTreeSet<_>>(), "codes de bookmark.rs = contrat");
    // Swift : l'énumération `Code` n'a que des codes du contrat.
    let code = swift_code();
    let start = code.find("private enum Code: String {").unwrap();
    let body = &code[start..start + code[start..].find('}').unwrap()];
    let swift_codes: BTreeSet<String> = body.lines().filter_map(|l| l.split('"').nth(1)).map(str::to_owned).collect();
    assert_eq!(swift_codes, codes.iter().map(|c| (*c).to_owned()).collect::<BTreeSet<_>>());
    // Tout rejet passe par `reject(invoke, code)` : jamais un message libre.
    assert_eq!(code.matches("invoke.reject(").count(), 1, "un seul appel direct, dans `reject`");
    assert!(code.contains("invoke.reject(code.rawValue, code: code.rawValue)"));
}

#[test]
fn y_ios_01_1_swift_has_no_french_text_nor_label() {
    const FRENCH: [&str; 14] = ["Annuler", "Choisir", "dossier", "Dossier", "clé", "Confirmer", "Synchro", "iCloud Drive /", "Oublier", "Erreur", "erreur", "Valider", "Fermer", "Réglages"];
    for literal in swift_literals() {
        assert!(literal.is_ascii(), "littéral non ASCII dans le Swift : {literal:?}");
        assert!(!literal.contains(' '), "littéral avec espace (libellé ?) dans le Swift : {literal:?}");
        for word in FRENCH {
            assert!(!literal.contains(word), "texte français dans le Swift : {literal:?}");
        }
    }
}

#[test]
fn y_ios_01_1_plugin_exposes_no_command_to_the_webview_and_rust_is_its_only_caller() {
    assert!(PLUGIN_BUILD.contains("const COMMANDS: &[&str] = &[];"), "aucune commande déclarée");
    assert!(PLUGIN_BUILD.contains(".ios_path(\"ios\")"));
    assert!(PLUGIN_LIB.contains("pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String>"));
    assert!(PLUGIN_LIB.contains("run_mobile_plugin"));
    assert!(!PLUGIN_LIB.contains("#[tauri::command]"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// BookmarkFs sur le faux du plugin
// ------------------------------------------------------------------------------------------------------------------------------

struct Rig {
    plugin: Arc<FakePlugin>,
    clock: Arc<AtomicU64>,
    refreshed: Arc<Mutex<Option<String>>>,
    fs: BookmarkFs,
}

fn rig() -> Rig {
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    let refreshed = Arc::new(Mutex::new(None));
    let now = clock.clone();
    let fs = BookmarkFs::new(Arc::new(SharedPlugin(plugin.clone())), ROOT.to_owned(), BOOKMARK.to_owned(), refreshed.clone(), Arc::new(move || now.load(Ordering::SeqCst)));
    Rig { plugin, clock, refreshed, fs }
}

#[test]
fn y_ios_01_not_configured_triggers_one_resolve_then_one_retry() {
    let r = rig();
    r.plugin.mkdir(&["devices"]);
    // Racine pas encore résolue dans la session du plugin (premier appel de la session).
    assert_eq!(r.fs.list(&["devices"], 10).unwrap(), Listing::default());
    let calls: Vec<String> = r.plugin.state.lock().unwrap().calls.iter().map(|(c, _)| c.clone()).collect();
    assert_eq!(calls, ["list", "resolve", "list"]);
    // Résolution impossible : injoignable, sans nouvel essai.
    r.plugin.with(|s| {
        s.session = false;
        s.invalid = true;
        s.calls.clear();
    });
    assert_eq!(r.fs.list(&["devices"], 10), Err(FsError::Unreachable));
    assert_eq!(r.plugin.calls("list").len(), 1);
}

#[test]
fn y_ios_01_3_cloud_file_is_downloaded_within_sixty_seconds_then_read() {
    let r = rig();
    r.fs.start_cycle().unwrap();
    r.plugin.put_cloud(&["devices", "a", "state.ctx"], b"etat", 30_000, false);
    assert_eq!(r.fs.read(&["devices", "a", "state.ctx"], 100, false), Err(FsError::CloudPending), "jamais d'hydratation sans demande");
    assert!(r.plugin.calls("download").is_empty());
    assert_eq!(r.fs.read(&["devices", "a", "state.ctx"], 100, true).unwrap(), b"etat");
    let download = &r.plugin.calls("download")[0];
    assert_eq!(download["timeoutMs"], json!(60_000), "60 s par fichier");
    assert_eq!(download["limit"], json!(100), "borne transmise : rien au-delà n'est téléchargé");
}

#[test]
fn y_ios_01_3_download_timeout_error_and_cycle_budget() {
    let r = rig();
    r.fs.start_cycle().unwrap();
    r.plugin.put_cloud(&["devices", "a", "e1", "s-00000001.cts"], b"lent", 70_000, false);
    r.plugin.put_cloud(&["devices", "b", "state.ctx"], b"erreur", 0, true);
    assert_eq!(r.fs.read(&["devices", "a", "e1", "s-00000001.cts"], 100, true), Err(FsError::CloudPending), "délai de 60 s dépassé");
    assert_eq!(r.fs.read(&["devices", "b", "state.ctx"], 100, true), Err(FsError::CloudError), "erreur d'iCloud");
    // Budget de 3 minutes par cycle : 60 s déjà consommées ; deux téléchargements de 55 s, puis il reste 10 s.
    for dev in ["c", "d"] {
        r.plugin.put_cloud(&["devices", dev, "state.ctx"], b"ok", 55_000, false);
        assert_eq!(r.fs.read(&["devices", dev, "state.ctx"], 100, true).unwrap(), b"ok");
    }
    r.plugin.put_cloud(&["devices", "e", "state.ctx"], b"trop tard", 15_000, false);
    assert_eq!(r.fs.read(&["devices", "e", "state.ctx"], 100, true), Err(FsError::CloudPending));
    assert_eq!(r.plugin.calls("download").last().unwrap()["timeoutMs"], json!(10_000), "jamais au-delà du reste du budget");
    // Budget épuisé : plus aucun téléchargement demandé.
    let before = r.plugin.calls("download").len();
    assert_eq!(r.fs.read(&["devices", "e", "state.ctx"], 100, true), Err(FsError::CloudPending));
    assert_eq!(r.plugin.calls("download").len(), before);
    // Nouveau cycle : budget rétabli.
    r.fs.start_cycle().unwrap();
    assert_eq!(r.fs.read(&["devices", "e", "state.ctx"], 100, true).unwrap(), b"trop tard");
}

#[test]
fn y_ios_01_3_reduced_cycle_budget_bounds_every_download() {
    let r = rig();
    r.fs.start_cycle_within(std::time::Duration::from_millis(12_000)).unwrap();
    r.plugin.put_cloud(&["devices", "a", "state.ctx"], b"etat", 20_000, false);
    assert_eq!(r.fs.read(&["devices", "a", "state.ctx"], 100, true), Err(FsError::CloudPending));
    assert_eq!(r.plugin.calls("download")[0]["timeoutMs"], json!(12_000));
    // Un budget au-delà de 3 minutes est ramené à 3 minutes.
    r.fs.start_cycle_within(std::time::Duration::from_secs(3_600)).unwrap();
    assert_eq!(r.fs.read(&["devices", "a", "state.ctx"], 100, true).unwrap(), b"etat");
    let _ = &r.clock;
}

#[test]
fn y_ios_01_4_links_replaced_components_and_paths_outside_the_root_are_refused_before_any_io() {
    let r = rig();
    r.fs.start_cycle().unwrap();
    r.plugin.put(&["devices", "a", "state.ctx"], b"etat");
    r.plugin.link(&["devices", "b"]);
    assert_eq!(r.fs.read(&["devices", "b", "state.ctx"], 100, false), Err(FsError::Unsafe));
    assert_eq!(r.fs.append(&["devices", "b", "x.ctj"], b"x", AppendMode::CreateNew), Err(FsError::Unsafe));
    assert!(r.plugin.get(&["devices", "b", "x.ctj"]).is_none(), "rien d'écrit");
    // Composant remplacé par un lien entre deux appels.
    assert_eq!(r.fs.read(&["devices", "a", "state.ctx"], 100, false).unwrap(), b"etat");
    r.plugin.link(&["devices", "a"]);
    assert_eq!(r.fs.write_atomic(&["devices", "a", "state.ctx"], b"pirate"), Err(FsError::Unsafe));
    // Sortie de la racine : refusée par Rust avant tout appel au plugin.
    r.plugin.with(|s| s.calls.clear());
    for bad in [&["devices", "..", "x"][..], &["devices", "a/b"], &["."], &["devices", ""], &[]] {
        assert_eq!(r.fs.read(bad, 100, false), Err(FsError::Unsafe), "{bad:?}");
        assert_eq!(r.fs.write_atomic(bad, b"x"), Err(FsError::Unsafe), "{bad:?}");
    }
    assert!(r.plugin.state.lock().unwrap().calls.is_empty(), "aucun appel au plugin");
}

#[test]
fn y_ios_01_large_pages_are_split_into_calls_of_one_mebibyte_at_most() {
    let r = rig();
    r.fs.start_cycle().unwrap();
    r.plugin.mkdir(&["devices", "a", "e1"]);
    let big = vec![b'x'; MAX_PLUGIN_CHUNK_BYTES * 2 + 10];
    r.fs.append(&["devices", "a", "e1", "s-00000001.cts.tmp"], &big, AppendMode::CreateNew).unwrap();
    let appends = r.plugin.calls("append");
    assert_eq!(appends.len(), 3);
    assert_eq!(appends.iter().map(|a| a["createNew"].as_bool().unwrap()).collect::<Vec<_>>(), [true, false, false]);
    assert_eq!(r.fs.read(&["devices", "a", "e1", "s-00000001.cts.tmp"], u64::MAX, false).unwrap(), big);
    assert!(r.plugin.calls("readFrom").iter().all(|c| c["max"].as_u64().unwrap() <= MAX_PLUGIN_CHUNK_BYTES as u64));
    assert_eq!(r.fs.write_atomic(&["devices", "a", "state.ctx"], &big), Err(FsError::TooLarge), "état de plus de 1 Mio : refusé");
    assert!(r.fs.pin(&["devices", "a", "e1", "s-00000001.cts.tmp"]).is_ok(), "pas d'épinglage sur iOS, aucun appel");
    let _ = &r.refreshed;
}

// ------------------------------------------------------------------------------------------------------------------------------
// BookmarkBackend dans SyncCore
// ------------------------------------------------------------------------------------------------------------------------------

struct Phone {
    core: Arc<SyncCore>,
    backend: Arc<BookmarkBackend>,
    base: tempfile::TempDir,
    plugin: Arc<FakePlugin>,
    vault: Arc<MemoryVault>,
    clock: Arc<AtomicU64>,
}

/// Service de l'iPhone tel que `commands_ios.rs` le construit (`ios_core`), sur le faux du plugin.
fn phone_core(base: &Path, plugin: &Arc<FakePlugin>, vault: &Arc<MemoryVault>, clock: &Arc<AtomicU64>) -> (Arc<SyncCore>, Arc<BookmarkBackend>) {
    let now = clock.clone();
    let clock_fn: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || now.load(Ordering::SeqCst));
    ios_core(base.to_path_buf(), Arc::new(SharedPlugin(plugin.clone())), vault.clone(), FakeUi::new(), clock_fn)
}

fn phone() -> Phone {
    let base = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    let vault = Arc::new(MemoryVault::default());
    let (core, backend) = phone_core(base.path(), &plugin, &vault, &clock);
    assert_eq!(core.options().platform, "ios");
    Phone { core, backend, base, plugin, vault, clock }
}

impl Phone {
    /// Redémarrage de l'app : nouveau service, même conteneur, nouvelle session du plugin (racine à résoudre).
    fn restart(&mut self) {
        self.plugin.with(|s| s.session = false);
        (self.core, self.backend) = phone_core(self.base.path(), &self.plugin, &self.vault, &self.clock);
    }

    fn record(&self) -> FolderRecord {
        read_config_file::<FolderRecord>(&config_dir(self.base.path()).join(FOLDER_FILE)).unwrap().expect("folder.json")
    }

    fn choose(&self) {
        choose_with_picker(&self.core, &self.backend).unwrap().expect("dossier choisi");
    }
}

#[test]
fn y_ios_01_5_chosen_folder_keeps_its_bookmark_in_folder_json_and_never_returns_the_path() {
    let p = phone();
    p.choose();
    let record = p.record();
    assert_eq!(record.path, ROOT);
    assert_eq!(record.bookmark.as_deref(), Some(BOOKMARK));
    let info = p.core.folder_info().unwrap();
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json, json!({ "configured": true, "name": "CircleTasks", "kind": "icloud", "pinned": false }), "nom et nature, jamais un chemin");
    // Parcours complet sous le signet : clé, liaison, ajout, état, lecture.
    p.core.key_create().unwrap();
    p.core.bind_device(DEV_A).unwrap();
    let scan = p.core.scan(&[]).unwrap();
    assert!(!scan.incomplete);
    let ep = epoch(1, DEV_A);
    let handle = p.core.snapshot_begin(&ep, 1, 14).unwrap();
    // Page de plus de 1 Mio chiffrée : ajoutée en plusieurs appels.
    let big = format!("\"{}\"", "s".repeat(200_000));
    p.core.snapshot_append(handle, &vec![big; 7]).unwrap();
    p.core.snapshot_commit(handle).unwrap();
    assert!(p.plugin.get(&["devices", DEV_A, &ep, "s-00000001.cts"]).is_some());
}

#[test]
fn y_ios_01_7_folder_kind_follows_the_plugin() {
    let p = phone();
    p.plugin.with(|s| s.kind = "local");
    p.choose();
    assert_eq!(p.core.folder_info().unwrap().kind, "local", "hors iCloud Drive : avertissement existant");
}

#[test]
fn y_ios_01_6_stale_bookmark_is_refreshed_and_rewritten_without_user_action() {
    let mut p = phone();
    p.choose();
    p.plugin.with(|s| s.stale = true);
    p.restart();
    p.core.folder_info().unwrap();
    assert_eq!(p.record().bookmark.as_deref(), Some(FRESH_BOOKMARK), "signet rafraîchi réécrit");
    // Rafraîchi pendant une opération (racine résolue à nouveau en cours de session) : réécrit aussi.
    p.plugin.with(|s| s.stale = true);
    p.core.folder_info().unwrap();
    assert_eq!(p.record().bookmark.as_deref(), Some(FRESH_BOOKMARK));
}

#[test]
fn y_ios_01_6_lost_moved_or_missing_bookmark_is_folder_unreachable_until_chosen_again() {
    let mut p = phone();
    p.choose();
    p.core.key_create().unwrap();
    p.core.bind_device(DEV_A).unwrap();
    // Réinstallation sous une autre signature, dossier supprimé : signet impossible à résoudre.
    p.plugin.with(|s| s.invalid = true);
    p.restart();
    assert_eq!(code(p.core.folder_info()), SyncCode::FolderUnreachable);
    assert_eq!(code(p.core.scan(&[])), SyncCode::FolderUnreachable, "la file attend");
    // Toujours injoignable après un redémarrage (état gardé par folder.json, rien d'effacé).
    p.restart();
    assert_eq!(code(p.core.folder_info()), SyncCode::FolderUnreachable);
    assert_eq!(p.record().device_id.as_deref(), Some(DEV_A), "appareil lié gardé");
    // Nouveau choix du même dossier : même dossier, own.json et liaison gardés, synchro rétablie.
    p.plugin.with(|s| s.invalid = false);
    p.choose();
    assert!(p.core.folder_info().unwrap().configured);
    assert!(p.core.scan(&[]).is_ok());
    assert_eq!(p.record().device_id.as_deref(), Some(DEV_A));
    // Dossier déplacé (le signet le suit) : injoignable, jamais un autre dossier en silence.
    p.plugin.with(|s| s.root = format!("{ROOT}-deplace"));
    p.restart();
    assert_eq!(code(p.core.folder_info()), SyncCode::FolderUnreachable);
    // `folder.json` sans signet (écrit par une autre version) : injoignable.
    let dir = config_dir(p.base.path());
    std::fs::write(dir.join(FOLDER_FILE), serde_json::to_vec(&json!({ "v": 1, "path": ROOT, "deviceId": DEV_A })).unwrap()).unwrap();
    p.plugin.with(|s| s.root = ROOT.to_owned());
    p.restart();
    assert_eq!(code(p.core.folder_info()), SyncCode::FolderUnreachable);
}

#[test]
fn y_ios_01_5_folder_json_of_the_pc_is_read_unchanged() {
    let record: FolderRecord = serde_json::from_value(json!({ "v": 1, "path": r"C:\Users\Ali\iCloudDrive\CircleTasks", "deviceId": DEV_A })).unwrap();
    assert_eq!(record.bookmark, None);
    let written = serde_json::to_value(&record).unwrap();
    assert_eq!(written, json!({ "v": 1, "path": r"C:\Users\Ali\iCloudDrive\CircleTasks", "deviceId": DEV_A }), "aucun champ ajouté sur PC");
}

#[test]
fn y_ios_01_13_cancelled_picker_changes_nothing_and_an_error_is_a_code_only() {
    let p = phone();
    let backend = &p.backend;
    p.plugin.with(|s| s.pick = Pick::Cancel);
    assert_eq!(choose_with_picker(&p.core, backend).unwrap(), None);
    assert!(!config_dir(p.base.path()).join(FOLDER_FILE).exists(), "rien n'est écrit");
    p.plugin.with(|s| s.pick = Pick::Reject("io"));
    assert_eq!(code(backend.pick()), SyncCode::Io);
    assert!(backend.check(Path::new(ROOT)).is_err(), "sans signet, aucun dossier n'est joignable");
}

#[test]
fn y_ios_01_hydrate_budget_ms_out_of_bounds_is_bad_name() {
    let p = phone();
    p.choose();
    p.core.key_create().unwrap();
    p.core.bind_device(DEV_A).unwrap();
    for bad in [0, 180_001, u64::MAX] {
        assert_eq!(code(p.core.scan_within(&[], Some(bad))), SyncCode::BadName, "{bad}");
    }
    for good in [1, 25_000, 180_000] {
        assert!(p.core.scan_within(&[], Some(good)).is_ok(), "{good}");
    }
    // Budget réduit transmis au téléchargement d'un état resté dans le nuage.
    p.plugin.put_cloud(&["devices", "7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e", "state.ctx"], b"x", 50_000, false);
    p.core.scan_within(&[], Some(5_000)).unwrap();
    let downloads = p.plugin.calls("download");
    assert!(!downloads.is_empty() && downloads.iter().all(|d| d["timeoutMs"].as_u64().unwrap() <= 5_000), "{downloads:?}");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 5 : fin d'un instantané lue en flux
// ------------------------------------------------------------------------------------------------------------------------------

fn header_line(dev: &str, n: u64) -> String {
    let key = MasterKey::generate().unwrap();
    FileHeader::new(HeaderKind::Snapshot, key.kid(), dev, &epoch(1, dev), n).line()
}

/// Même découpage que la lecture complète, quelle que soit la taille des blocs.
#[test]
fn y_ios_01_5_streamed_tail_matches_the_full_parse_on_every_case() {
    let header = header_line(DEV_A, 1);
    let long = "L".repeat(360_001);
    let cases: Vec<Vec<u8>> = vec![
        format!("{header}\n").into_bytes(),
        format!("{header}\nun\ndeux\n").into_bytes(),
        format!("{header}\nun\ndeux\ntro").into_bytes(),
        format!("{header}\nun\n\n").into_bytes(),
        format!("{header}\nun\n{long}\n").into_bytes(),
        format!("{header}\n{long}\nfin\n").into_bytes(),
        format!("{header}\nun\n{long}").into_bytes(),
        header.as_bytes()[..10].to_vec(),
        "x".repeat(1_100).into_bytes(),
        b"{\"pas\":\"un en-tete\"}\nun\n".to_vec(),
        Vec::new(),
    ];
    for (i, bytes) in cases.iter().enumerate() {
        let mem = MemFs::new();
        mem.put(&["f"], bytes);
        let fs = SharedFs(mem);
        for chunk in [1usize, 2, 3, 7, 64, 4_096, MAX_PLUGIN_CHUNK_BYTES] {
            let tail = stream_last_line_with(&fs, &["f"], MAX_SNAPSHOT_BYTES, chunk).unwrap();
            match parse_file(bytes) {
                Ok(full) => {
                    assert_eq!(tail.header, StreamHeader::Ok(full.header.clone()), "cas {i}, bloc {chunk}");
                    assert_eq!(tail.lines, full.lines.len() as u64, "cas {i}, bloc {chunk}");
                    assert_eq!(tail.partial_tail, full.partial_tail, "cas {i}, bloc {chunk}");
                    let last = full.lines.last().filter(|l| l.len() <= 360_000).map(|l| l.to_vec());
                    assert_eq!(tail.last, last, "cas {i}, bloc {chunk}");
                }
                Err(ParseError::Partial) => assert_eq!(tail.header, StreamHeader::Partial, "cas {i}, bloc {chunk}"),
                Err(ParseError::BadHeader) => assert_eq!(tail.header, StreamHeader::Bad, "cas {i}, bloc {chunk}"),
            }
        }
    }
}

/// Instantané de 64 Mio simulé : jamais lu en entier, blocs de 1 Mio au plus, une seule ligne gardée.
struct VirtualSnapshot {
    header: Vec<u8>,
    filler: Vec<u8>,
    lines: u64,
    last: Vec<u8>,
    calls: AtomicUsize,
    largest: AtomicUsize,
}

impl VirtualSnapshot {
    fn size(&self) -> u64 {
        self.header.len() as u64 + self.filler.len() as u64 * self.lines + self.last.len() as u64
    }

    fn byte(&self, at: u64) -> u8 {
        let h = self.header.len() as u64;
        if at < h {
            return self.header[at as usize];
        }
        let body = self.filler.len() as u64 * self.lines;
        if at < h + body {
            return self.filler[((at - h) % self.filler.len() as u64) as usize];
        }
        self.last[(at - h - body) as usize]
    }
}

impl SyncFs for VirtualSnapshot {
    fn check_root(&self) -> Result<(), FsError> {
        Ok(())
    }
    fn start_cycle(&self) -> Result<(), FsError> {
        Ok(())
    }
    fn read_head(&self, _file: &[&str], _max: usize) -> Result<Vec<u8>, FsError> {
        unreachable!()
    }
    fn list(&self, _dir: &[&str], _max: usize) -> Result<Listing, FsError> {
        unreachable!()
    }
    fn read(&self, _file: &[&str], _limit: u64, _hydrate: bool) -> Result<Vec<u8>, FsError> {
        panic!("lecture complète interdite : la fin se lit en flux");
    }
    fn read_from(&self, _file: &[&str], offset: u64, max: usize, _hydrate: bool) -> Result<Chunk, FsError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.largest.fetch_max(max, Ordering::SeqCst);
        let size = self.size();
        let end = (offset + max as u64).min(size);
        let bytes: Vec<u8> = (offset..end).map(|at| self.byte(at)).collect();
        Ok(Chunk { eof: end >= size, bytes, size })
    }
    fn append(&self, _file: &[&str], _bytes: &[u8], _mode: AppendMode) -> Result<(), FsError> {
        unreachable!()
    }
    fn write_atomic(&self, _file: &[&str], _bytes: &[u8]) -> Result<(), FsError> {
        unreachable!()
    }
    fn rename(&self, _dir: &[&str], _from: &str, _to: &str) -> Result<(), FsError> {
        unreachable!()
    }
    fn create_dir(&self, _dir: &[&str]) -> Result<(), FsError> {
        unreachable!()
    }
    fn remove_file(&self, _file: &[&str]) -> Result<bool, FsError> {
        unreachable!()
    }
    fn remove_empty_dir(&self, _dir: &[&str]) -> Result<(), FsError> {
        unreachable!()
    }
    fn pin(&self, _file: &[&str]) -> Result<(), FsError> {
        unreachable!()
    }
}

#[test]
fn y_ios_01_5_tail_of_a_64_mib_snapshot_is_streamed_with_bounded_memory() {
    let header = format!("{}\n", header_line(DEV_A, 1)).into_bytes();
    let filler = format!("{}\n", "f".repeat(4_095)).into_bytes();
    let lines = 64 * 1024 * 1024 / filler.len() as u64;
    let snapshot = VirtualSnapshot { header, filler, lines, last: b"derniere\n".to_vec(), calls: AtomicUsize::new(0), largest: AtomicUsize::new(0) };
    assert!(snapshot.size() >= 64 * 1024 * 1024);
    let tail = stream_last_line(&snapshot, &["s-00000001.cts"], MAX_SNAPSHOT_BYTES).unwrap();
    assert!(matches!(tail.header, StreamHeader::Ok(_)));
    assert_eq!(tail.lines, lines + 1);
    assert_eq!(tail.last.as_deref(), Some(&b"derniere"[..]));
    assert!(!tail.partial_tail);
    assert_eq!(snapshot.largest.load(Ordering::SeqCst), MAX_PLUGIN_CHUNK_BYTES, "blocs de 1 Mio au plus");
    assert_eq!(snapshot.calls.load(Ordering::SeqCst) as u64, snapshot.size().div_ceil(MAX_PLUGIN_CHUNK_BYTES as u64), "chaque octet lu une fois");
    // Au-delà de la borne d'un instantané : refusé dès le premier bloc.
    assert_eq!(stream_last_line(&snapshot, &["s"], 1_000), Err(FsError::TooLarge));
}

/// Un transport qui n'est jamais appelé (contrôle du faux : `BookmarkTransport` est bien l'unique porte).
#[allow(dead_code)]
struct Never;

impl BookmarkTransport for Never {
    fn call(&self, _command: &str, _args: Value) -> Result<Value, String> {
        panic!("appel inattendu")
    }
}

/// Revue (bloquant) : `Package.swift` en swift-tools-version 5.3 (comme les plugins Tauri) n'accepte que les versions d'iOS connues de
/// cet outil (`.v14` au plus) ; iOS 14 suffit pour `UTType` et `UIDocumentPickerViewController(forOpeningContentTypes:)`.
#[test]
fn y_ios_01_package_swift_platform_exists_in_its_tools_version() {
    let package = include_str!("../../plugins/folder-bookmark/ios/Package.swift");
    assert!(package.starts_with("// swift-tools-version:5.3"));
    assert!(package.contains(".iOS(.v14)"), "plateforme iOS 14 (disponible en 5.3)");
    for unknown in [".v15", ".v16", ".v17", ".v18"] {
        assert!(!package.contains(unknown), "{unknown} n'existe pas en swift-tools-version 5.3");
    }
}

/// Revue (audit, bas) : durcissements du Swift relus statiquement (aucune compilation locale).
#[test]
fn y_ios_01_swift_hardening_from_the_security_audit() {
    let code = swift_code();
    let open_directory = &code[code.find("private func openDirectory(").unwrap()..];
    let open_directory = &open_directory[..open_directory.find("\n  }\n").unwrap()];
    assert!(open_directory.contains("open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)"), "racine ouverte sans suivre de lien");
    assert!(open_directory.contains("fstat(fd, &rootStat)"), "racine contrôlée sur le descripteur");
    let read_from = swift_method("readFrom");
    assert!(read_from.contains("st.st_nlink > 1"), "fichier à plusieurs liens physiques refusé en lecture");
    let check_chain = &code[code.find("private func checkChain(").unwrap()..];
    let check_chain = &check_chain[..check_chain.find("
  }
").unwrap()];
    assert!(check_chain.contains("openDirectory(rootPath, dir, create: false)") && check_chain.contains("AT_SYMLINK_NOFOLLOW") && check_chain.contains("st.st_nlink > 1"));
    assert!(read_from.find("self.checkChain(").unwrap() < read_from.find("self.availability(").unwrap(), "chaîne validée avant l'état iCloud");
    let download = swift_method("download");
    assert!(download.find("self.checkChain(").unwrap() < download.find("resourceValues(").unwrap(), "chaîne validée avant l'état iCloud");
    assert!(download.find("self.checkChain(").unwrap() < download.find("startDownloadingUbiquitousItem").unwrap(), "chaîne validée avant le téléchargement");
    let rename = swift_method("rename");
    assert!(rename.contains("coordinatedMove("), "source et destination coordonnées");
    assert!(code.contains("options: .forMoving") && code.contains("options: .forReplacing"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-IOS-05 (B6) : échéance du transport du plugin (`DeadlineTransport`)
// ------------------------------------------------------------------------------------------------------------------------------

/// Fichiers `.rs` de `src-tauri/src` (chemin relatif en `/`, contenu).
fn app_sources() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.push((rel, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

/// Critère 14 : le transport de production est construit par `DeadlineTransport::new(...)` autour de `PluginTransport`, et aucun autre
/// appel du plugin folder-bookmark dans `src-tauri/src` ne contourne le décorateur.
#[test]
fn y_ios_05_14_production_transport_is_wrapped_by_the_deadline() {
    assert!(
        COMMANDS_IOS_RS.contains("DeadlineTransport::new(Arc::new(PluginTransport(plugin.inner().clone())))"),
        "commands_ios.rs : le transport du plugin passe par DeadlineTransport::new"
    );
    assert_eq!(
        COMMANDS_IOS_RS.matches("PluginTransport(").count(),
        COMMANDS_IOS_RS.matches("DeadlineTransport::new(Arc::new(PluginTransport(").count(),
        "commands_ios.rs : aucun PluginTransport hors du décorateur"
    );
    let mut users = BTreeSet::new();
    for (file, text) in app_sources() {
        if text.contains("tauri_plugin_folder_bookmark") {
            users.insert(file.clone());
        }
        if file == "sync/bookmark.rs" {
            // Le seul appel direct du plugin : `PluginTransport::call`.
            assert_eq!(text.matches("self.0.call(").count(), 1, "bookmark.rs : un seul appel direct du plugin");
        }
        if file == "sync/commands_ios.rs" {
            assert!(!text.contains("plugin.call(") && !text.contains(".0.call("), "commands_ios.rs : aucun appel direct du plugin");
        }
    }
    let expected: BTreeSet<String> = ["lib.rs", "sync/bookmark.rs", "sync/commands_ios.rs"].iter().map(|s| (*s).to_owned()).collect();
    assert_eq!(users, expected, "seuls lib.rs (init), bookmark.rs (PluginTransport) et commands_ios.rs (câblage) nomment le plugin");
}

/// Y-IOS-05 (décision 8, ADR 0011 §32, réponse au point 2 de §25) : transport muet dédié. Pour la commande désignée (`"*"` : toute
/// commande), l'appel est noté puis bloque sur un canal jusqu'à ce que le test l'y libère (ou abandonne le canal), et répond alors comme
/// `fake_bookmark` ; les autres commandes répondent aussitôt comme `fake_bookmark`, ou par la réponse imposée (`script`). L'effet `mute`
/// reste refusé par `MemFs` et `fake_bookmark` : ce faux n'existe que pour l'échéance de `DeadlineTransport`.
struct MutedTransport {
    plugin: Arc<FakePlugin>,
    muted: Option<&'static str>,
    release: Mutex<mpsc::Receiver<()>>,
    script: Mutex<BTreeMap<String, Result<Value, String>>>,
    received: Mutex<Vec<(String, Value, ThreadId)>>,
    arrived: Condvar,
}

/// Libération des appels muets (un envoi : un appel ; abandon du canal : tous, et les suivants ne bloquent plus).
struct Release(mpsc::Sender<()>);

/// Garde-fou des attentes sur condition : jamais atteint quand le test passe ; s'il l'est, le test échoue.
const GUARD: Duration = Duration::from_secs(30);

impl MutedTransport {
    fn new(plugin: Arc<FakePlugin>, muted: Option<&'static str>) -> (Arc<Self>, Release) {
        let (sender, receiver) = mpsc::channel();
        let transport = Arc::new(Self { plugin, muted, release: Mutex::new(receiver), script: Mutex::new(BTreeMap::new()), received: Mutex::new(Vec::new()), arrived: Condvar::new() });
        (transport, Release(sender))
    }

    fn received(&self) -> Vec<(String, Value, ThreadId)> {
        self.received.lock().unwrap().clone()
    }

    fn commands(&self) -> Vec<String> {
        self.received().into_iter().map(|(c, _, _)| c).collect()
    }

    /// Attend (sur condition) que `count` appels soient arrivés ; faux si le garde-fou expire.
    fn wait_received(&self, count: usize) -> bool {
        let received = self.received.lock().unwrap();
        let (received, _) = self.arrived.wait_timeout_while(received, GUARD, |r| r.len() < count).unwrap();
        received.len() >= count
    }
}

impl BookmarkTransport for MutedTransport {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.received.lock().unwrap().push((command.to_owned(), args.clone(), std::thread::current().id()));
        self.arrived.notify_all();
        if self.muted.is_some_and(|m| m == "*" || m == command) {
            let _ = self.release.lock().unwrap().recv();
        }
        if let Some(answer) = self.script.lock().unwrap().get(command) {
            return answer.clone();
        }
        self.plugin.call(command, args)
    }
}

fn zero() -> DeadlineLimits {
    DeadlineLimits { file_call: Duration::ZERO, download_margin: Duration::ZERO, max_abandoned: 1 }
}

/// Échéance large (transmission) : jamais atteinte par un transport qui répond aussitôt, donc aucune attente réelle.
fn wide() -> DeadlineLimits {
    DeadlineLimits { file_call: Duration::from_secs(3_600), download_margin: Duration::from_secs(3_600), max_abandoned: 1 }
}

struct DeadlineRig {
    muted: Arc<MutedTransport>,
    deadline: Arc<DeadlineTransport>,
    fs: BookmarkFs,
    release: Option<Release>,
}

/// `BookmarkFs` sur `DeadlineTransport` sur `MutedTransport` ; racine déjà résolue dans la session : la commande appelée est la première.
fn deadline_rig(muted: Option<&'static str>, limits: DeadlineLimits) -> DeadlineRig {
    let clock = Arc::new(AtomicU64::new(NOW));
    let plugin = FakePlugin::new(clock.clone());
    plugin.with(|s| s.session = true);
    let (transport, release) = MutedTransport::new(plugin, muted);
    let deadline = Arc::new(DeadlineTransport::with_limits(transport.clone(), limits));
    let now = clock.clone();
    let fs = BookmarkFs::new(deadline.clone(), ROOT.to_owned(), BOOKMARK.to_owned(), Arc::new(Mutex::new(None)), Arc::new(move || now.load(Ordering::SeqCst)));
    DeadlineRig { muted: transport, deadline, fs, release: Some(release) }
}

/// Critère 10 : échéance par commande, fonction pure.
#[test]
fn y_ios_05_10_deadline_for_each_command() {
    let limits = DeadlineLimits::default();
    assert_eq!(limits.file_call, Duration::from_secs(20));
    assert_eq!(limits.download_margin, Duration::from_secs(5));
    assert_eq!(limits.max_abandoned, 1);
    let file = Some(Duration::from_secs(20));
    let cases: Vec<(&str, Value, Option<Duration>)> = vec![
        ("resolve", json!({ "bookmark": BOOKMARK }), file),
        ("status", json!({ "path": ["devices"] }), file),
        ("list", json!({ "path": [], "max": 10 }), file),
        ("readFrom", json!({}), file),
        ("append", json!({}), file),
        ("writeAtomic", json!({}), file),
        ("rename", json!({}), file),
        ("createDir", json!({}), file),
        ("remove", json!({}), file),
        ("removeEmptyDir", json!({}), file),
        ("appState", json!({}), file),
        ("download", json!({ "timeoutMs": 60_000 }), Some(Duration::from_secs(65))),
        ("download", json!({ "timeoutMs": 1_500 }), Some(Duration::from_millis(6_500))),
        ("download", json!({}), file),
        ("download", json!({ "timeoutMs": "60000" }), file),
        ("download", json!({ "timeoutMs": -1 }), file),
        ("download", json!({ "timeoutMs": 1.5 }), file),
        ("pickFolder", json!({}), None),
        ("confirm", json!({ "title": "t" }), None),
        ("inconnue", json!({}), file),
    ];
    for (command, args, expected) in cases {
        assert_eq!(deadline_for(command, &args, &limits), expected, "{command} {args}");
    }
    // Toute commande du contrat est bornée, sauf les deux d'interaction.
    for command in PLUGIN_COMMANDS {
        assert_eq!(deadline_for(command, &json!({}), &limits).is_none(), UNBOUNDED_COMMANDS.contains(&command), "{command}");
    }
    assert_eq!(UNBOUNDED_COMMANDS, ["pickFolder", "confirm"]);
}

/// Critère 7 : transmission fidèle des 14 commandes (arguments identiques, réponse et code de rejet inchangés), échéance large.
#[test]
fn y_ios_05_7_every_command_passes_through_unchanged() {
    let clock = Arc::new(AtomicU64::new(NOW));
    let (transport, _release) = MutedTransport::new(FakePlugin::new(clock), None);
    let deadline = DeadlineTransport::with_limits(transport.clone(), wide());
    for (i, command) in PLUGIN_COMMANDS.iter().enumerate() {
        let args = json!({ "path": ["devices", format!("n{i}")], "timeoutMs": 10, "n": i });
        let answer = json!({ "command": command, "entries": [{ "name": "x", "isDir": false }], "n": i });
        transport.script.lock().unwrap().insert((*command).to_owned(), Ok(answer.clone()));
        assert_eq!(deadline.call(command, args.clone()), Ok(answer), "{command} : réponse");
        let (seen, seen_args, _) = transport.received().pop().unwrap();
        assert_eq!((seen.as_str(), seen_args), (*command, args), "{command} : arguments");
        for code in ["not-configured", "cloud-pending", "cloud-error", "too-large", "io", "unsafe-folder"] {
            transport.script.lock().unwrap().insert((*command).to_owned(), Err(code.to_owned()));
            assert_eq!(deadline.call(command, json!({})), Err(code.to_owned()), "{command} : code {code}");
        }
    }
    assert_eq!(deadline.abandoned(), 0);
}

/// Critère 8 : un appel muet rend `cloud-pending` sans attendre sa réponse (échéance `Duration::ZERO`), pour chaque accès de `BookmarkFs`.
#[test]
fn y_ios_05_8_muted_call_is_cloud_pending_at_the_deadline() {
    type Access = fn(&BookmarkFs) -> Result<(), FsError>;
    let accesses: [(&'static str, Access); 5] = [
        ("list", |fs| fs.list(&["devices"], 10).map(|_| ())),
        ("status", |fs| fs.read(&["devices", DEV_A, "state.ctx"], 1024, true).map(|_| ())),
        ("readFrom", |fs| fs.read_head(&["devices", DEV_A, "state.ctx"], 1024).map(|_| ())),
        ("append", |fs| fs.append(&["devices", DEV_A, "j.tmp"], b"x\n", AppendMode::Existing)),
        ("resolve", |fs| fs.check_root()),
    ];
    for (command, access) in accesses {
        let mut rig = deadline_rig(Some(command), zero());
        assert_eq!(access(&rig.fs), Err(FsError::CloudPending), "{command}");
        assert!(rig.muted.wait_received(1));
        assert_eq!(rig.muted.commands(), vec![command.to_owned()], "{command} : seul appel envoyé, le muet");
        assert_eq!(rig.deadline.abandoned(), 1, "{command} : appel abandonné compté");
        drop(rig.release.take());
        assert!(rig.deadline.wait_abandoned(0, GUARD), "{command} : réponse tardive reçue, compteur rendu");
    }
}

/// Critères 8 (par `ios_core`) et 9 : le scan d'un service de l'iPhone dont l'appel ne répond pas rend `cloud-pending`, et une autre
/// commande qui prend le verrou `inner` (`listed_devices`), appelée depuis un autre fil, n'attend pas derrière lui.
#[test]
fn y_ios_05_8_9_scan_is_cloud_pending_and_the_core_lock_is_released() {
    let p = phone();
    p.choose();
    p.plugin.with(|s| s.session = false);
    // Toute commande muette : le premier appel du cycle (`resolve` du contrôle du dossier) ne répond pas ; les suivants ne partent pas.
    let (transport, release) = MutedTransport::new(p.plugin.clone(), Some("*"));
    let deadline = Arc::new(DeadlineTransport::with_limits(transport.clone(), zero()));
    let now = p.clock.clone();
    let (core, _backend) = ios_core(p.base.path().to_path_buf(), deadline.clone(), p.vault.clone(), FakeUi::new(), Arc::new(move || now.load(Ordering::SeqCst)));
    assert_eq!(code(core.scan(&[])), SyncCode::CloudPending);
    assert_eq!(deadline.abandoned(), 1);
    let (sender, receiver) = mpsc::channel();
    let other = core.clone();
    std::thread::spawn(move || {
        let _ = sender.send(other.listed_devices().map_err(|e| e.code));
    });
    let listed = receiver.recv_timeout(GUARD).expect("listed_devices bloqué derrière le scan abandonné");
    assert!(matches!(listed, Ok(_) | Err(SyncCode::CloudPending)), "{listed:?}");
    assert!(transport.wait_received(1));
    assert_eq!(transport.commands().len(), 1, "un seul appel envoyé (le muet), les suivants refusés sans envoi");
    drop(release);
    assert!(deadline.wait_abandoned(0, GUARD));
}

/// Critère 11 : `pickFolder` et `confirm` passent sur le fil appelant, jamais rejetés par l'échéance (même `Duration::ZERO`, même avec un
/// appel abandonné en attente).
#[test]
fn y_ios_05_11_interaction_commands_run_on_the_calling_thread_without_deadline() {
    let mut rig = deadline_rig(Some("list"), zero());
    for command in UNBOUNDED_COMMANDS {
        rig.muted.script.lock().unwrap().insert(command.to_owned(), Ok(json!({ "ok": command })));
    }
    for pass in ["sans appel abandonné", "avec un appel abandonné"] {
        for command in UNBOUNDED_COMMANDS {
            assert_eq!(rig.deadline.call(command, json!({})), Ok(json!({ "ok": command })), "{command} {pass}");
            let (_, _, thread) = rig.muted.received().into_iter().rev().find(|(seen, _, _)| seen == command).unwrap();
            assert_eq!(thread, std::thread::current().id(), "{command} {pass} : fil appelant");
        }
        if pass == "sans appel abandonné" {
            assert_eq!(rig.fs.list(&["devices"], 10).map(|_| ()), Err(FsError::CloudPending));
            // Le listage muet est noté par son propre fil : attendu avant de poursuivre.
            assert!(rig.muted.wait_received(3));
            assert_eq!(rig.deadline.abandoned(), 1);
        }
    }
    drop(rig.release.take());
    assert!(rig.deadline.wait_abandoned(0, GUARD));
}

/// Critère 12 : tant que l'appel abandonné n'a pas répondu, toute commande bornée rend `cloud-pending` sans atteindre le transport ; sa
/// réponse tardive est jetée sans effet, le compteur retombe à 0 et la commande suivante atteint de nouveau le transport.
#[test]
fn y_ios_05_12_one_abandoned_call_then_immediate_cloud_pending_until_it_answers() {
    let mut rig = deadline_rig(Some("list"), zero());
    assert_eq!(rig.fs.list(&["devices"], 10).map(|_| ()), Err(FsError::CloudPending));
    assert!(rig.muted.wait_received(1));
    assert_eq!(rig.deadline.abandoned(), 1);
    for command in ["status", "readFrom", "append", "resolve", "download", "list"] {
        assert_eq!(rig.deadline.call(command, json!({ "timeoutMs": 1 })), Err("cloud-pending".to_owned()), "{command}");
    }
    assert_eq!(rig.muted.commands(), vec!["list".to_owned()], "aucune commande envoyée derrière l'appel abandonné");
    // Réponse tardive valide (le faux répond au listage) : jetée, aucune erreur ni panique, le compteur retombe.
    rig.release.as_ref().unwrap().0.send(()).unwrap();
    assert!(rig.deadline.wait_abandoned(0, GUARD));
    rig.muted.script.lock().unwrap().insert("status".to_owned(), Ok(json!({ "exists": false })));
    // Échéance nulle : la réponse peut arriver après l'échéance ; seul compte que la commande atteigne le transport.
    let _ = rig.deadline.call("status", json!({ "path": ["devices"] }));
    assert!(rig.muted.wait_received(2));
    assert_eq!(rig.muted.commands(), vec!["list".to_owned(), "status".to_owned()]);
    drop(rig.release.take());
    assert!(rig.deadline.wait_abandoned(0, GUARD));
}

/// Critère 13 : l'échéance inscrit `bookmark-call-timeout` avec le seul nom de la commande ; aucune ligne ne porte un chemin, un nom de
/// fichier, un signet ou un argument.
#[test]
fn y_ios_05_13_timeout_log_names_the_command_only() {
    let capture = circletasks_lib::sync::log::capture();
    let mut rig = deadline_rig(Some("readFrom"), zero());
    assert_eq!(rig.fs.read_head(&["devices", DEV_A, "state.ctx"], 1024).map(|_| ()), Err(FsError::CloudPending));
    assert_eq!(rig.deadline.call("status", json!({ "path": ["devices", DEV_A, "state.ctx"] })), Err("cloud-pending".to_owned()));
    let lines = capture.lines();
    assert!(lines.contains(&"sync:bookmark-call-timeout readFrom".to_owned()), "{lines:?}");
    assert!(lines.contains(&"sync:bookmark-call-skipped status".to_owned()), "{lines:?}");
    // La capture voit tous les fils (tests parallèles compris) : seules les lignes de l'échéance sont contrôlées, et entièrement.
    for line in lines.iter().filter(|l| l.starts_with("sync:bookmark-call-")) {
        let mut parts = line.split(' ');
        assert!(matches!(parts.next(), Some("sync:bookmark-call-timeout" | "sync:bookmark-call-skipped")), "{line}");
        assert!(parts.next().is_some_and(|detail| PLUGIN_COMMANDS.contains(&detail)), "{line}");
        assert_eq!(parts.next(), None, "{line}");
        for secret in [ROOT, BOOKMARK, DEV_A, "state.ctx", "devices"] {
            assert!(!line.contains(secret), "fuite dans le journal : {line}");
        }
    }
    drop(rig.release.take());
    assert!(rig.deadline.wait_abandoned(0, GUARD));
}

/// Corps d'une fonction Swift privée (`private func <name><`), jusqu'à la fonction suivante.
fn swift_private_func(name: &str) -> String {
    let code = swift_code();
    let start = code.find(&format!("private func {name}<")).unwrap_or_else(|| panic!("fonction Swift absente : {name}"));
    let rest = &code[start..];
    let end = rest[1..].find("\n  private func ").or_else(|| rest[1..].find("\n  @objc public func ")).map_or(rest.len(), |i| i + 1);
    rest[..end].to_owned()
}

/// Corps de la garde `CoordinationGuard` (classe de premier niveau).
fn swift_guard_class() -> String {
    let code = swift_code();
    let start = code.find("private final class CoordinationGuard {").expect("CoordinationGuard absente");
    let end = code[start..].find("\n}\n").expect("fin de CoordinationGuard");
    code[start..start + end].to_owned()
}

/// Critère 15 : chacune des quatre coordinations arme la garde avant `coordinate`, la désarme au retour, et rend son issue par
/// `settle` (résultat du corps, sinon `cloud-pending` si la garde a tiré, sinon `io`) ; la garde appelle `coordinator.cancel()` après
/// `coordinationGuardSeconds` par un `DispatchWorkItem`, sous verrou. Garde factorisée (une classe, quatre usages) : écart noté à la fiche.
#[test]
fn y_ios_05_15_every_coordination_is_guarded_and_cancelled() {
    let guard = swift_guard_class();
    for piece in ["DispatchWorkItem", "asyncAfter(deadline: .now() + seconds, execute: item)", "coordinator.cancel()", "lock.lock()", "didFire = true", "item?.cancel()"] {
        assert!(guard.contains(piece), "CoordinationGuard : {piece}");
    }
    let settle = &guard[guard.find("func settle<T>(").expect("settle")..];
    let (result, pending, io) = (settle.find("return try result.get()").unwrap(), settle.find("if fired {").unwrap(), settle.find("throw Failure(code: .io)").unwrap());
    assert!(result < pending && pending < io, "ordre : résultat du corps, puis cloud-pending si la garde a tiré, puis io");
    assert!(settle[pending..io].contains("throw Failure(code: .cloudPending)"));
    let code = swift_code();
    assert_eq!(code.matches("coordinator.cancel()").count(), 1, "cancel() seulement dans la garde");
    assert_eq!(code.matches("CoordinationGuard(coordinator, seconds: coordinationGuardSeconds)").count(), 4);
    assert_eq!(code.matches("coordinationGuard.disarm()").count(), 4);
    assert_eq!(code.matches("return try coordinationGuard.settle(outcome, coordinationError)").count(), 4);
    for name in ["coordinatedRead", "coordinatedWrite", "coordinatedDelete", "coordinatedMove"] {
        let body = swift_private_func(name);
        let (arm, coordinate, disarm, settle) = (
            body.find("let coordinationGuard = CoordinationGuard(coordinator, seconds: coordinationGuardSeconds)").unwrap_or_else(|| panic!("{name} : garde armée")),
            body.find("coordinator.coordinate(").unwrap_or_else(|| panic!("{name} : coordinate")),
            body.find("coordinationGuard.disarm()").unwrap_or_else(|| panic!("{name} : garde désarmée")),
            body.find("return try coordinationGuard.settle(outcome, coordinationError)").unwrap_or_else(|| panic!("{name} : issue")),
        );
        assert!(arm < coordinate && coordinate < disarm && disarm < settle, "{name} : armée avant coordinate, désarmée au retour, puis issue");
        assert!(!body.contains("if coordinationError != nil"), "{name} : plus de code io décidé avant le résultat du corps");
    }
}

/// Critère 16 : réponse unique ; la garde ne répond jamais à l'appel, `invoke.resolve` et `invoke.reject` n'existent que dans `onFiles`,
/// `reject` et les commandes d'interaction (`pickFolder`, `confirm`, `appState`).
#[test]
fn y_ios_05_16_the_guard_never_answers_the_call() {
    let guard = swift_guard_class();
    assert!(!guard.contains("invoke"), "la garde ne touche jamais à l'appel");
    let code = swift_code();
    let mut owners = BTreeSet::new();
    for needle in ["invoke.resolve(", "invoke.reject("] {
        for (at, _) in code.match_indices(needle) {
            let before = &code[..at];
            let private = before.rfind("private func ").map(|i| (i, &before[i + "private func ".len()..]));
            let public = before.rfind("@objc public func ").map(|i| (i, &before[i + "@objc public func ".len()..]));
            let (_, rest) = [private, public].into_iter().flatten().max_by_key(|(i, _)| *i).expect("fonction englobante");
            owners.insert(rest[..rest.find(|c: char| !c.is_alphanumeric()).unwrap()].to_owned());
        }
    }
    let expected: BTreeSet<String> = ["onFiles", "reject", "pickFolder", "confirm", "appState"].iter().map(|s| (*s).to_owned()).collect();
    assert_eq!(owners, expected);
}

/// Critère 17 : `"error"` d'un état illisible devient `cloud` ; `readFrom` refuse tout état autre que `local` avant la coordination ;
/// `download` sur un état illisible rend `cloud-pending` (plus `[:]`) ; `"error"` ne vient plus que d'un lien symbolique.
#[test]
fn y_ios_05_17_unreadable_state_is_cloud_and_links_stay_error() {
    let code = swift_code();
    let availability = &code[code.find("private func availability(").unwrap()..];
    let availability = &availability[..availability.find("\n  }\n").unwrap()];
    assert!(availability.contains("else {\n      return \"cloud\"\n    }"), "état illisible : cloud");
    assert!(!availability.contains("\"error\""));
    let read_from = swift_method("readFrom");
    let refuse = read_from.find("if self.availability(url) != \"local\" {").expect("readFrom : tout état non local refusé");
    assert!(read_from[refuse..].trim_start_matches(|c| c != '\n').trim_start().starts_with("throw Failure(code: .cloudPending)"));
    assert!(refuse < read_from.find("self.coordinatedRead(").unwrap(), "refus avant la coordination");
    let download = swift_method("download");
    let values = download.find("let values = try? item.resourceValues(").expect("download : état lu");
    let unreadable = &download[values..download.find("let announced").unwrap()];
    assert!(unreadable.contains("else {\n        throw Failure(code: .cloudPending)\n      }"), "download : état illisible, cloud-pending");
    assert!(!download.contains("values?."), "download : plus d'état optionnel avalé");
    // `"error"` : les deux liens symboliques seulement (état d'un élément, entrée listée).
    assert_eq!(code.matches("\"error\"").count(), 2);
    for (at, _) in code.match_indices("\"availability\": \"error\"") {
        let before = &code[..at];
        // Ligne précédente : le test du lien symbolique.
        let line_start = before.trim_end_matches(|c| c != '\n').trim_end_matches('\n');
        let previous = &line_start[line_start.rfind('\n').map_or(0, |i| i + 1)..];
        assert_eq!(previous.trim(), "if self.isLink(st.st_mode) {", "« error » hors d'un lien symbolique");
    }
}

/// Critère 18 : cohérence des valeurs entre les trois couches (garde Swift < échéance Rust < cycle en arrière-plan) et une seule sortie,
/// `cloud-pending`, pour le décorateur Rust et le faux TypeScript.
#[test]
fn y_ios_05_18_layer_values_are_consistent() {
    use circletasks_lib::sync::bookmark::DEADLINE_CODE;
    use circletasks_lib::sync::limits::{BOOKMARK_CALL_DEADLINE_MS, BOOKMARK_DOWNLOAD_MARGIN_MS, BOOKMARK_MAX_ABANDONED_CALLS};
    const MEMORY_TS: &str = include_str!("../../../src/platform/sync/memory.ts");
    let code = swift_code();
    let line = code.lines().find(|l| l.contains("private let coordinationGuardSeconds: Double = ")).expect("coordinationGuardSeconds");
    let swift_seconds: f64 = line.rsplit("= ").next().unwrap().trim().parse().unwrap();
    assert_eq!(swift_seconds, 15.0);
    let background_cycle_ms = 25_000;
    assert!(swift_seconds * 1000.0 < BOOKMARK_CALL_DEADLINE_MS as f64, "garde Swift < échéance Rust");
    assert!(BOOKMARK_CALL_DEADLINE_MS < background_cycle_ms, "échéance Rust < borne du cycle en arrière-plan (§22 point 6)");
    assert_eq!((BOOKMARK_DOWNLOAD_MARGIN_MS, BOOKMARK_MAX_ABANDONED_CALLS), (5_000, 1));
    let turns_line = MEMORY_TS.lines().find(|l| l.starts_with("export const MUTE_DEADLINE_TURNS = ")).expect("MUTE_DEADLINE_TURNS exporté");
    let turns: u32 = turns_line.trim_end_matches(';').rsplit("= ").next().unwrap().parse().unwrap();
    assert!(turns > 50 && turns < 500, "{turns}");
    // Table commune d'une ligne : la même sortie des deux côtés.
    let suspend = &MEMORY_TS[MEMORY_TS.find("  suspend<T>(").unwrap()..MEMORY_TS.find("  mutedCalls(): ").unwrap()];
    for (layer, exit) in [("DeadlineTransport (Rust)", DEADLINE_CODE.to_owned()), ("memory.ts (TypeScript)", if suspend.contains("muted.fail('cloud-pending')") { "cloud-pending".to_owned() } else { String::new() })] {
        assert_eq!(exit, "cloud-pending", "{layer}");
    }
    assert!(PLUGIN_REJECT_CODES.contains(&DEADLINE_CODE));
}
