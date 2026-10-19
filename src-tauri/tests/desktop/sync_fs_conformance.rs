//! Conformité de `SyncFs` (ADR 0011 §22 point 4 ; Y-IOS-01 critère 2) : la table `tests/fixtures/sync/syncfs-conformance.json` est rejouée
//! sur `StdFs` (dossier temporaire Windows, liens par jonction), sur `BookmarkFs` avec le faux du plugin (contrat JSON contrôlé à chaque
//! appel) et sur le `SyncFs` en mémoire des tests. Une table, trois implémentations, mêmes résultats attendus ; un cas qui exige une
//! capacité absente (fichier « dans le nuage » sur un vrai disque, lien dans le dossier en mémoire) est sauté pour cette implémentation
//! seulement, et compté.
//!
//! Y-TECH-03 (B13), phase B : la même fixture porte aussi `faultCases`, des cas de pannes d'iCloud armés par un plan au format de
//! `tests/fixtures/sync/fault-plan.json` (suppression en échec, résurrection après N cycles, éviction, substitut, écriture refusée,
//! écrasement, téléchargement en échec). Ils sont rejoués sur les trois implémentations Rust avec les mêmes codes d'erreur et les mêmes
//! listings que la lecture TypeScript (`src/platform/sync/syncFsConformance.test.ts`, `memory.ts`) : `MemFs` et le faux du plugin
//! rejouent le plan eux-mêmes ; `StdFs` passe par une enveloppe d'injection au-dessus du vrai disque. Un cas qu'une implémentation ne
//! peut pas rejouer est déclaré `notApplicable` avec sa raison dans la fixture : un cas sauté sans déclaration fait échouer le test.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::bookmark::BookmarkFs;
use circletasks_lib::sync::files::{AppendMode, Availability, FsError, SyncFs};
use serde_json::Value;

use crate::support::fake_bookmark::{FakePlugin, SharedPlugin, BOOKMARK, ROOT};
use crate::support::fault_plan::{self, Plan};
use crate::sync_support::{MemFs, SharedFs};

const TABLE: &str = include_str!("../../../tests/fixtures/sync/syncfs-conformance.json");
/// Le plan de pannes de référence : chaque faux (MemFs, FakePlugin) le charge ici, avec la table (critère 18 de Y-TECH-03).
const REFERENCE_PLANS: &str = include_str!("../../../tests/fixtures/sync/fault-plan.json");

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
    /// Arme un plan de pannes (cas `faultCases`) ; message qui nomme l'entrée si l'implémentation ne sait pas la rejouer.
    fn arm(&self, plan: Plan) -> Result<(), String>;
    /// Un cycle d'iCloud (compteur des résurrections).
    fn advance_cycle(&self);
    /// Entrées du plan jamais déclenchées.
    fn unfired(&self) -> Vec<String>;
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
        // `read-rank-without-hydration` : une lecture sans hydratation d'un fichier dans le nuage passe par le faux (le rang est compté).
        capability == "cloud" || capability == "read-rank-without-hydration"
    }
    fn before_step(&self) {
        if !self.slow.lock().unwrap().is_empty() {
            *self.mem.hydrate_error.lock().unwrap() = Some(FsError::CloudPending);
        }
    }
    fn arm(&self, plan: Plan) -> Result<(), String> {
        self.mem.arm(plan)
    }
    fn advance_cycle(&self) {
        self.mem.advance_cycle();
    }
    fn unfired(&self) -> Vec<String> {
        self.mem.unfired()
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
    fn supports(&self, capability: &str) -> bool {
        // BookmarkFs ne demande rien au plugin pour lire sans hydratation un fichier dans le nuage (statut « cloud » → cloud-pending côté
        // Rust) : le faux ne voit aucun appel, le rang n'est pas compté (cas déclaré non applicable dans la table, revue I4).
        capability != "read-rank-without-hydration"
    }
    fn arm(&self, plan: Plan) -> Result<(), String> {
        self.plugin.arm(plan)
    }
    fn advance_cycle(&self) {
        self.plugin.advance_cycle();
    }
    fn unfired(&self) -> Vec<String> {
        self.plugin.unfired()
    }
}

// --- StdFs (Windows) ----------------------------------------------------------------------------------------------------------

/// Enveloppe d'injection de pannes au-dessus du vrai disque (Y-TECH-03) : les opérations passent par `StdFs` (vrais fichiers, vrais
/// listings), les pannes `error`, `accept-not-propagated` et `overwrite-before-read` du plan sont rejouées par rang d'appel avant ou à la
/// place de l'appel réel. Un disque local n'a ni fichier évincé, ni substitut, ni téléchargement : ces effets sont refusés à l'armement.
#[cfg(windows)]
type DeferredDeletes = Vec<(Vec<String>, Vec<u8>, u64)>;

#[cfg(windows)]
struct FaultyStd {
    inner: circletasks_lib::sync::files::StdFs,
    armed: Mutex<Option<fault_plan::Armed>>,
    /// Suppressions acceptées mais non propagées : (chemin, contenu, cycles restants).
    back: Mutex<DeferredDeletes>,
}

#[cfg(windows)]
impl FaultyStd {
    fn new(inner: circletasks_lib::sync::files::StdFs) -> Self {
        Self { inner, armed: Mutex::new(None), back: Mutex::new(Vec::new()) }
    }

    fn arm(&self, plan: Plan) -> Result<(), String> {
        fault_plan::refuse_unreplayable(&plan, "StdFs")?;
        if let Some(entry) = plan.faults.iter().find(|e| matches!(e.effect, fault_plan::Effect::EvictAfterRead | fault_plan::Effect::Placeholder | fault_plan::Effect::DownloadError)) {
            return Err(format!("plan « {} », entrée « {} » : effet non rejouable par StdFs (un disque local n'a ni fichier évincé, ni substitut, ni téléchargement)", plan.name, entry.id));
        }
        *self.armed.lock().unwrap() = Some(fault_plan::Armed::new(plan));
        Ok(())
    }

    fn hit(&self, op: fault_plan::Op, path: &str) -> Option<fault_plan::Entry> {
        self.armed.lock().unwrap().as_mut().and_then(|armed| armed.hit(op, path))
    }

    fn unfired(&self) -> Vec<String> {
        self.armed.lock().unwrap().as_ref().map(fault_plan::Armed::unfired).unwrap_or_default()
    }

    fn exists(&self, file: &[&str]) -> bool {
        self.inner.read_head(file, 0).is_ok()
    }

    fn advance_cycle(&self) {
        let mut back = self.back.lock().unwrap();
        for pending in back.iter_mut() {
            pending.2 -= 1;
        }
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut *back).into_iter().partition(|p| p.2 == 0);
        *back = waiting;
        for (path, bytes, _) in due {
            let parts: Vec<&str> = path.iter().map(String::as_str).collect();
            self.inner.write_atomic(&parts, &bytes).expect("retour du fichier supprimé non propagé");
        }
    }

    /// Panne de lecture d'un fichier présent : `error`, ou `overwrite-before-read` (le fichier est réécrit avant la lecture).
    fn read_gate(&self, file: &[&str]) -> Result<(), FsError> {
        if !self.exists(file) {
            return Ok(());
        }
        match self.hit(fault_plan::Op::Read, &fault_plan::file_path(file)).map(|entry| entry.effect) {
            Some(fault_plan::Effect::Error(code)) => Err(plan_error(code)),
            Some(fault_plan::Effect::OverwriteBeforeRead { content }) => self.inner.write_atomic(file, &fault_plan::overwrite_bytes(&content)),
            _ => Ok(()),
        }
    }
}

#[cfg(windows)]
fn plan_error(code: fault_plan::Code) -> FsError {
    match code {
        fault_plan::Code::Io => FsError::Io,
        fault_plan::Code::CloudPending => FsError::CloudPending,
    }
}

#[cfg(windows)]
impl SyncFs for FaultyStd {
    fn check_root(&self) -> Result<(), FsError> {
        self.inner.check_root()
    }
    fn start_cycle(&self) -> Result<(), FsError> {
        self.inner.start_cycle()
    }
    fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
        self.inner.read_head(file, max)
    }
    fn list(&self, dir: &[&str], max: usize) -> Result<circletasks_lib::sync::files::Listing, FsError> {
        if let Some(fault_plan::Effect::Error(code)) = self.hit(fault_plan::Op::List, &fault_plan::dir_path(dir)).map(|entry| entry.effect) {
            return Err(plan_error(code));
        }
        self.inner.list(dir, max)
    }
    fn read(&self, file: &[&str], limit: u64, hydrate: bool) -> Result<Vec<u8>, FsError> {
        self.read_gate(file)?;
        self.inner.read(file, limit, hydrate)
    }
    fn read_from(&self, file: &[&str], offset: u64, max: usize, hydrate: bool) -> Result<circletasks_lib::sync::files::Chunk, FsError> {
        if offset == 0 {
            self.read_gate(file)?;
        }
        self.inner.read_from(file, offset, max, hydrate)
    }
    fn append(&self, file: &[&str], bytes: &[u8], mode: AppendMode) -> Result<(), FsError> {
        let exists = self.exists(file);
        if exists == (mode == AppendMode::Existing) {
            if let Some(entry) = self.hit(fault_plan::Op::Write, &fault_plan::file_path(file)) {
                if let fault_plan::Effect::Error(code) = entry.effect {
                    if entry.partial_last_line {
                        // Ajout coupé : les octets partiels doivent arriver sur le disque, sinon le cas ne prouve rien (jamais avalé).
                        self.inner.append(file, &fault_plan::partial_tail(bytes), mode).expect("écriture de la ligne incomplète armée par le plan");
                    }
                    return Err(plan_error(code));
                }
            }
        }
        self.inner.append(file, bytes, mode)
    }
    fn write_atomic(&self, file: &[&str], bytes: &[u8]) -> Result<(), FsError> {
        if let Some(fault_plan::Effect::Error(code)) = self.hit(fault_plan::Op::Write, &fault_plan::file_path(file)).map(|entry| entry.effect) {
            return Err(plan_error(code));
        }
        self.inner.write_atomic(file, bytes)
    }
    fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError> {
        let mut target: Vec<&str> = dir.to_vec();
        target.push(to);
        if let Some(fault_plan::Effect::Error(code)) = self.hit(fault_plan::Op::Rename, &fault_plan::file_path(&target)).map(|entry| entry.effect) {
            return Err(plan_error(code));
        }
        self.inner.rename(dir, from, to)
    }
    fn create_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        self.inner.create_dir(dir)
    }
    fn remove_file(&self, file: &[&str]) -> Result<bool, FsError> {
        if !self.exists(file) {
            return self.inner.remove_file(file);
        }
        let entry = self.hit(fault_plan::Op::Remove, &fault_plan::file_path(file));
        if let Some(fault_plan::Effect::Error(code)) = entry.as_ref().map(|e| &e.effect) {
            return Err(plan_error(*code));
        }
        let held = match entry.map(|e| e.effect) {
            Some(fault_plan::Effect::AcceptNotPropagated { resurrect_after_cycles }) if resurrect_after_cycles > 0 => Some((self.inner.read(file, u64::MAX, false)?, resurrect_after_cycles)),
            _ => None,
        };
        let removed = self.inner.remove_file(file)?;
        if let Some((bytes, left)) = held {
            self.back.lock().unwrap().push((file.iter().map(|p| (*p).to_owned()).collect(), bytes, left));
        }
        Ok(removed)
    }
    fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        self.inner.remove_empty_dir(dir)
    }
    fn pin(&self, file: &[&str]) -> Result<(), FsError> {
        self.inner.pin(file)
    }
}

#[cfg(windows)]
struct StdWorld {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
    fs: FaultyStd,
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
        let fs = FaultyStd::new(circletasks_lib::sync::files::StdFs::new(check_sync_path(&root).unwrap().path));
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
    fn arm(&self, plan: Plan) -> Result<(), String> {
        self.fs.arm(plan)
    }
    fn advance_cycle(&self) {
        self.fs.advance_cycle();
    }
    fn unfired(&self) -> Vec<String> {
        self.fs.unfired()
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
        "advanceCycle" => {
            world.advance_cycle();
            Ok(Outcome::Ok)
        }
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
        prepare(world.as_ref(), case, implementation);
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

/// Prépare le dossier d'un cas (`setup`).
fn prepare(world: &dyn World, case: &Value, implementation: &str) {
    let name = case["name"].as_str().unwrap();
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
}

/// Cas de pannes (`faultCases`) : (joués, déclarés non applicables avec leur raison). Un cas qui exige une capacité absente sans être
/// déclaré `notApplicable` pour cette implémentation fait échouer le test (jamais ignoré en silence) ; une raison vide aussi.
fn run_fault_table(implementation: &str, make: &dyn Fn() -> Box<dyn World>) -> (usize, Vec<(String, String)>) {
    let table: Value = serde_json::from_str(TABLE).expect("table JSON");
    let (mut played, mut declared) = (0, Vec::new());
    for case in table["faultCases"].as_array().expect("faultCases") {
        let name = case["name"].as_str().unwrap();
        let world = make();
        let requires = case.get("requires").map(strings).unwrap_or_default();
        let unmet = requires.iter().any(|capability| !world.supports(capability));
        if let Some(reason) = case.get("notApplicable").and_then(|n| n.get(implementation)) {
            let reason = reason.as_str().unwrap_or_default();
            assert!(!reason.trim().is_empty(), "{implementation} : « {name} » déclaré non applicable sans raison");
            declared.push((name.to_owned(), reason.to_owned()));
            continue;
        }
        assert!(!unmet, "{implementation} : « {name} » exige {requires:?} et n'est pas déclaré notApplicable pour cette implémentation");
        prepare(world.as_ref(), case, implementation);
        let plan = fault_plan::parse_plan(&case["plan"]).unwrap_or_else(|e| panic!("{implementation} : « {name} » : {e}"));
        world.arm(plan).unwrap_or_else(|e| panic!("{implementation} : « {name} » : {e}"));
        world.fs().start_cycle().expect("racine joignable");
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            world.before_step();
            let outcome = run_step(world.as_ref(), step);
            check(name, implementation, index, outcome, &step["expect"]);
        }
        // Aucune panne armée restée sans effet : une entrée jamais déclenchée serait une panne ignorée en silence.
        assert_eq!(world.unfired(), Vec::<String>::new(), "{implementation} : « {name} » : entrées du plan jamais déclenchées");
        played += 1;
    }
    (played, declared)
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

// --- Y-TECH-03 (B13), critères 16 à 18 : cas de pannes sur les trois implémentations Rust ---------------------------------------

fn fault_case_count() -> usize {
    let table: Value = serde_json::from_str(TABLE).expect("table JSON");
    table["faultCases"].as_array().expect("faultCases").len()
}

#[test]
fn y_tech_03_16_fault_cases_on_the_in_memory_sync_fs() {
    let (played, declared) = run_fault_table("MemFs", &|| Box::new(MemWorld::new()));
    assert_eq!(declared, Vec::new(), "MemFs rejoue tous les cas de pannes");
    assert_eq!(played, fault_case_count());
    assert!(played >= 14, "cas de pannes joués : {played}");
}

#[test]
fn y_tech_03_16_fault_cases_on_bookmark_fs_with_the_fake_plugin() {
    let (played, declared) = run_fault_table("BookmarkFs", &|| Box::new(BookmarkWorld::new()));
    // Un seul cas déclaré : le rang d'une lecture sans hydratation d'un fichier dans le nuage (aucun appel au plugin à compter).
    assert_eq!(declared.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["lecture sans hydratation d’un fichier dans le nuage : le rang est consommé"], "BookmarkFs");
    assert_eq!(played + declared.len(), fault_case_count());
    assert!(played >= 14, "cas de pannes joués : {played}");
}

#[cfg(windows)]
#[test]
fn y_tech_03_16_fault_cases_on_std_fs_through_the_injection_wrapper() {
    let (played, declared) = run_fault_table("StdFs", &|| Box::new(StdWorld::new()));
    // Les six cas qui exigent un fichier dans le nuage (éviction, substitut ×3, téléchargement en échec, rang d'une lecture sans
    // hydratation) sont déclarés non applicables.
    assert_eq!(declared.len(), 6, "StdFs : cas déclarés non applicables : {declared:?}");
    assert_eq!(played + declared.len(), fault_case_count());
    assert!(played >= 9, "cas de pannes joués : {played}");
}

#[test]
fn y_tech_03_16_not_applicable_declarations_name_a_known_implementation_and_a_missing_capability() {
    let table: Value = serde_json::from_str(TABLE).expect("table JSON");
    for case in table["faultCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let requires = case.get("requires").map(strings).unwrap_or_default();
        let Some(declared) = case.get("notApplicable").and_then(Value::as_object) else { continue };
        for (implementation, reason) in declared {
            assert!(["StdFs", "BookmarkFs", "MemFs", "memory.ts"].contains(&implementation.as_str()), "« {name} » : implémentation inconnue « {implementation} »");
            assert!(reason.as_str().is_some_and(|r| !r.trim().is_empty()), "« {name} » : raison absente pour {implementation}");
            // Une déclaration n'est acceptée que si l'implémentation n'a vraiment pas la capacité exigée.
            let world: Box<dyn World> = match implementation.as_str() {
                "MemFs" => Box::new(MemWorld::new()),
                "BookmarkFs" => Box::new(BookmarkWorld::new()),
                #[cfg(windows)]
                "StdFs" => Box::new(StdWorld::new()),
                _ => continue,
            };
            assert!(requires.iter().any(|capability| !world.supports(capability)), "« {name} » : déclaré non applicable pour {implementation} qui sait le rejouer");
        }
    }
}

/// Critère 18 : le faux en mémoire et le faux du plugin chargent la table ET le plan de pannes de référence (ce fichier fait
/// `include_str!` des deux et exerce `MemFs` et `FakePlugin`) ; tous les plans de référence s'arment, sauf `mute` refusé par une
/// erreur qui nomme le plan et l'entrée.
#[test]
fn y_tech_03_18_every_rust_fake_loads_the_conformance_table_and_the_reference_fault_plans() {
    let plans = fault_plan::parse_file(REFERENCE_PLANS).expect("fault-plan.json lisible strictement");
    assert!(plans.len() >= 11, "plans de référence : {}", plans.len());
    let table: Value = serde_json::from_str(TABLE).expect("table JSON");
    for case in table["faultCases"].as_array().unwrap() {
        fault_plan::parse_plan(&case["plan"]).unwrap_or_else(|e| panic!("{} : {e}", case["name"]));
    }
    let clock = Arc::new(AtomicU64::new(1_000_000));
    for plan in plans {
        let mute = plan.faults.iter().find(|entry| entry.effect == fault_plan::Effect::Mute).map(|entry| entry.id.clone());
        let armed = [
            ("MemFs", MemFs::new().arm(plan.clone())),
            ("fake_bookmark", FakePlugin::new(clock.clone()).arm(plan.clone())),
        ];
        for (fake, result) in armed {
            match (&mute, result) {
                (None, result) => assert_eq!(result, Ok(()), "{fake} : plan « {} »", plan.name),
                (Some(id), Err(message)) => assert!(message.contains(id) && message.contains(&plan.name) && message.contains("mute"), "{fake} : {message}"),
                (Some(id), Ok(())) => panic!("{fake} : plan « {} » : l'entrée mute « {id} » aurait dû être refusée", plan.name),
            }
        }
    }
}
