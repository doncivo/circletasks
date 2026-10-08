//! Conformité de `SyncFs` (ADR 0011 §22 point 4 ; Y-IOS-01 critère 2) : la table `tests/fixtures/sync/syncfs-conformance.json` est rejouée
//! sur `StdFs` (dossier temporaire Windows, liens par jonction), sur `BookmarkFs` avec le faux du plugin (contrat JSON contrôlé à chaque
//! appel) et sur le `SyncFs` en mémoire des tests. Une table, trois implémentations, mêmes résultats attendus ; un cas qui exige une
//! capacité absente (fichier « dans le nuage » sur un vrai disque, lien dans le dossier en mémoire) est sauté pour cette implémentation
//! seulement, et compté.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::bookmark::BookmarkFs;
use circletasks_lib::sync::files::{AppendMode, Availability, FsError, SyncFs};
use serde_json::Value;

use crate::support::fake_bookmark::{FakePlugin, SharedPlugin, BOOKMARK, ROOT};
use crate::sync_support::{MemFs, SharedFs};

const TABLE: &str = include_str!("../../../tests/fixtures/sync/syncfs-conformance.json");

/// Une implémentation et son dossier : préparation et capacités.
trait World {
    fn fs(&self) -> &dyn SyncFs;
    fn mkdir(&self, parts: &[&str]);
    fn file(&self, parts: &[&str], text: &str, cloud: bool, delay_ms: u64);
    /// Lien sous la racine à la place de `parts` ; faux si l'implémentation ne sait pas en produire.
    fn link(&self, parts: &[&str]) -> bool;
    fn supports(&self, capability: &str) -> bool;
    /// Avant chaque étape (délais simulés du dossier en mémoire).
    fn before_step(&self) {}
}

// --- Dossier en mémoire -------------------------------------------------------------------------------------------------------

struct MemWorld {
    mem: Arc<MemFs>,
    fs: SharedFs,
    /// Fichiers au téléchargement trop long (au-delà de 60 s) : chaque hydratation échoue.
    slow: Mutex<Vec<Vec<String>>>,
}

impl MemWorld {
    fn new() -> Self {
        let mem = MemFs::new();
        Self { fs: SharedFs(mem.clone()), mem, slow: Mutex::new(Vec::new()) }
    }
}

impl World for MemWorld {
    fn fs(&self) -> &dyn SyncFs {
        &self.fs
    }
    fn mkdir(&self, parts: &[&str]) {
        self.mem.mkdir(parts);
    }
    fn file(&self, parts: &[&str], text: &str, cloud: bool, delay_ms: u64) {
        self.mem.put(parts, text.as_bytes());
        if cloud {
            self.mem.set_availability(parts, Availability::Cloud);
        }
        if cloud && delay_ms > 60_000 {
            self.slow.lock().unwrap().push(parts.iter().map(|p| (*p).to_owned()).collect());
        }
    }
    fn link(&self, _parts: &[&str]) -> bool {
        false
    }
    fn supports(&self, capability: &str) -> bool {
        capability == "cloud"
    }
    fn before_step(&self) {
        if !self.slow.lock().unwrap().is_empty() {
            *self.mem.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
        }
    }
}

// --- BookmarkFs et faux du plugin ---------------------------------------------------------------------------------------------

struct BookmarkWorld {
    plugin: Arc<FakePlugin>,
    fs: BookmarkFs,
}

impl BookmarkWorld {
    fn new() -> Self {
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let plugin = FakePlugin::new(clock.clone());
        let now = clock.clone();
        let fs = BookmarkFs::new(
            Arc::new(SharedPlugin(plugin.clone())),
            ROOT.to_owned(),
            BOOKMARK.to_owned(),
            Arc::new(Mutex::new(None)),
            Arc::new(move || now.load(std::sync::atomic::Ordering::SeqCst)),
        );
        Self { plugin, fs }
    }
}

impl World for BookmarkWorld {
    fn fs(&self) -> &dyn SyncFs {
        &self.fs
    }
    fn mkdir(&self, parts: &[&str]) {
        self.plugin.mkdir(parts);
    }
    fn file(&self, parts: &[&str], text: &str, cloud: bool, delay_ms: u64) {
        if cloud {
            self.plugin.put_cloud(parts, text.as_bytes(), delay_ms, false);
        } else {
            self.plugin.put(parts, text.as_bytes());
        }
    }
    fn link(&self, parts: &[&str]) -> bool {
        self.plugin.link(parts);
        true
    }
    fn supports(&self, _capability: &str) -> bool {
        true
    }
}

// --- StdFs (Windows) ----------------------------------------------------------------------------------------------------------

#[cfg(windows)]
struct StdWorld {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
    fs: circletasks_lib::sync::files::StdFs,
}

#[cfg(windows)]
impl StdWorld {
    fn new() -> Self {
        use circletasks_lib::sync::folder::{check_sync_path, normalize_final_path};
        let dir = tempfile::tempdir().expect("dossier temporaire");
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let base = PathBuf::from(normalize_final_path(&canonical.to_string_lossy()).expect("chemin local"));
        let root = base.join("CircleTasks");
        let outside = base.join("ailleurs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("state.ctx"), b"hors de la racine").unwrap();
        let fs = circletasks_lib::sync::files::StdFs::new(check_sync_path(&root).unwrap().path);
        Self { _dir: dir, root, outside, fs }
    }

    fn path(&self, parts: &[&str]) -> PathBuf {
        parts.iter().fold(self.root.clone(), |p, part| p.join(part))
    }
}

#[cfg(windows)]
impl World for StdWorld {
    fn fs(&self) -> &dyn SyncFs {
        &self.fs
    }
    fn mkdir(&self, parts: &[&str]) {
        std::fs::create_dir_all(self.path(parts)).unwrap();
    }
    fn file(&self, parts: &[&str], text: &str, _cloud: bool, _delay_ms: u64) {
        let path = self.path(parts);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text.as_bytes()).unwrap();
    }
    /// Jonction (point d'analyse non cloud) vers un dossier hors de la racine : toujours possible sans privilège.
    fn link(&self, parts: &[&str]) -> bool {
        let path = self.path(parts);
        if path.exists() {
            std::fs::remove_dir_all(&path).unwrap();
        }
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&path).arg(&self.outside).output().map(|o| o.status.success()).unwrap_or(false)
    }
    fn supports(&self, capability: &str) -> bool {
        capability == "links"
    }
}

// --- Exécution de la table ----------------------------------------------------------------------------------------------------

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("tableau").iter().map(|v| v.as_str().expect("chaîne").to_owned()).collect()
}

fn error_name(error: FsError) -> &'static str {
    match error {
        FsError::NotFound => "not-found",
        FsError::Exists => "exists",
        FsError::Unsafe => "unsafe",
        FsError::CloudPending => "cloud-pending",
        FsError::TooLarge => "too-large",
        FsError::Unreachable => "unreachable",
        FsError::ProviderStopped => "provider-stopped",
        FsError::CloudError => "cloud-error",
        FsError::Io => "io",
    }
}

/// Résultat d'une étape, comparable à `expect`.
enum Outcome {
    Ok,
    Names(Vec<String>),
    Bytes { text: Vec<u8>, size: Option<u64>, eof: Option<bool> },
    Removed(bool),
    Error(FsError),
}

fn run_step(world: &dyn World, step: &Value) -> Outcome {
    let fs = world.fs();
    let path_owned = step.get("path").map(strings).unwrap_or_default();
    let path: Vec<&str> = path_owned.iter().map(String::as_str).collect();
    let text = step.get("text").and_then(Value::as_str).unwrap_or_default();
    let result = match step["op"].as_str().expect("op") {
        "list" => fs.list(&path, 100).map(|listing| {
            let mut names: Vec<String> = listing
                .entries
                .iter()
                .map(|e| match e.availability {
                    Availability::Error => format!("{}!", e.name),
                    Availability::Cloud => format!("{}~", e.name),
                    Availability::Local if e.is_dir => format!("{}/", e.name),
                    Availability::Local => e.name.clone(),
                })
                .collect();
            names.sort();
            Outcome::Names(names)
        }),
        "read" => fs
            .read(&path, step["limit"].as_u64().unwrap(), step["hydrate"].as_bool().unwrap())
            .map(|bytes| Outcome::Bytes { text: bytes, size: None, eof: None }),
        "readFrom" => fs
            .read_from(&path, step["offset"].as_u64().unwrap(), step["max"].as_u64().unwrap() as usize, step.get("hydrate").and_then(Value::as_bool).unwrap_or(false))
            .map(|chunk| Outcome::Bytes { text: chunk.bytes, size: Some(chunk.size), eof: Some(chunk.eof) }),
        "readHead" => fs.read_head(&path, step["max"].as_u64().unwrap() as usize).map(|bytes| Outcome::Bytes { text: bytes, size: None, eof: None }),
        "append" => {
            let mode = if step["create"].as_bool().unwrap() { AppendMode::CreateNew } else { AppendMode::Existing };
            fs.append(&path, text.as_bytes(), mode).map(|()| Outcome::Ok)
        }
        "writeAtomic" => fs.write_atomic(&path, text.as_bytes()).map(|()| Outcome::Ok),
        "rename" => {
            let dir = strings(&step["dir"]);
            let dir: Vec<&str> = dir.iter().map(String::as_str).collect();
            fs.rename(&dir, step["from"].as_str().unwrap(), step["to"].as_str().unwrap()).map(|()| Outcome::Ok)
        }
        "createDir" => fs.create_dir(&path).map(|()| Outcome::Ok),
        "remove" => fs.remove_file(&path).map(Outcome::Removed),
        "removeEmptyDir" => fs.remove_empty_dir(&path).map(|()| Outcome::Ok),
        "makeLink" => {
            assert!(world.link(&path), "lien impossible à créer");
            Ok(Outcome::Ok)
        }
        other => panic!("opération inconnue : {other}"),
    };
    result.unwrap_or_else(Outcome::Error)
}

fn check(case: &str, implementation: &str, index: usize, outcome: Outcome, expect: &Value) {
    let at = format!("{implementation} : « {case} », étape {index}");
    if let Some(name) = expect.get("error").and_then(Value::as_str) {
        match outcome {
            Outcome::Error(error) => assert_eq!(error_name(error), name, "{at}"),
            _ => panic!("{at} : erreur {name} attendue"),
        }
        return;
    }
    if let Some(code) = expect.get("errorCode").and_then(Value::as_str) {
        match outcome {
            Outcome::Error(error) => assert_eq!(error.code().as_str(), code, "{at}"),
            _ => panic!("{at} : code {code} attendu"),
        }
        return;
    }
    match outcome {
        Outcome::Error(error) => panic!("{at} : erreur inattendue {}", error_name(error)),
        Outcome::Ok => assert_eq!(expect.get("ok"), Some(&Value::Bool(true)), "{at}"),
        Outcome::Names(names) => assert_eq!(names, strings(&expect["names"]), "{at}"),
        Outcome::Removed(removed) => assert_eq!(Some(removed), expect["removed"].as_bool(), "{at}"),
        Outcome::Bytes { text, size, eof } => {
            assert_eq!(String::from_utf8(text).unwrap(), expect["text"].as_str().unwrap(), "{at}");
            if let Some(expected) = expect.get("size").and_then(Value::as_u64) {
                assert_eq!(size, Some(expected), "{at} : taille");
            }
            if let Some(expected) = expect.get("eof").and_then(Value::as_bool) {
                assert_eq!(eof, Some(expected), "{at} : fin");
            }
        }
    }
}

/// Rejoue toute la table sur une implémentation ; rend (cas joués, cas sautés).
fn run_table(implementation: &str, make: &dyn Fn() -> Box<dyn World>) -> (usize, usize) {
    let table: Value = serde_json::from_str(TABLE).expect("table JSON");
    let (mut played, mut skipped) = (0, 0);
    for case in table["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let world = make();
        let requires = case.get("requires").map(strings).unwrap_or_default();
        if requires.iter().any(|capability| !world.supports(capability)) {
            skipped += 1;
            continue;
        }
        for item in case["setup"].as_array().unwrap() {
            if let Some(parts) = item.get("mkdir") {
                let parts = strings(parts);
                world.mkdir(&parts.iter().map(String::as_str).collect::<Vec<_>>());
            } else if let Some(parts) = item.get("file") {
                let parts = strings(parts);
                world.file(
                    &parts.iter().map(String::as_str).collect::<Vec<_>>(),
                    item["text"].as_str().unwrap(),
                    item.get("cloud").and_then(Value::as_bool).unwrap_or(false),
                    item.get("delayMs").and_then(Value::as_u64).unwrap_or(0),
                );
            } else if let Some(parts) = item.get("link") {
                let parts = strings(parts);
                assert!(world.link(&parts.iter().map(String::as_str).collect::<Vec<_>>()), "{implementation} : lien impossible ({name})");
            }
        }
        world.fs().start_cycle().expect("racine joignable");
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            world.before_step();
            let outcome = run_step(world.as_ref(), step);
            check(name, implementation, index, outcome, &step["expect"]);
        }
        played += 1;
    }
    (played, skipped)
}

#[test]
fn y_ios_01_2_conformance_table_on_the_in_memory_sync_fs() {
    let (played, skipped) = run_table("mémoire", &|| Box::new(MemWorld::new()));
    assert!(played >= 14, "cas joués : {played}");
    assert_eq!(skipped, 2, "liens : impossibles dans le dossier en mémoire");
}

#[test]
fn y_ios_01_2_conformance_table_on_bookmark_fs_with_the_fake_plugin() {
    let (played, skipped) = run_table("BookmarkFs", &|| Box::new(BookmarkWorld::new()));
    assert_eq!(skipped, 0, "BookmarkFs : tous les cas");
    assert!(played >= 16, "cas joués : {played}");
}

#[cfg(windows)]
#[test]
fn y_ios_01_2_conformance_table_on_std_fs() {
    let (played, skipped) = run_table("StdFs", &|| Box::new(StdWorld::new()));
    assert_eq!(skipped, 3, "StdFs : fichiers dans le nuage impossibles sur un disque local");
    assert!(played >= 13, "cas joués : {played}");
}
