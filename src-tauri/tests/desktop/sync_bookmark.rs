//! Y-IOS-01 (ADR 0011 §22) : contrat du plugin folder-bookmark (contrôle statique Swift, Rust, fixture), `BookmarkFs` sur le faux du
//! plugin (hydratation et budgets, liens, signet obsolète ou perdu, dossier déplacé), `BookmarkBackend` dans `SyncCore` (`folder.json`,
//! chemin jamais rendu), `sync_scan({ hydrateBudgetMs })`, et lecture en flux de la fin d'un instantané (`read_from`, mémoire bornée).

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::bookmark::{choose_with_picker, ios_core, BookmarkBackend, BookmarkFs, BookmarkTransport, PLUGIN_COMMANDS, PLUGIN_REJECT_CODES};
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
