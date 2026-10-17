//! Y-TECH-03 (B13 de docs/audit-1.0.md), phase B : lecteur Rust du plan de pannes d'iCloud, `tests/fixtures/sync/fault-plan.json`.
//!
//! Un seul format, lu tel quel par les trois faux iCloud du dépôt : `memory.ts` (`src/platform/sync/faultPlan.ts`), `MemFs`
//! (`sync_support.rs`) et `fake_bookmark` (ce dossier). La lecture est **aussi stricte** que celle de `faultPlan.ts` : champ inconnu,
//! opération ou effet inconnu, couple opération/effet non rejouable, rang absent, champ de durée, horodatage dans un chemin : refus avec un
//! message qui nomme le plan et l'entrée (critère 3). Une entrée que le faux lui-même ne sait pas rejouer (effet `mute`) est refusée à
//! l'armement par `refuse_unreplayable`, jamais ignorée en silence.
//!
//! Aucune panne n'est armée par le temps : un rang d'appel (`nth`, `times`) et un compteur de cycles (`resurrectAfterCycles`) seulement.

use std::collections::HashMap;

use serde_json::Value;

/// Le plan de référence (dépôt), partagé avec la lecture TypeScript.
pub const FIXTURE: &str = include_str!("../../../../tests/fixtures/sync/fault-plan.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    List,
    Read,
    Write,
    Rename,
    Remove,
    Hydrate,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::List => "list",
            Op::Read => "read",
            Op::Write => "write",
            Op::Rename => "rename",
            Op::Remove => "remove",
            Op::Hydrate => "hydrate",
        }
    }

    fn parse(text: &str) -> Option<Op> {
        [Op::List, Op::Read, Op::Write, Op::Rename, Op::Remove, Op::Hydrate].into_iter().find(|op| op.name() == text)
    }

    /// Effets que l'opération sait rejouer (même table que `effectsOf` de `faultPlan.ts`).
    fn effects(self) -> &'static [&'static str] {
        match self {
            Op::List => &["error", "mute", "placeholder"],
            Op::Read => &["error", "mute", "evict-after-read", "overwrite-before-read"],
            Op::Hydrate => &["download-error", "mute"],
            Op::Write | Op::Rename => &["error"],
            Op::Remove => &["error", "accept-not-propagated"],
        }
    }
}

const EFFECTS: [&str; 7] = ["error", "accept-not-propagated", "evict-after-read", "placeholder", "overwrite-before-read", "download-error", "mute"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Io,
    CloudPending,
}

impl Code {
    pub fn name(self) -> &'static str {
        match self {
            Code::Io => "io",
            Code::CloudPending => "cloud-pending",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Error(Code),
    AcceptNotPropagated { resurrect_after_cycles: u64 },
    EvictAfterRead,
    Placeholder,
    OverwriteBeforeRead { content: Vec<String> },
    DownloadError,
    Mute,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Times {
    Count(u64),
    All,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub op: Op,
    /// Chemin sous la racine `CircleTasks`, composants séparés par `/`, `*` = toute suite de caractères dans un composant.
    pub file: String,
    pub nth: u64,
    pub times: Times,
    pub effect: Effect,
    pub partial_last_line: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub name: String,
    pub faults: Vec<Entry>,
    /// Mode historique du plugin d'avant Y-IOS-02-FIX-02 : `remove` du vrai nom laisse le substitut (rien supprimé).
    pub remove_leaves_placeholder: bool,
}

// --- Lecture stricte --------------------------------------------------------------------------------------------------------------

const PLAN_KEYS: [&str; 4] = ["name", "about", "options", "faults"];
const ENTRY_KEYS: [&str; 11] = ["id", "op", "file", "nth", "times", "effect", "code", "resurrectAfterCycles", "content", "partialLastLine", "about"];

/// Champ qui porte une durée ou une heure (mêmes mots que `isDurationKey` de `faultPlan.ts`) ; `times` (nombre d'appels) n'en est pas un.
fn is_duration_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    key != "times"
        && (["ms", "millis", "second", "delay", "timeout", "duration", "wait", "sleep", "date", "clock"].iter().any(|word| lower.contains(word))
            || lower.ends_with("time")
            || lower.ends_with("at"))
}

/// Chemin de motif : `devices/…`, composants non vides, ni `.` ni `..`, `*` joker, dossier terminé par `/`, aucun horodatage.
fn check_pattern(file: Option<&Value>, at: &str) -> Result<String, String> {
    let Some(file) = file.and_then(Value::as_str).filter(|f| !f.is_empty()) else {
        return Err(format!("{at} : « file » absent ou vide"));
    };
    let body = file.strip_suffix('/').unwrap_or(file);
    let parts: Vec<&str> = body.split('/').collect();
    if parts[0] != "devices" || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\')) {
        return Err(format!("{at} : chemin « {file} » invalide (devices/…, composants non vides)"));
    }
    let without_ids = strip_uuids(file);
    if has_iso_stamp(&without_ids) || has_long_number(&without_ids) {
        return Err(format!("{at} : chemin « {file} » : horodatage interdit (rang d'appel seulement)"));
    }
    Ok(file.to_owned())
}

/// Identifiants d'appareil (UUID) écartés avant le contrôle : leurs chiffres ne sont pas une heure.
fn strip_uuids(text: &str) -> String {
    let bytes = text.as_bytes();
    let groups = [8usize, 4, 4, 4, 12];
    let uuid_at = |start: usize| -> bool {
        let mut i = start;
        for (n, len) in groups.iter().enumerate() {
            if n > 0 {
                if bytes.get(i) != Some(&b'-') {
                    return false;
                }
                i += 1;
            }
            for _ in 0..*len {
                if !bytes.get(i).is_some_and(u8::is_ascii_hexdigit) {
                    return false;
                }
                i += 1;
            }
        }
        true
    };
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if uuid_at(i) {
            out.push('U');
            i += 36;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// `\d{4}-\d{2}-\d{2}T`.
fn has_iso_stamp(text: &str) -> bool {
    let b = text.as_bytes();
    let pattern = |i: usize| -> bool {
        b.len() >= i + 11
            && (0..4).all(|k| b[i + k].is_ascii_digit())
            && b[i + 4] == b'-'
            && (5..7).all(|k| b[i + k].is_ascii_digit())
            && b[i + 7] == b'-'
            && (8..10).all(|k| b[i + k].is_ascii_digit())
            && b[i + 10] == b'T'
    };
    (0..b.len()).any(pattern)
}

/// `\d{10,}`.
fn has_long_number(text: &str) -> bool {
    let mut run = 0;
    for byte in text.bytes() {
        run = if byte.is_ascii_digit() { run + 1 } else { 0 };
        if run >= 10 {
            return true;
        }
    }
    false
}

/// Valeur citée dans un message : un texte tel quel, sinon son JSON compact (`3`, `null`), `undefined` si absente (comme `shown` de
/// `faultPlan.ts`).
fn shown(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn rank(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|n| *n >= 1)
}

fn parse_entry(raw: &Value, index: usize, plan: &str, seen: &mut Vec<String>) -> Result<Entry, String> {
    let label = raw.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map_or_else(|| format!("n° {}", index + 1), |id| format!("« {id} »"));
    let at = format!("plan « {plan} », entrée {label}");
    let Some(object) = raw.as_object() else {
        return Err(format!("{at} : objet attendu"));
    };
    for key in object.keys() {
        if is_duration_key(key) {
            return Err(format!("{at} : champ de durée « {key} » interdit (rang d'appel et cycles seulement)"));
        }
        if !ENTRY_KEYS.contains(&key.as_str()) {
            return Err(format!("{at} : champ inconnu « {key} »"));
        }
    }
    let id = raw.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(|| format!("{at} : « id » absent"))?.to_owned();
    if seen.contains(&id) {
        return Err(format!("{at} : « id » en double"));
    }
    seen.push(id.clone());
    let op = raw.get("op").and_then(Value::as_str).and_then(Op::parse).ok_or_else(|| format!("{at} : opération inconnue « {} »", shown(raw.get("op"))))?;
    let effect_name = raw.get("effect").and_then(Value::as_str).filter(|e| EFFECTS.contains(e)).ok_or_else(|| format!("{at} : effet inconnu « {} »", shown(raw.get("effect"))))?;
    if !op.effects().contains(&effect_name) {
        return Err(format!("{at} : effet « {effect_name} » non rejouable sur l'opération « {} »", op.name()));
    }
    if raw.get("nth").is_none() {
        return Err(format!("{at} : rang « nth » absent"));
    }
    let nth = rank(raw.get("nth")).ok_or_else(|| format!("{at} : rang « nth » invalide (entier à partir de 1)"))?;
    let times = match raw.get("times").filter(|v| !v.is_null()) {
        None => Times::Count(1),
        Some(Value::String(all)) if all == "all" => Times::All,
        other => Times::Count(rank(other).ok_or_else(|| format!("{at} : « times » invalide (entier à partir de 1 ou « all »)"))?),
    };
    let file = check_pattern(raw.get("file"), &at)?;
    let is_dir = file.ends_with('/');
    if op == Op::List && effect_name != "placeholder" && !is_dir {
        return Err(format!("{at} : « list » en {effect_name} désigne un dossier (chemin terminé par /)"));
    }
    if (op != Op::List || effect_name == "placeholder") && is_dir {
        return Err(format!("{at} : « {} » désigne un fichier (pas de / final)", op.name()));
    }
    let only = |key: &str, allowed: bool| -> Result<(), String> {
        if object.contains_key(key) && !allowed {
            return Err(format!("{at} : « {key} » sans objet pour l'effet « {effect_name} »"));
        }
        Ok(())
    };
    only("code", effect_name == "error")?;
    only("resurrectAfterCycles", effect_name == "accept-not-propagated")?;
    only("content", effect_name == "overwrite-before-read")?;
    only("partialLastLine", effect_name == "error" && op == Op::Write)?;
    let effect = match effect_name {
        "error" => match raw.get("code").and_then(Value::as_str) {
            Some("io") => Effect::Error(Code::Io),
            Some("cloud-pending") => Effect::Error(Code::CloudPending),
            _ => return Err(format!("{at} : « code » attendu (io ou cloud-pending)")),
        },
        "accept-not-propagated" => Effect::AcceptNotPropagated {
            resurrect_after_cycles: raw.get("resurrectAfterCycles").and_then(Value::as_u64).ok_or_else(|| format!("{at} : « resurrectAfterCycles » attendu (entier, 0 : jamais de retour)"))?,
        },
        "evict-after-read" => Effect::EvictAfterRead,
        "placeholder" => Effect::Placeholder,
        "overwrite-before-read" => {
            let lines = raw.get("content").and_then(Value::as_array).map(|lines| lines.iter().map(|l| l.as_str().filter(|s| !s.contains('\n')).map(str::to_owned)).collect::<Option<Vec<_>>>());
            match lines {
                Some(Some(content)) => Effect::OverwriteBeforeRead { content },
                _ => return Err(format!("{at} : « content » attendu (lignes complètes, sans \\n)")),
            }
        }
        "download-error" => Effect::DownloadError,
        _ => Effect::Mute,
    };
    let mut partial_last_line = false;
    if let Some(value) = raw.get("partialLastLine") {
        partial_last_line = value.as_bool().ok_or_else(|| format!("{at} : « partialLastLine » booléen attendu"))?;
        if !(file.ends_with(".ctj") || file.ends_with('*')) {
            return Err(format!("{at} : « partialLastLine » réservé aux segments de journal (*.ctj)"));
        }
    }
    if let Some(about) = raw.get("about") {
        if !about.is_string() {
            return Err(format!("{at} : « about » texte attendu"));
        }
    }
    Ok(Entry { id, op, file, nth, times, effect, partial_last_line })
}

/// Lecture stricte d'un plan (objet JSON de `fault-plan.json`, ou construit par un test).
pub fn parse_plan(raw: &Value) -> Result<Plan, String> {
    let Some(object) = raw.as_object() else {
        return Err("plan : objet attendu".to_owned());
    };
    let name = object.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).ok_or("plan : « name » absent")?.to_owned();
    for key in object.keys() {
        if is_duration_key(key) {
            return Err(format!("plan « {name} » : champ de durée « {key} » interdit"));
        }
        if !PLAN_KEYS.contains(&key.as_str()) {
            return Err(format!("plan « {name} » : champ inconnu « {key} »"));
        }
    }
    let mut remove_leaves_placeholder = false;
    if let Some(options) = object.get("options").filter(|o| !o.is_null()) {
        let Some(options) = options.as_object() else {
            return Err(format!("plan « {name} » : « options » objet attendu"));
        };
        for (key, value) in options {
            if key != "removeLeavesPlaceholder" {
                return Err(format!("plan « {name} » : option inconnue « {key} »"));
            }
            remove_leaves_placeholder = value.as_bool().ok_or_else(|| format!("plan « {name} » : « removeLeavesPlaceholder » booléen attendu"))?;
        }
    }
    let faults = object.get("faults").and_then(Value::as_array).ok_or_else(|| format!("plan « {name} » : « faults » tableau attendu"))?;
    let mut seen = Vec::new();
    let faults = faults.iter().enumerate().map(|(i, entry)| parse_entry(entry, i, &name, &mut seen)).collect::<Result<Vec<_>, _>>()?;
    Ok(Plan { name, faults, remove_leaves_placeholder })
}

/// Lecture stricte d'un fichier de plans (`{ $comment, schema: 1, plans: [...] }`) : racine, schéma, noms de plans uniques.
pub fn parse_file(text: &str) -> Result<Vec<Plan>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("fichier de plans : JSON invalide ({e})"))?;
    let Some(object) = root.as_object() else {
        return Err("fichier de plans : objet attendu".to_owned());
    };
    for key in object.keys() {
        if !["$comment", "schema", "plans"].contains(&key.as_str()) {
            return Err(format!("fichier de plans : champ inconnu « {key} »"));
        }
    }
    if object.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("fichier de plans : « schema » 1 attendu".to_owned());
    }
    let plans = object.get("plans").and_then(Value::as_array).ok_or("fichier de plans : « plans » tableau attendu")?;
    let mut names: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for raw in plans {
        let plan = parse_plan(raw)?;
        if names.contains(&plan.name) {
            return Err(format!("fichier de plans : plan « {} » en double", plan.name));
        }
        names.push(plan.name.clone());
        out.push(plan);
    }
    Ok(out)
}

/// Les plans du dépôt (`fault-plan.json`), lus strictement.
pub fn reference_plans() -> Vec<Plan> {
    parse_file(FIXTURE).unwrap_or_else(|e| panic!("fault-plan.json : {e}"))
}

/// Un plan du dépôt, par son nom.
pub fn reference_plan(name: &str) -> Plan {
    reference_plans().into_iter().find(|p| p.name == name).unwrap_or_else(|| panic!("plan « {name} » absent de fault-plan.json"))
}

/// Le faux `fake` ne sait pas rejouer l'effet `mute` (appel qui ne répond jamais) : un synchrone sans fil dédié bloquerait le test pour de
/// bon, et le Rust de production n'a pas encore d'échéance par appel (Y-IOS-05, scénario 5). Refus à l'armement qui nomme l'entrée.
pub fn refuse_unreplayable(plan: &Plan, fake: &str) -> Result<(), String> {
    match plan.faults.iter().find(|e| e.effect == Effect::Mute) {
        Some(entry) => Err(format!(
            "plan « {} », entrée « {} » : effet « mute » non rejouable par {fake} (un appel sans retour ne se rejoue pas sans attente ; échéance par appel : Y-IOS-05)",
            plan.name, entry.id
        )),
        None => Ok(()),
    }
}

// --- Correspondance et compteurs --------------------------------------------------------------------------------------------------

/// Le chemin correspond-il au motif ? Composants séparés par `/`, `/` final pour un dossier, `*` = toute suite dans un composant.
pub fn matches(pattern: &str, path: &str) -> bool {
    if pattern.ends_with('/') != path.ends_with('/') {
        return false;
    }
    let a: Vec<&str> = pattern.trim_end_matches('/').split('/').collect();
    let b: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    a.len() == b.len() && a.iter().zip(&b).all(|(p, s)| glob(p, s))
}

fn glob(pattern: &str, text: &str) -> bool {
    let pieces: Vec<&str> = pattern.split('*').collect();
    if pieces.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (pieces[0], pieces[pieces.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for piece in &pieces[1..pieces.len() - 1] {
        match rest.find(piece) {
            Some(at) => rest = &rest[at + piece.len()..],
            None => return false,
        }
    }
    true
}

/// Appel touché par une entrée (journal des pannes rejouées, comparé d'une exécution à l'autre : déterminisme).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Firing {
    pub id: String,
    pub op: Op,
    pub path: String,
    /// Rang de l'appel pour cette entrée.
    pub call: u64,
}

/// Plan armé et ses compteurs : chaque appel de `op` sur un chemin qui correspond au motif d'une entrée incrémente le compteur de cette
/// entrée ; l'entrée se déclenche si le compteur est dans `[nth, nth + times - 1]`. Plusieurs entrées déclenchées par le même appel : la
/// première du plan l'emporte (les autres comptent quand même l'appel). Même règle que `FaultCounters` de `faultPlan.ts`.
#[derive(Clone, Debug)]
pub struct Armed {
    pub plan: Plan,
    counts: HashMap<String, u64>,
    log: Vec<Firing>,
}

impl Armed {
    pub fn new(plan: Plan) -> Self {
        Self { plan, counts: HashMap::new(), log: Vec::new() }
    }

    pub fn hit(&mut self, op: Op, path: &str) -> Option<Entry> {
        let mut fired: Option<Entry> = None;
        for entry in &self.plan.faults {
            if entry.op != op || !matches(&entry.file, path) {
                continue;
            }
            let call = self.counts.get(&entry.id).copied().unwrap_or(0) + 1;
            self.counts.insert(entry.id.clone(), call);
            let in_range = call >= entry.nth
                && match entry.times {
                    Times::All => true,
                    Times::Count(n) => call < entry.nth + n,
                };
            if in_range && fired.is_none() {
                fired = Some(entry.clone());
                self.log.push(Firing { id: entry.id.clone(), op, path: path.to_owned(), call });
            }
        }
        fired
    }

    /// Pannes rejouées, dans l'ordre.
    pub fn fired(&self) -> Vec<Firing> {
        self.log.clone()
    }

    /// Entrées jamais déclenchées (une panne armée restée sans effet serait une panne ignorée en silence).
    pub fn unfired(&self) -> Vec<String> {
        self.plan.faults.iter().filter(|e| !self.log.iter().any(|f| f.id == e.id)).map(|e| e.id.clone()).collect()
    }
}

/// Octets laissés par un ajout coupé (`partialLastLine`) : les lignes complètes sauf la dernière, dont la moitié est écrite sans `\n`.
pub fn partial_tail(data: &[u8]) -> Vec<u8> {
    let body = data.strip_suffix(b"\n").unwrap_or(data);
    let start = body.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let last = &body[start..];
    let mut out = data[..start].to_vec();
    out.extend_from_slice(&last[..last.len() / 2]);
    out
}

/// Contenu d'un `overwrite-before-read` : lignes complètes, chacune suivie de `\n`.
pub fn overwrite_bytes(content: &[String]) -> Vec<u8> {
    content.iter().flat_map(|line| line.bytes().chain(std::iter::once(b'\n'))).collect()
}

/// Chemin d'un fichier pour le plan (`devices/…`) et d'un dossier (`/` final).
pub fn file_path(parts: &[&str]) -> String {
    parts.join("/")
}

pub fn dir_path(parts: &[&str]) -> String {
    format!("{}/", parts.join("/"))
}
