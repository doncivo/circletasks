//! Outils des tests de synchronisation (lot Y1) : `SyncFs` en mémoire (balises cloud et placeholders simulés), contrôle de dossier
//! factice, confirmation native injectée, horloge contrôlée, service prêt à l'emploi.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use circletasks_lib::sync::consent::{ConsentGate, ConsentUi, DialogSpec};
use circletasks_lib::sync::files::{AppendMode, Availability, Chunk, FsEntry, FsError, Listing, SyncFs};
use circletasks_lib::sync::folder::{CheckedFolder, FolderKind};
use circletasks_lib::sync::service::{FolderBackend, SyncCore, SyncOptions};
use circletasks_lib::sync::{fail, SyncCode, SyncResult};
use circletasks_lib::vault::MemoryVault;

use crate::support::fault_plan::{self, Armed, Code, Effect, Entry, Firing, Op, Plan};

pub const DEV_A: &str = "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
pub const DEV_B: &str = "7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e";
pub const DEV_C: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

pub fn epoch(n: u32, dev: &str) -> String {
    format!("e{n:04}-{dev}")
}

/// hlc strict : `<15 chiffres>-<4 hexa>-<uuid>`.
pub fn hlc(ms: u64, dev: &str) -> String {
    format!("{ms:015}-0000-{dev}")
}

// ------------------------------------------------------------------------------------------------------------------------------
// SyncFs en mémoire
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
enum Node {
    Dir,
    File { bytes: Vec<u8>, availability: Availability, extra: u64 },
}

/// Pannes d'iCloud armées par un plan (Y-TECH-03, `tests/fixtures/sync/fault-plan.json`) : sans plan, le faux est complaisant, comme avant.
#[derive(Default)]
struct MemFaults {
    armed: Option<Armed>,
    /// Fichiers évincés par iOS (« optimiser le stockage ») : l'équivalent du substitut `.<nom>.icloud`, listé sous son vrai nom en `cloud`.
    evicted: BTreeSet<String>,
    /// Évictions décidées à la lecture, exécutées à la fin de la lecture (dernière page).
    evict_pending: BTreeSet<String>,
    /// Suppressions acceptées mais non propagées : le fichier revient après `left` appels de `advance_cycle`.
    back: Vec<Resurrection>,
}

struct Resurrection {
    key: String,
    node: Node,
    evicted: bool,
    left: u64,
}

impl MemFaults {
    fn hit(&mut self, op: Op, path: &str) -> Option<Entry> {
        self.armed.as_mut().and_then(|armed| armed.hit(op, path))
    }
}

fn code_error(code: Code) -> FsError {
    match code {
        Code::Io => FsError::Io,
        Code::CloudPending => FsError::CloudPending,
    }
}

/// Dossier simulé : chemins `a/b/c`, fichiers « dans le nuage », erreurs d'hydratation, échec de revalidation.
#[derive(Default)]
pub struct MemFs {
    nodes: Mutex<BTreeMap<String, Node>>,
    pub hydrations: AtomicUsize,
    pub pinned: Mutex<BTreeSet<String>>,
    /// Erreur rendue par la prochaine hydratation (puis effacée) ; `None` : le fichier devient local.
    pub hydrate_error: Mutex<Option<FsError>>,
    /// Erreur rendue par `revalidate` (dossier devenu jonction, démonté).
    pub revalidate_error: Mutex<Option<FsError>>,
    pub writes: AtomicUsize,
    /// Lectures de fichiers (revue 15 : un instantané lu par pages n'est relu qu'une fois).
    pub reads: AtomicUsize,
    /// Chemins lus par `read`, dans l'ordre (Y-10, troisième revue : une lecture complète par instantané et par session).
    pub read_log: Mutex<Vec<String>>,
    /// Lectures d'en-tête (`read_head`) et cycles d'hydratation ouverts (`start_cycle`).
    pub head_reads: AtomicUsize,
    pub cycles: AtomicUsize,
    faults: Mutex<MemFaults>,
}

fn key(parts: &[&str]) -> String {
    parts.join("/")
}

impl MemFs {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn put(&self, parts: &[&str], bytes: &[u8]) {
        let mut nodes = self.nodes.lock().unwrap();
        for i in 1..parts.len() {
            nodes.entry(key(&parts[..i])).or_insert(Node::Dir);
        }
        nodes.insert(key(parts), Node::File { bytes: bytes.to_vec(), availability: Availability::Local, extra: 0 });
        self.faults.lock().unwrap().evicted.remove(&key(parts));
    }

    pub fn mkdir(&self, parts: &[&str]) {
        let mut nodes = self.nodes.lock().unwrap();
        for i in 1..=parts.len() {
            nodes.entry(key(&parts[..i])).or_insert(Node::Dir);
        }
    }

    pub fn get(&self, parts: &[&str]) -> Option<Vec<u8>> {
        match self.nodes.lock().unwrap().get(&key(parts)) {
            Some(Node::File { bytes, .. }) => Some(bytes.clone()),
            _ => None,
        }
    }

    pub fn set_availability(&self, parts: &[&str], value: Availability) {
        if let Some(Node::File { availability, .. }) = self.nodes.lock().unwrap().get_mut(&key(parts)) {
            *availability = value;
        }
    }

    /// Taille annoncée gonflée (placeholder qui annonce plus que la borne).
    pub fn set_extra(&self, parts: &[&str], bytes: u64) {
        if let Some(Node::File { extra, .. }) = self.nodes.lock().unwrap().get_mut(&key(parts)) {
            *extra = bytes;
        }
    }

    pub fn truncate(&self, parts: &[&str], len: usize) {
        if let Some(Node::File { bytes, .. }) = self.nodes.lock().unwrap().get_mut(&key(parts)) {
            bytes.truncate(len);
        }
    }

    pub fn remove(&self, parts: &[&str]) {
        self.nodes.lock().unwrap().remove(&key(parts));
    }

    /// Tous les fichiers et leur contenu (recherche d'octets dans tout le dossier).
    pub fn all_files(&self) -> Vec<(String, Vec<u8>)> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(k, n)| match n {
                Node::File { bytes, .. } => Some((k.clone(), bytes.clone())),
                Node::Dir => None,
            })
            .collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.nodes.lock().unwrap().keys().cloned().collect()
    }

    // --- Y-TECH-03 : pannes d'iCloud armées par un plan ---------------------------------------------------------------------------

    /// Arme un plan de pannes (remplace le précédent, compteurs à zéro). Une entrée que ce faux ne sait pas rejouer (`mute`) est refusée
    /// avec un message qui la nomme.
    pub fn arm(&self, plan: Plan) -> Result<(), String> {
        fault_plan::refuse_unreplayable(&plan, "MemFs")?;
        self.faults.lock().unwrap().armed = Some(Armed::new(plan));
        Ok(())
    }

    /// Arme un plan de `fault-plan.json` par son nom.
    pub fn arm_reference(&self, name: &str) -> Result<(), String> {
        self.arm(fault_plan::reference_plan(name))
    }

    /// Retire le plan : le faux redevient complaisant (résurrections en attente conservées).
    pub fn disarm(&self) {
        self.faults.lock().unwrap().armed = None;
    }

    /// Pannes rejouées depuis l'armement (entrée, opération, chemin, rang).
    pub fn fired(&self) -> Vec<Firing> {
        self.faults.lock().unwrap().armed.as_ref().map(Armed::fired).unwrap_or_default()
    }

    /// Entrées du plan jamais déclenchées.
    pub fn unfired(&self) -> Vec<String> {
        self.faults.lock().unwrap().armed.as_ref().map(Armed::unfired).unwrap_or_default()
    }

    /// Un cycle d'iCloud (compteur explicite, jamais une durée) : chaque suppression acceptée mais non propagée se rapproche de son retour ;
    /// arrivée à zéro, le fichier revient sous le même nom avec le même contenu. Rend le nombre de fichiers revenus.
    pub fn advance_cycle(&self) -> usize {
        let mut nodes = self.nodes.lock().unwrap();
        let mut faults = self.faults.lock().unwrap();
        for pending in &mut faults.back {
            pending.left -= 1;
        }
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut faults.back).into_iter().partition(|p| p.left == 0);
        faults.back = waiting;
        let count = due.len();
        for back in due {
            let parts: Vec<&str> = back.key.split('/').collect();
            for i in 1..parts.len() {
                nodes.entry(parts[..i].join("/")).or_insert(Node::Dir);
            }
            if back.evicted {
                faults.evicted.insert(back.key.clone());
            }
            nodes.insert(back.key, back.node);
        }
        count
    }

    /// Fichier évincé par le plan (substitut) ?
    pub fn is_evicted(&self, parts: &[&str]) -> bool {
        self.faults.lock().unwrap().evicted.contains(&key(parts))
    }

    /// Panne de lecture d'un fichier présent, avant l'hydratation : `error` rendue à l'appelant ; `overwrite-before-read` remplace le contenu
    /// (l'autre appareil a écrit entre le listage et la lecture) ; rend vrai si le fichier doit être évincé après la lecture.
    fn read_gate(&self, path: &str, bytes: &mut Vec<u8>) -> Result<bool, FsError> {
        match self.faults.lock().unwrap().hit(Op::Read, path).map(|entry| entry.effect) {
            Some(Effect::Error(code)) => Err(code_error(code)),
            Some(Effect::OverwriteBeforeRead { content }) => {
                *bytes = fault_plan::overwrite_bytes(&content);
                Ok(false)
            }
            Some(Effect::EvictAfterRead) => Ok(true),
            _ => Ok(false),
        }
    }

    /// Téléchargement tenté d'un fichier dans le nuage : `download-error` armé → `CloudError`, le fichier reste dans le nuage.
    fn hydrate_gate(&self, path: &str) -> Result<(), FsError> {
        match self.faults.lock().unwrap().hit(Op::Hydrate, path).map(|entry| entry.effect) {
            Some(Effect::DownloadError) => Err(FsError::CloudError),
            _ => Ok(()),
        }
    }

    /// Écriture refusée par le plan : (erreur, ligne incomplète laissée par un ajout coupé).
    fn write_gate(&self, path: &str) -> Option<(FsError, bool)> {
        let entry = self.faults.lock().unwrap().hit(Op::Write, path)?;
        match entry.effect {
            Effect::Error(code) => Some((code_error(code), entry.partial_last_line)),
            _ => None,
        }
    }

    fn parent_exists(nodes: &BTreeMap<String, Node>, parts: &[&str]) -> bool {
        parts.len() <= 1 || matches!(nodes.get(&key(&parts[..parts.len() - 1])), Some(Node::Dir))
    }
}

/// Partage d'un `MemFs` entre le test et le service.
pub struct SharedFs(pub Arc<MemFs>);

impl SyncFs for SharedFs {
    fn check_root(&self) -> Result<(), FsError> {
        match *self.0.revalidate_error.lock().unwrap() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn start_cycle(&self) -> Result<(), FsError> {
        self.0.cycles.fetch_add(1, Ordering::SeqCst);
        self.check_root()
    }

    fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
        self.0.head_reads.fetch_add(1, Ordering::SeqCst);
        let nodes = self.0.nodes.lock().unwrap();
        match nodes.get(&key(file)) {
            Some(Node::File { availability: Availability::Cloud, .. }) => Err(FsError::CloudPending),
            Some(Node::File { bytes, .. }) => Ok(bytes[..bytes.len().min(max)].to_vec()),
            _ => Err(FsError::NotFound),
        }
    }

    fn list(&self, dir: &[&str], max: usize) -> Result<Listing, FsError> {
        let mut nodes = self.0.nodes.lock().unwrap();
        let prefix = key(dir);
        if !dir.is_empty() && !matches!(nodes.get(&prefix), Some(Node::Dir)) {
            return Err(FsError::NotFound);
        }
        {
            // Pannes du plan : le dossier (`error`), puis un appel `list` par fichier listé (`placeholder` : évincé avant d'être présenté).
            let mut faults = self.0.faults.lock().unwrap();
            if faults.armed.is_some() {
                if let Some(Effect::Error(code)) = faults.hit(Op::List, &format!("{prefix}/")).map(|entry| entry.effect) {
                    return Err(code_error(code));
                }
                let inside = |path: &String| if dir.is_empty() { !path.contains('/') } else { path.strip_prefix(&format!("{prefix}/")).is_some_and(|rest| !rest.contains('/')) };
                let files: Vec<String> = nodes.iter().filter(|(path, node)| inside(path) && matches!(node, Node::File { .. })).map(|(path, _)| path.clone()).collect();
                for file in files {
                    if let Some(Effect::Placeholder) = faults.hit(Op::List, &file).map(|entry| entry.effect) {
                        if let Some(Node::File { availability, .. }) = nodes.get_mut(&file) {
                            *availability = Availability::Cloud;
                        }
                        faults.evicted.insert(file);
                    }
                }
            }
        }
        let mut listing = Listing::default();
        for (path, node) in nodes.iter() {
            let rest = if dir.is_empty() { Some(path.as_str()) } else { path.strip_prefix(&format!("{prefix}/")) };
            let Some(name) = rest.filter(|r| !r.contains('/')) else { continue };
            if listing.entries.len() >= max {
                listing.truncated = true;
                break;
            }
            listing.entries.push(match node {
                Node::Dir => FsEntry { name: name.to_owned(), is_dir: true, size: 0, availability: Availability::Local },
                Node::File { bytes, availability, extra } => FsEntry { name: name.to_owned(), is_dir: false, size: bytes.len() as u64 + extra, availability: *availability },
            });
        }
        Ok(listing)
    }

    fn read(&self, file: &[&str], limit: u64, hydrate: bool) -> Result<Vec<u8>, FsError> {
        self.0.reads.fetch_add(1, Ordering::SeqCst);
        self.0.read_log.lock().unwrap().push(key(file));
        let mut nodes = self.0.nodes.lock().unwrap();
        let path = key(file);
        let Some(Node::File { bytes, availability, extra }) = nodes.get_mut(&path) else { return Err(FsError::NotFound) };
        let evict = self.0.read_gate(&path, bytes)?;
        if bytes.len() as u64 + *extra > limit {
            return Err(FsError::TooLarge);
        }
        match *availability {
            Availability::Error => return Err(FsError::Unsafe),
            Availability::Cloud if !hydrate => return Err(FsError::CloudPending),
            Availability::Cloud => {
                self.0.hydrations.fetch_add(1, Ordering::SeqCst);
                if let Some(error) = self.0.hydrate_error.lock().unwrap().take() {
                    return Err(error);
                }
                self.0.hydrate_gate(&path)?;
                *availability = Availability::Local;
                self.0.faults.lock().unwrap().evicted.remove(&path);
            }
            Availability::Local => {}
        }
        let out = bytes.clone();
        if evict {
            *availability = Availability::Cloud;
            self.0.faults.lock().unwrap().evicted.insert(path);
        }
        Ok(out)
    }

    /// Lecture positionnée (ADR 0011 §22 point 4) : mêmes règles que `read` (taille annoncée, nuage, hydratation, erreur injectée). Une
    /// lecture qui commence à l'octet 0 compte comme une lecture du fichier (`reads`, `read_log`).
    fn read_from(&self, file: &[&str], offset: u64, max: usize, hydrate: bool) -> Result<Chunk, FsError> {
        if offset == 0 {
            self.0.reads.fetch_add(1, Ordering::SeqCst);
            self.0.read_log.lock().unwrap().push(key(file));
        }
        let mut nodes = self.0.nodes.lock().unwrap();
        let path = key(file);
        let Some(Node::File { bytes, availability, extra }) = nodes.get_mut(&path) else { return Err(FsError::NotFound) };
        // Une lecture par pages compte comme un seul appel `read` du plan (celui qui commence à l'octet 0).
        let evict = if offset == 0 { self.0.read_gate(&path, bytes)? } else { false };
        match *availability {
            Availability::Error => return Err(FsError::Unsafe),
            Availability::Cloud if !hydrate => return Err(FsError::CloudPending),
            Availability::Cloud => {
                self.0.hydrations.fetch_add(1, Ordering::SeqCst);
                if let Some(error) = self.0.hydrate_error.lock().unwrap().take() {
                    return Err(error);
                }
                self.0.hydrate_gate(&path)?;
                *availability = Availability::Local;
                self.0.faults.lock().unwrap().evicted.remove(&path);
            }
            Availability::Local => {}
        }
        let size = bytes.len() as u64 + *extra;
        let start = (offset as usize).min(bytes.len());
        let end = start.saturating_add(max).min(bytes.len());
        let out = bytes[start..end].to_vec();
        let eof = out.len() < max || offset + out.len() as u64 >= size;
        // Éviction après lecture : exécutée à la fin du fichier (dernière page).
        let mut faults = self.0.faults.lock().unwrap();
        if evict {
            faults.evict_pending.insert(path.clone());
        }
        if eof && faults.evict_pending.remove(&path) {
            *availability = Availability::Cloud;
            faults.evicted.insert(path);
        }
        Ok(Chunk { bytes: out, size, eof })
    }

    fn append(&self, file: &[&str], data: &[u8], mode: AppendMode) -> Result<(), FsError> {
        self.0.writes.fetch_add(1, Ordering::SeqCst);
        let mut nodes = self.0.nodes.lock().unwrap();
        if !MemFs::parent_exists(&nodes, file) {
            return Err(FsError::NotFound);
        }
        let path = key(file);
        match (nodes.get_mut(&path), mode) {
            (Some(_), AppendMode::CreateNew) => Err(FsError::Exists),
            (Some(Node::File { bytes, .. }), AppendMode::Existing) => {
                if let Some((error, partial)) = self.0.write_gate(&path) {
                    if partial {
                        bytes.extend_from_slice(&fault_plan::partial_tail(data));
                    }
                    return Err(error);
                }
                bytes.extend_from_slice(data);
                Ok(())
            }
            (None, AppendMode::CreateNew) => {
                if let Some((error, partial)) = self.0.write_gate(&path) {
                    if partial {
                        nodes.insert(path, Node::File { bytes: fault_plan::partial_tail(data), availability: Availability::Local, extra: 0 });
                    }
                    return Err(error);
                }
                nodes.insert(path, Node::File { bytes: data.to_vec(), availability: Availability::Local, extra: 0 });
                Ok(())
            }
            _ => Err(FsError::NotFound),
        }
    }

    fn write_atomic(&self, file: &[&str], data: &[u8]) -> Result<(), FsError> {
        self.0.writes.fetch_add(1, Ordering::SeqCst);
        let mut nodes = self.0.nodes.lock().unwrap();
        if !MemFs::parent_exists(&nodes, file) {
            return Err(FsError::NotFound);
        }
        if let Some((error, _)) = self.0.write_gate(&key(file)) {
            return Err(error);
        }
        nodes.insert(key(file), Node::File { bytes: data.to_vec(), availability: Availability::Local, extra: 0 });
        self.0.faults.lock().unwrap().evicted.remove(&key(file));
        Ok(())
    }

    fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError> {
        let mut nodes = self.0.nodes.lock().unwrap();
        let mut a: Vec<&str> = dir.to_vec();
        a.push(from);
        let mut b: Vec<&str> = dir.to_vec();
        b.push(to);
        if nodes.contains_key(&key(&a)) {
            let refused = self.0.faults.lock().unwrap().hit(Op::Rename, &key(&b));
            if let Some(Effect::Error(code)) = refused.map(|entry| entry.effect) {
                return Err(code_error(code));
            }
        }
        let node = nodes.remove(&key(&a)).ok_or(FsError::NotFound)?;
        nodes.insert(key(&b), node);
        let mut faults = self.0.faults.lock().unwrap();
        faults.evicted.remove(&key(&b));
        if faults.evicted.remove(&key(&a)) {
            faults.evicted.insert(key(&b));
        }
        Ok(())
    }

    fn create_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        self.0.mkdir(dir);
        Ok(())
    }

    fn remove_file(&self, file: &[&str]) -> Result<bool, FsError> {
        let mut nodes = self.0.nodes.lock().unwrap();
        let path = key(file);
        if matches!(nodes.get(&path), Some(Node::File { .. })) {
            // Pannes du plan : `error` (le fichier reste listé et lisible), mode historique d'un substitut (rien supprimé),
            // `accept-not-propagated` (supprimé ici, revient après N cycles ; N = 0 : jamais).
            let mut faults = self.0.faults.lock().unwrap();
            let entry = faults.hit(Op::Remove, &path);
            if let Some(Effect::Error(code)) = entry.as_ref().map(|e| &e.effect) {
                return Err(code_error(*code));
            }
            let evicted = faults.evicted.remove(&path);
            if evicted && faults.armed.as_ref().is_some_and(|armed| armed.plan.remove_leaves_placeholder) {
                faults.evicted.insert(path);
                return Ok(false);
            }
            let node = nodes.remove(&path).expect("fichier présent");
            if let Some(Effect::AcceptNotPropagated { resurrect_after_cycles }) = entry.map(|e| e.effect) {
                if resurrect_after_cycles > 0 {
                    faults.back.push(Resurrection { key: path, node, evicted, left: resurrect_after_cycles });
                }
            }
            return Ok(true);
        }
        nodes.remove(&path);
        Ok(false)
    }

    fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError> {
        let mut nodes = self.0.nodes.lock().unwrap();
        let prefix = format!("{}/", key(dir));
        if !nodes.keys().any(|k| k.starts_with(&prefix)) {
            nodes.remove(&key(dir));
        }
        Ok(())
    }

    fn pin(&self, file: &[&str]) -> Result<(), FsError> {
        self.0.pinned.lock().unwrap().insert(key(file));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Contrôle de dossier factice, confirmation, horloge
// ------------------------------------------------------------------------------------------------------------------------------

/// Dossiers connus : chemin → (nature, `MemFs`) ; tout autre chemin est introuvable.
#[derive(Default)]
pub struct FakeBackend {
    pub folders: Mutex<BTreeMap<PathBuf, (FolderKind, Arc<MemFs>)>>,
    pub refuse: Mutex<Option<SyncCode>>,
}

impl FakeBackend {
    pub fn with(path: &str, kind: FolderKind, fs: Arc<MemFs>) -> Arc<Self> {
        let backend = Arc::new(Self::default());
        backend.add(path, kind, fs);
        backend
    }

    pub fn add(&self, path: &str, kind: FolderKind, fs: Arc<MemFs>) {
        self.folders.lock().unwrap().insert(PathBuf::from(path), (kind, fs));
    }
}

impl FolderBackend for FakeBackend {
    fn check(&self, path: &Path) -> SyncResult<CheckedFolder> {
        if let Some(code) = *self.refuse.lock().unwrap() {
            return fail(code);
        }
        match self.folders.lock().unwrap().get(path) {
            Some((kind, _)) => Ok(CheckedFolder { path: path.to_path_buf(), kind: *kind, pinned: false }),
            None => fail(SyncCode::FolderUnreachable),
        }
    }

    fn open(&self, folder: &CheckedFolder) -> Box<dyn SyncFs> {
        let fs = self.folders.lock().unwrap().get(&folder.path).map(|(_, fs)| fs.clone()).unwrap_or_default();
        Box::new(SharedFs(fs))
    }
}

/// Confirmation native injectée : réponse, préconditions, nombre de boîtes ouvertes, dernière configuration.
pub struct FakeUi {
    pub answer: Mutex<bool>,
    pub ready: Mutex<bool>,
    pub prompts: AtomicUsize,
    pub last: Mutex<Option<DialogSpec>>,
}

impl FakeUi {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { answer: Mutex::new(true), ready: Mutex::new(true), prompts: AtomicUsize::new(0), last: Mutex::new(None) })
    }

    pub fn answer(&self, value: bool) {
        *self.answer.lock().unwrap() = value;
    }

    pub fn ready(&self, value: bool) {
        *self.ready.lock().unwrap() = value;
    }

    pub fn prompts(&self) -> usize {
        self.prompts.load(Ordering::SeqCst)
    }
}

impl ConsentUi for FakeUi {
    fn owner_ready(&self, _owner: isize) -> bool {
        *self.ready.lock().unwrap()
    }

    fn ask(&self, spec: &DialogSpec) -> bool {
        self.prompts.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(spec.clone());
        *self.answer.lock().unwrap()
    }
}

/// Horloge contrôlée (ms Unix).
pub struct TestClock(pub AtomicU64);

impl TestClock {
    pub fn new(ms: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn clock(self: &Arc<Self>) -> Arc<dyn Fn() -> u64 + Send + Sync> {
        let me = self.clone();
        Arc::new(move || me.now())
    }
}

pub const NOW: u64 = 1_790_000_000_000;
pub const FOLDER: &str = r"C:\Users\Ali\iCloudDrive\CircleTasks";

/// Un appareil de test : service, dossier de configuration, coffre, confirmation et horloge.
pub struct Device {
    pub core: SyncCore,
    pub base: tempfile::TempDir,
    pub vault: Arc<MemoryVault>,
    pub ui: Arc<FakeUi>,
    pub clock: Arc<TestClock>,
    pub backend: Arc<FakeBackend>,
}

impl Device {
    pub fn new(backend: Arc<FakeBackend>) -> Self {
        Self::with_options(backend, |_| {})
    }

    pub fn with_options(backend: Arc<FakeBackend>, tweak: impl FnOnce(&mut SyncOptions)) -> Self {
        let base = tempfile::tempdir().expect("dossier temporaire");
        let vault = Arc::new(MemoryVault::default());
        let ui = FakeUi::new();
        let clock = TestClock::new(NOW);
        let core = Self::build(base.path(), &vault, &ui, &clock, &backend, tweak);
        Self { core, base, vault, ui, clock, backend }
    }

    fn build(base: &Path, vault: &Arc<MemoryVault>, ui: &Arc<FakeUi>, clock: &Arc<TestClock>, backend: &Arc<FakeBackend>, tweak: impl FnOnce(&mut SyncOptions)) -> SyncCore {
        let mut options = SyncOptions::new(base.to_path_buf());
        options.platform = "windows";
        tweak(&mut options);
        let consent = Arc::new(ConsentGate::new(base.join("sync"), ui.clone(), clock.clock()));
        SyncCore::new(options, vault.clone(), backend.clone(), consent, clock.clock())
    }

    /// Redémarrage simulé : nouveau service sur le même dossier de configuration et le même coffre.
    pub fn restart(&mut self) {
        self.core = Self::build(self.base.path(), &self.vault, &self.ui, &self.clock, &self.backend, |_| {});
    }

    /// Dossier choisi, clé créée, appareil lié.
    pub fn setup(&self, dev: &str) {
        self.core.choose_folder(Path::new(FOLDER)).expect("dossier");
        self.core.key_create().expect("clé");
        self.core.bind_device(dev).expect("liaison");
    }
}

/// Appareil sur un dossier iCloud en mémoire.
pub fn device() -> (Device, Arc<MemFs>) {
    let fs = MemFs::new();
    (Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone())), fs)
}
