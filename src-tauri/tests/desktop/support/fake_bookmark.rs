//! Faux du plugin Swift folder-bookmark (ADR 0011 §22 point 4) : arborescence en mémoire, fichiers « dans le nuage », liens, signet
//! obsolète ou invalide, racine injoignable, délais de téléchargement simulés sur l'horloge des tests. Il parle **exactement** le JSON du
//! contrat (`tests/fixtures/sync/folder-bookmark-contract.json`) : toute entrée dont les champs diffèrent de ceux du contrat fait échouer
//! le test (panique), toute réponse a l'une des formes du contrat. Mêmes règles que le Swift : composants relatifs ouverts sans suivre de
//! lien (un lien sur le chemin : `unsafe-folder`), jamais d'hydratation par `readFrom`, `not-configured` tant que la racine n'est pas
//! résolue dans la session.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use circletasks_lib::sync::bookmark::BookmarkTransport;
use serde_json::{json, Value};

pub const CONTRACT: &str = include_str!("../../../../tests/fixtures/sync/folder-bookmark-contract.json");
/// Racine résolue simulée (chemin canonique d'iCloud Drive/CircleTasks sur l'iPhone).
pub const ROOT: &str = "/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/CircleTasks";
pub const BOOKMARK: &str = "Ym9va21hcmstMQ==";
pub const FRESH_BOOKMARK: &str = "Ym9va21hcmstMg==";

#[derive(Clone, Debug)]
pub enum Node {
    Dir,
    File { bytes: Vec<u8>, cloud: bool, delay_ms: u64, download_error: bool },
    Link,
}

/// Comportement du sélecteur simulé.
#[derive(Clone, Debug)]
pub enum Pick {
    Cancel,
    Folder,
    Reject(&'static str),
}

pub struct FakeState {
    pub nodes: BTreeMap<String, Node>,
    /// Racine résolue dans la session du plugin.
    pub session: bool,
    /// Signet obsolète : `resolve` rend un nouveau signet.
    pub stale: bool,
    /// Signet impossible à résoudre (autre signature, dossier supprimé).
    pub invalid: bool,
    /// Racine injoignable (dossier supprimé après la résolution).
    pub unreachable: bool,
    /// Chemin rendu par `resolve` (dossier déplacé : un autre).
    pub root: String,
    pub kind: &'static str,
    pub pick: Pick,
    pub app_state: &'static str,
    /// Appels reçus (nom, arguments).
    pub calls: Vec<(String, Value)>,
}

pub struct FakePlugin {
    pub state: Mutex<FakeState>,
    /// Horloge des tests (ms) : un téléchargement simulé l'avance de son délai (ou du délai accordé).
    pub clock: Arc<AtomicU64>,
    contract: Value,
}

fn key(parts: &[String]) -> String {
    parts.join("/")
}

fn ok(value: Value) -> Result<Value, String> {
    Ok(value)
}

fn reject(code: &str) -> Result<Value, String> {
    Err(code.to_owned())
}

impl FakePlugin {
    pub fn new(clock: Arc<AtomicU64>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                nodes: BTreeMap::new(),
                session: false,
                stale: false,
                invalid: false,
                unreachable: false,
                root: ROOT.to_owned(),
                kind: "icloud",
                pick: Pick::Folder,
                app_state: "active",
                calls: Vec::new(),
            }),
            clock,
            contract: serde_json::from_str(CONTRACT).expect("contrat JSON"),
        })
    }

    // --- Crochets de test -------------------------------------------------------------------------------------------------------

    pub fn mkdir(&self, parts: &[&str]) {
        let mut state = self.state.lock().unwrap();
        for i in 1..=parts.len() {
            state.nodes.entry(parts[..i].join("/")).or_insert(Node::Dir);
        }
    }

    pub fn put(&self, parts: &[&str], bytes: &[u8]) {
        self.mkdir(&parts[..parts.len() - 1]);
        self.state.lock().unwrap().nodes.insert(parts.join("/"), Node::File { bytes: bytes.to_vec(), cloud: false, delay_ms: 0, download_error: false });
    }

    /// Fichier resté dans le nuage ; `delay_ms` : durée simulée du téléchargement ; `error` : iCloud rend une erreur.
    pub fn put_cloud(&self, parts: &[&str], bytes: &[u8], delay_ms: u64, error: bool) {
        self.mkdir(&parts[..parts.len() - 1]);
        self.state.lock().unwrap().nodes.insert(parts.join("/"), Node::File { bytes: bytes.to_vec(), cloud: true, delay_ms, download_error: error });
    }

    /// Lien symbolique (sous la racine) à la place de l'entrée `parts` (et de tout ce qu'elle contenait).
    pub fn link(&self, parts: &[&str]) {
        let mut state = self.state.lock().unwrap();
        let prefix = format!("{}/", parts.join("/"));
        state.nodes.retain(|k, _| !k.starts_with(&prefix));
        state.nodes.insert(parts.join("/"), Node::Link);
    }

    pub fn get(&self, parts: &[&str]) -> Option<Vec<u8>> {
        match self.state.lock().unwrap().nodes.get(&parts.join("/")) {
            Some(Node::File { bytes, .. }) => Some(bytes.clone()),
            _ => None,
        }
    }

    pub fn calls(&self, command: &str) -> Vec<Value> {
        self.state.lock().unwrap().calls.iter().filter(|(c, _)| c == command).map(|(_, a)| a.clone()).collect()
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut FakeState) -> T) -> T {
        f(&mut self.state.lock().unwrap())
    }

    // --- Contrat ------------------------------------------------------------------------------------------------------------------

    fn check_input(&self, command: &str, args: &Value) {
        let spec = &self.contract["commands"][command];
        assert!(spec.is_object(), "commande hors contrat : {command}");
        let expected: BTreeSet<&str> = spec["input"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let got: BTreeSet<&str> = args.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
        assert_eq!(got, expected, "champs d'entrée de {command} différents du contrat");
    }

    fn check_output(&self, command: &str, out: &Result<Value, String>) {
        match out {
            Ok(value) => {
                let got: BTreeSet<String> = value.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                let shapes = self.contract["commands"][command]["output"].as_array().unwrap();
                let matches = shapes.iter().any(|shape| shape.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<BTreeSet<_>>() == got);
                assert!(matches, "réponse de {command} hors contrat : {got:?}");
            }
            Err(code) => {
                let codes: Vec<&str> = self.contract["rejectCodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                assert!(codes.contains(&code.as_str()), "code de rejet hors contrat : {code}");
            }
        }
    }

    // --- Commandes ----------------------------------------------------------------------------------------------------------------

    fn parts(args: &Value, field: &str) -> Result<Vec<String>, String> {
        let list = args[field].as_array().ok_or_else(|| "io".to_owned())?;
        let mut out = Vec::new();
        for part in list {
            let part = part.as_str().ok_or_else(|| "io".to_owned())?;
            if part.is_empty() || part == "." || part == ".." || part.contains('/') || part.contains('\0') {
                return Err("unsafe-folder".to_owned());
            }
            out.push(part.to_owned());
        }
        Ok(out)
    }

    /// Ouvre chaque dossier de `dir` sans suivre de lien : `Ok(true)` présent, `Ok(false)` absent.
    fn walk(state: &FakeState, dir: &[String]) -> Result<bool, String> {
        for i in 1..=dir.len() {
            match state.nodes.get(&key(&dir[..i])) {
                None => return Ok(false),
                Some(Node::Dir) => {}
                Some(Node::Link) => return Err("unsafe-folder".to_owned()),
                Some(Node::File { .. }) => return Err("unsafe-folder".to_owned()),
            }
        }
        Ok(true)
    }

    fn session(state: &FakeState) -> Result<(), String> {
        if state.unreachable {
            return Err("folder-unreachable".to_owned());
        }
        if !state.session {
            return Err("not-configured".to_owned());
        }
        Ok(())
    }

    fn run(&self, command: &str, args: &Value) -> Result<Value, String> {
        let mut state = self.state.lock().unwrap();
        match command {
            "pickFolder" => match state.pick.clone() {
                Pick::Cancel => ok(json!({ "cancelled": true })),
                Pick::Reject(code) => reject(code),
                Pick::Folder => {
                    state.session = true;
                    state.unreachable = false;
                    let name = state.root.rsplit('/').next().unwrap_or_default().to_owned();
                    ok(json!({ "bookmark": BOOKMARK, "path": state.root, "name": name, "kind": state.kind }))
                }
            },
            "resolve" => {
                if state.invalid || state.unreachable || args["bookmark"].as_str().is_none_or(str::is_empty) {
                    return reject("folder-unreachable");
                }
                state.session = true;
                let refreshed = if state.stale {
                    state.stale = false;
                    Value::String(FRESH_BOOKMARK.to_owned())
                } else {
                    Value::Null
                };
                let name = state.root.rsplit('/').next().unwrap_or_default().to_owned();
                ok(json!({ "path": state.root, "name": name, "kind": state.kind, "refreshed": refreshed }))
            }
            "appState" => ok(json!({ "state": state.app_state })),
            _ => {
                Self::session(&state)?;
                self.file_command(&mut state, command, args)
            }
        }
    }

    fn file_command(&self, state: &mut FakeState, command: &str, args: &Value) -> Result<Value, String> {
        match command {
            "status" => {
                let path = Self::parts(args, "path")?;
                let absent = json!({ "exists": false, "isDir": false, "size": null, "availability": "local" });
                if path.is_empty() {
                    return ok(json!({ "exists": true, "isDir": true, "size": null, "availability": "local" }));
                }
                if !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(absent);
                }
                ok(match state.nodes.get(&key(&path)) {
                    None => absent,
                    Some(Node::Link) => json!({ "exists": true, "isDir": false, "size": null, "availability": "error" }),
                    Some(Node::Dir) => json!({ "exists": true, "isDir": true, "size": null, "availability": "local" }),
                    Some(Node::File { bytes, cloud, .. }) => json!({ "exists": true, "isDir": false, "size": bytes.len(), "availability": if *cloud { "cloud" } else { "local" } }),
                })
            }
            "list" => {
                let path = Self::parts(args, "path")?;
                let max = args["max"].as_u64().ok_or("io")? as usize;
                if !Self::walk(state, &path)? {
                    return ok(json!({ "missing": true }));
                }
                let prefix = if path.is_empty() { String::new() } else { format!("{}/", key(&path)) };
                let mut entries = Vec::new();
                let mut truncated = false;
                for (k, node) in &state.nodes {
                    let Some(name) = k.strip_prefix(&prefix).filter(|rest| !rest.is_empty() && !rest.contains('/')) else { continue };
                    if entries.len() >= max {
                        truncated = true;
                        break;
                    }
                    entries.push(match node {
                        Node::Dir => json!({ "name": name, "isDir": true, "size": null, "availability": "local" }),
                        Node::Link => json!({ "name": name, "isDir": false, "size": null, "availability": "error" }),
                        Node::File { bytes, cloud, .. } => json!({ "name": name, "isDir": false, "size": bytes.len(), "availability": if *cloud { "cloud" } else { "local" } }),
                    });
                }
                ok(json!({ "entries": entries, "truncated": truncated }))
            }
            "readFrom" => {
                let path = Self::parts(args, "path")?;
                let offset = args["offset"].as_u64().ok_or("io")? as usize;
                let max = args["max"].as_u64().ok_or("io")? as usize;
                let limit = args["limit"].as_u64().ok_or("io")?;
                assert!(max <= 1024 * 1024, "plus de 1 Mio demandé en un appel");
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(json!({ "missing": true }));
                }
                match state.nodes.get(&key(&path)) {
                    None => ok(json!({ "missing": true })),
                    Some(Node::Link) | Some(Node::Dir) => reject("unsafe-folder"),
                    Some(Node::File { cloud: true, .. }) => reject("cloud-pending"),
                    Some(Node::File { bytes, .. }) => {
                        if bytes.len() as u64 > limit {
                            return reject("too-large");
                        }
                        let start = offset.min(bytes.len());
                        let end = start.saturating_add(max).min(bytes.len());
                        let data = &bytes[start..end];
                        let eof = data.len() < max || end >= bytes.len();
                        ok(json!({ "data": STANDARD.encode(data), "size": bytes.len(), "eof": eof }))
                    }
                }
            }
            "download" => {
                let path = Self::parts(args, "path")?;
                let timeout = args["timeoutMs"].as_u64().ok_or("io")?;
                let limit = args["limit"].as_u64().ok_or("io")?;
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(json!({}));
                }
                match state.nodes.get_mut(&key(&path)) {
                    Some(Node::File { bytes, cloud, delay_ms, download_error }) => {
                        if bytes.len() as u64 > limit {
                            return reject("too-large");
                        }
                        if !*cloud {
                            return ok(json!({}));
                        }
                        if *download_error {
                            return reject("cloud-error");
                        }
                        if *delay_ms > timeout {
                            self.clock.fetch_add(timeout, Ordering::SeqCst);
                            return reject("cloud-pending");
                        }
                        self.clock.fetch_add(*delay_ms, Ordering::SeqCst);
                        *cloud = false;
                        ok(json!({}))
                    }
                    _ => ok(json!({})),
                }
            }
            "append" => {
                let path = Self::parts(args, "path")?;
                let data = STANDARD.decode(args["data"].as_str().ok_or("io")?).map_err(|_| "io".to_owned())?;
                let create = args["createNew"].as_bool().ok_or("io")?;
                assert!(data.len() <= 1024 * 1024, "plus de 1 Mio écrit en un appel");
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(json!({ "missing": true }));
                }
                match (state.nodes.get_mut(&key(&path)), create) {
                    (Some(_), true) => ok(json!({ "exists": true })),
                    (None, false) => ok(json!({ "missing": true })),
                    (Some(Node::File { bytes, cloud: false, .. }), false) => {
                        bytes.extend_from_slice(&data);
                        ok(json!({}))
                    }
                    (Some(_), false) => reject("unsafe-folder"),
                    (None, true) => {
                        state.nodes.insert(key(&path), Node::File { bytes: data, cloud: false, delay_ms: 0, download_error: false });
                        ok(json!({}))
                    }
                }
            }
            "writeAtomic" => {
                let path = Self::parts(args, "path")?;
                let data = STANDARD.decode(args["data"].as_str().ok_or("io")?).map_err(|_| "io".to_owned())?;
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return reject("io");
                }
                if matches!(state.nodes.get(&key(&path)), Some(Node::Link | Node::Dir)) {
                    return reject("unsafe-folder");
                }
                state.nodes.insert(key(&path), Node::File { bytes: data, cloud: false, delay_ms: 0, download_error: false });
                ok(json!({}))
            }
            "rename" => {
                let dir = Self::parts(args, "dir")?;
                let from = args["from"].as_str().ok_or("io")?.to_owned();
                let to = args["to"].as_str().ok_or("io")?.to_owned();
                if !Self::walk(state, &dir)? {
                    return reject("io");
                }
                let mut a = dir.clone();
                a.push(from);
                let mut b = dir;
                b.push(to);
                match state.nodes.get(&key(&a)) {
                    None => reject("io"),
                    Some(Node::File { .. }) => {
                        let node = state.nodes.remove(&key(&a)).unwrap();
                        state.nodes.insert(key(&b), node);
                        ok(json!({}))
                    }
                    Some(_) => reject("unsafe-folder"),
                }
            }
            "createDir" => {
                let path = Self::parts(args, "path")?;
                if path.is_empty() {
                    return reject("unsafe-folder");
                }
                for i in 1..=path.len() {
                    match state.nodes.get(&key(&path[..i])) {
                        None => {
                            state.nodes.insert(key(&path[..i]), Node::Dir);
                        }
                        Some(Node::Dir) => {}
                        Some(_) => return reject("unsafe-folder"),
                    }
                }
                ok(json!({}))
            }
            "remove" => {
                let path = Self::parts(args, "path")?;
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(json!({ "removed": false }));
                }
                match state.nodes.get(&key(&path)) {
                    None => ok(json!({ "removed": false })),
                    Some(Node::File { .. }) => {
                        state.nodes.remove(&key(&path));
                        ok(json!({ "removed": true }))
                    }
                    Some(_) => reject("unsafe-folder"),
                }
            }
            "removeEmptyDir" => {
                let path = Self::parts(args, "path")?;
                if path.is_empty() || !Self::walk(state, &path[..path.len() - 1])? {
                    return ok(json!({}));
                }
                match state.nodes.get(&key(&path)) {
                    None => ok(json!({})),
                    Some(Node::Dir) => {
                        let prefix = format!("{}/", key(&path));
                        if !state.nodes.keys().any(|k| k.starts_with(&prefix)) {
                            state.nodes.remove(&key(&path));
                        }
                        ok(json!({}))
                    }
                    Some(_) => reject("unsafe-folder"),
                }
            }
            other => panic!("commande de fichier inconnue : {other}"),
        }
    }
}

impl BookmarkTransport for FakePlugin {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.check_input(command, &args);
        self.state.lock().unwrap().calls.push((command.to_owned(), args.clone()));
        let out = self.run(command, &args);
        self.check_output(command, &out);
        out
    }
}

/// Transport partagé (le test garde l'accès au faux).
pub struct SharedPlugin(pub Arc<FakePlugin>);

impl BookmarkTransport for SharedPlugin {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.0.call(command, args)
    }
}
