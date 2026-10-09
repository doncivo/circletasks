//! Journal technique persistant (I-04, ADR 0014) : PC et iPhone, sans `cfg`.
//!
//! Fichiers `<app_config_dir>/logs/circletasks.log` (courant) et `circletasks.log.1` (précédent), 256 Kio chacun : une entrée JSON par ligne
//! `{ at, scope, code, detail, n? }`, ajoutée en fin ; rotation à l'écriture. Jamais dans le dossier iCloud ni dans `backups/` : une
//! restauration (P-04) ne touche que `circletasks.db*` et `backups/`, le journal lui survit.
//!
//! Règles :
//! - aucun contenu personnel : `scope` et `code` ont une forme stricte (sinon `invalid`), `detail` passe la seconde barrière d'assainissement
//!   (`sanitize_detail`, mêmes vecteurs que `sanitizeLogDetail` de TypeScript : `tests/fixtures/logs/sanitize-vectors.json`) ;
//! - un dossier `logs/` ou un fichier qui est un lien (ou autre chose qu'un fichier ordinaire) n'est ni lu ni écrit (`unsafe-file`) ;
//! - un même couple (`scope`, `code`) au plus 10 fois par minute ; le surplus est compté et résumé (`log` / `suppressed`, `n`) ;
//! - écritures internes à Rust : `write(scope, code)`, deux `&'static str` (aucun texte dynamique possible) ; avant `init`, gardées en
//!   mémoire (100 au plus) ;
//! - le dernier échec d'écriture du processus (`write_error`) est rendu au front, effacé à la prochaine écriture réussie ;
//! - **seul `eprintln!` du code** : `echo`, copie sur la sortie d'erreur en développement et sous `test-hooks`.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Sous-dossier du dossier de configuration de l'app.
pub const LOG_DIR: &str = "logs";
pub const CURRENT_FILE: &str = "circletasks.log";
pub const PREVIOUS_FILE: &str = "circletasks.log.1";
/// Taille maximale d'un fichier (256 Kio) : 512 Kio au plus pour le journal entier.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Taille maximale d'une ligne (4 Kio) : au-delà, `detail` est tronqué et marqué.
pub const MAX_LINE_BYTES: usize = 4 * 1024;
/// Entrées par appel de `log_append`.
pub const MAX_APPEND_ENTRIES: usize = 100;
/// Entrées rendues par `log_read` au plus.
pub const MAX_READ_ENTRIES: usize = 500;
/// Entrées internes gardées en mémoire avant `init`.
pub const MAX_PENDING: usize = 100;
/// Entrées d'un même couple (`scope`, `code`) par minute.
pub const RATE_PER_MINUTE: u32 = 10;
/// `detail` plus long : masqué en entier.
pub const MAX_DETAIL_CHARS: usize = 300;
/// Lecture bornée d'un fichier (un fichier gonflé à la main n'est pas lu en entier).
const MAX_READ_BYTES: u64 = 1024 * 1024;
pub const MASK: &str = "[masqué]";
pub const TRUNCATED: &str = "[tronqué]";

/// Entrée reçue de la WebView.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LogEntryIn {
    pub at: String,
    pub scope: String,
    pub code: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub n: Option<u32>,
}

/// Entrée écrite et relue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub at: String,
    pub scope: String,
    pub code: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
}

/// Erreur rendue au front : un code seulement (`too-many`, `unsafe-file`, `disk-full`, `io`, `unreadable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LogError {
    pub code: &'static str,
}

const fn fail(code: &'static str) -> LogError {
    LogError { code }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Forme et assainissement
// ------------------------------------------------------------------------------------------------------------------------------

/// `^[a-z0-9][a-z0-9-]{0,39}$`
pub fn is_scope(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty() && bytes.len() <= 40 && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `^[a-z0-9][a-z0-9.-]{0,63}$`, sans séquence hexadécimale de 32+ ni jeton probable (revue du lot F, `has_code_token`).
pub fn is_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'.')
        && !has_hex_run(value, 32)
        && !has_code_token(value)
}

/// Jeton probable dans un code : un segment (entre `-` et `.`) de 24 caractères ou plus, hors UUID exact, ou `ya29.`. Même règle que
/// `hasCodeToken` de TypeScript ; vecteurs `codeVectors` partagés.
fn has_code_token(value: &str) -> bool {
    value.contains("ya29.") || (!is_uuid(value) && value.split(['-', '.']).any(|segment| segment.len() >= 24))
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`
pub fn is_iso_instant(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() < 20 || b.len() > 24 || b[b.len() - 1] != b'Z' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    let base = digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10) && b[10] == b'T' && digits(11..13) && b[13] == b':' && digits(14..16) && b[16] == b':' && digits(17..19);
    if !base {
        return false;
    }
    match b.len() {
        20 => true,
        n => b[19] == b'.' && n >= 22 && digits(20..n - 1),
    }
}

/// Caractère de contrôle (C0, DEL, C1) : remplacé par une espace avant tout contrôle.
fn is_control(c: char) -> bool {
    matches!(c as u32, 0x00..=0x1f | 0x7f..=0x9f)
}

fn has_hex_run(token: &str, min: usize) -> bool {
    let mut run = 0;
    for c in token.chars() {
        if c.is_ascii_hexdigit() {
            run += 1;
            if run >= min {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

fn has_drive_path(chars: &[char]) -> bool {
    (0..chars.len()).any(|i| {
        chars[i].is_ascii_alphabetic() && (i == 0 || !chars[i - 1].is_alphanumeric()) && chars.get(i + 1) == Some(&':') && matches!(chars.get(i + 2), Some('\\' | '/'))
    })
}

/// Un `/` qui n'est précédé ni d'une lettre, ni d'un chiffre, ni de `:` ou `/`, suivi d'au moins un caractère puis d'un autre `/` : `/var/x`,
/// `path=/Users/a`, `(/etc/x)`. Une URL (`https://hôte/chemin`) n'en est pas un.
fn has_posix_path(chars: &[char]) -> bool {
    if chars.first() == Some(&'~') && chars.get(1) == Some(&'/') {
        return true;
    }
    (0..chars.len()).any(|i| {
        if chars[i] != '/' || (i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == ':' || chars[i - 1] == '/')) {
            return false;
        }
        let rest = &chars[i + 1..];
        rest.first().is_some_and(|c| *c != '/') && rest.iter().skip(1).any(|c| *c == '/')
    })
}

fn has_email(chars: &[char]) -> bool {
    (1..chars.len()).any(|at| {
        if chars[at] != '@' {
            return false;
        }
        let domain = &chars[at + 1..];
        (1..domain.len()).any(|dot| domain[dot] == '.' && domain.get(dot + 1).is_some_and(char::is_ascii_alphabetic) && domain.get(dot + 2).is_some_and(char::is_ascii_alphabetic))
    })
}

fn has_url_with_query(token: &str) -> bool {
    token.find("://").is_some_and(|start| token[start..].contains('?'))
}

/// Un mot à masquer : chemin (Windows, UNC, POSIX, `~/`), `file://`, URL avec requête, adresse e-mail, séquence hexadécimale de 32 caractères
/// ou plus. Mêmes règles que `sanitizeLogDetail` (`src/platform/logs/sanitize.ts`).
/// Identifiant UUID exact (8-4-4-4-12 hexadécimaux), permis par l'ADR 0011 §2.3.
fn is_uuid(run: &str) -> bool {
    let parts: Vec<&str> = run.split('-').collect();
    parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Audit du lot F (moyen) : jeton probable : suite de 24 caractères ou plus de `[A-Za-z0-9+/=_.-]` (sauf un UUID exact), JWT (`eyJ`),
/// jeton Google (`ya29.`, `1//`), `token=`. Mêmes règles que `hasTokenLike` de TypeScript.
fn has_token_like(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if token.contains("eyJ") || lower.contains("ya29.") || token.contains("1//") || lower.contains("token=") {
        return true;
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '.' | '-');
    token.split(|c: char| !allowed(c)).any(|run| run.chars().count() >= 24 && !is_uuid(run))
}

fn is_sensitive_token(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    let lower = token.to_ascii_lowercase();
    has_token_like(token) || lower.contains("file:") || token.contains('\\') || has_drive_path(&chars) || has_posix_path(&chars) || has_url_with_query(token) || has_email(&chars) || has_hex_run(token, 32)
}

/// Seconde barrière (ADR 0014 §1) : caractères de contrôle remplacés par une espace ; plus de 300 caractères → `[masqué]` en entier ; sinon
/// chaque mot sensible devient `[masqué]`, ainsi que `Bearer` et le mot qui le suit. Les espaces d'origine sont conservées.
pub fn sanitize_detail(raw: &str) -> String {
    let cleaned: String = raw.chars().map(|c| if is_control(c) { ' ' } else { c }).collect();
    if cleaned.chars().count() > MAX_DETAIL_CHARS {
        return MASK.to_owned();
    }
    let mut out = String::with_capacity(cleaned.len());
    let mut mask_next = false;
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String, mask_next: &mut bool| {
        if word.is_empty() {
            return;
        }
        if *mask_next {
            out.push_str(MASK);
            *mask_next = false;
        } else if word.eq_ignore_ascii_case("bearer") {
            out.push_str(MASK);
            *mask_next = true;
        } else if is_sensitive_token(word) {
            out.push_str(MASK);
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in cleaned.chars() {
        if c == ' ' {
            flush(&mut word, &mut out, &mut mask_next);
            out.push(' ');
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out, &mut mask_next);
    out
}

/// Entrée normalisée : formes strictes (`invalid` sinon), heure de Rust si `at` n'est pas un instant ISO, détail assaini, `n` ≥ 2 seulement.
pub fn normalize(entry: &LogEntryIn, now_iso: &str) -> LogEntry {
    LogEntry {
        at: if is_iso_instant(&entry.at) { entry.at.clone() } else { now_iso.to_owned() },
        scope: if is_scope(&entry.scope) { entry.scope.clone() } else { "invalid".to_owned() },
        code: if is_code(&entry.code) { entry.code.clone() } else { "invalid".to_owned() },
        detail: sanitize_detail(&entry.detail),
        n: entry.n.filter(|n| *n >= 2),
    }
}

/// Ligne JSON d'une entrée, 4 Kio au plus : un `detail` trop long est coupé et suivi de `[tronqué]`.
pub fn line_of(entry: &LogEntry) -> String {
    let line = serde_json::to_string(entry).unwrap_or_default();
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    // Plus long préfixe de `detail` (en caractères) dont la ligne, marque comprise, tient dans 4 Kio : recherche dichotomique.
    let chars: Vec<char> = entry.detail.chars().collect();
    let build = |keep: usize| {
        let detail: String = chars[..keep].iter().collect();
        serde_json::to_string(&LogEntry { detail: format!("{detail} {TRUNCATED}"), ..entry.clone() }).unwrap_or_default()
    };
    let (mut low, mut high) = (0usize, chars.len());
    while low < high {
        let middle = (low + high).div_ceil(2);
        if build(middle).len() <= MAX_LINE_BYTES {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    build(low)
}

// ------------------------------------------------------------------------------------------------------------------------------
// Heure
// ------------------------------------------------------------------------------------------------------------------------------

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Instant ISO UTC d'une heure en secondes.
pub fn iso_of(secs: u64) -> String {
    crate::backup::iso_instant(secs)
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fichiers
// ------------------------------------------------------------------------------------------------------------------------------

fn io_code(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        // ENOSPC (Unix), ERROR_HANDLE_DISK_FULL et ERROR_DISK_FULL (Windows).
        #[cfg(unix)]
        Some(28) => "disk-full",
        #[cfg(windows)]
        Some(39 | 112) => "disk-full",
        _ => "io",
    }
}

/// Dossier `logs/` : créé au besoin ; un lien, une jonction ou autre chose qu'un dossier ordinaire rend `unsafe-file`.
fn ensure_dir(dir: &Path, create: bool) -> Result<bool, LogError> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_dir() => Ok(true),
        Ok(_) => Err(fail("unsafe-file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !create {
                return Ok(false);
            }
            fs::create_dir_all(dir).map_err(|e| fail(io_code(&e)))?;
            match fs::symlink_metadata(dir) {
                Ok(meta) if meta.file_type().is_dir() => Ok(true),
                _ => Err(fail("unsafe-file")),
            }
        }
        Err(error) => Err(fail(io_code(&error))),
    }
}

/// État d'un fichier du journal sans suivre de lien : absent, fichier ordinaire (taille), ou refusé.
fn plain_file_len(path: &Path) -> Result<Option<u64>, LogError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(Some(meta.len())),
        Ok(_) => Err(fail("unsafe-file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(fail(io_code(&error))),
    }
}

/// Ouvre un fichier du journal sans suivre de lien (`O_NOFOLLOW` sous Unix, point d'analyse refusé sous Windows), puis revérifie sur le
/// descripteur qu'il s'agit d'un fichier ordinaire.
fn open_no_follow(path: &Path, options: &mut OpenOptions) -> Result<File, LogError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT : un lien est ouvert lui-même, puis refusé ci-dessous.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return fail("unsafe-file");
        }
        fail(io_code(&error))
    })?;
    let meta = file.metadata().map_err(|e| fail(io_code(&e)))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(fail("unsafe-file"));
        }
    }
    if !meta.is_file() {
        return Err(fail("unsafe-file"));
    }
    Ok(file)
}

/// Ajoute des lignes en fin de `circletasks.log`, avec rotation : si taille actuelle + ligne dépasse 256 Kio, le fichier devient `.1` (l'ancien
/// `.1` est remplacé) et un nouveau fichier est créé.
pub fn append_lines(dir: &Path, lines: &[String]) -> Result<usize, LogError> {
    if lines.is_empty() {
        return Ok(0);
    }
    ensure_dir(dir, true)?;
    let current = dir.join(CURRENT_FILE);
    let previous = dir.join(PREVIOUS_FILE);
    let mut written = 0;
    for line in lines {
        let size = plain_file_len(&current)?.unwrap_or(0);
        let needed = line.len() as u64 + 1;
        if size > 0 && size + needed > MAX_FILE_BYTES {
            plain_file_len(&previous)?;
            fs::rename(&current, &previous).map_err(|e| fail(io_code(&e)))?;
        }
        let mut file = open_no_follow(&current, OpenOptions::new().append(true).create(true))?;
        let mut bytes = line.clone().into_bytes();
        bytes.push(b'\n');
        file.write_all(&bytes).map_err(|e| fail(io_code(&e)))?;
        written += 1;
    }
    Ok(written)
}

/// Lit un fichier du journal (borné à 1 Mio), UTF-8 avec remplacement ; absent : vide.
fn read_file(path: &Path) -> Result<String, LogError> {
    if plain_file_len(path)?.is_none() {
        return Ok(String::new());
    }
    let file = open_no_follow(path, OpenOptions::new().read(true))?;
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES).read_to_end(&mut bytes).map_err(|_| fail("unreadable"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Les `max` dernières entrées (`.1` puis courant, plus récente en dernier). Une ligne qui n'est pas une entrée devient `log` /
/// `unreadable-line` (heure de l'entrée précédente), jamais une panique.
pub fn read_entries(dir: &Path, max: usize) -> Result<Vec<LogEntry>, LogError> {
    if !ensure_dir(dir, false)? {
        return Ok(Vec::new());
    }
    let mut entries: Vec<LogEntry> = Vec::new();
    for name in [PREVIOUS_FILE, CURRENT_FILE] {
        let text = read_file(&dir.join(name))?;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let parsed = serde_json::from_str::<LogEntry>(line).ok().filter(|e| is_scope(&e.scope) && is_code(&e.code));
            let entry = parsed.unwrap_or_else(|| LogEntry {
                at: entries.last().map_or_else(|| iso_of(now_secs()), |e| e.at.clone()),
                scope: "log".to_owned(),
                code: "unreadable-line".to_owned(),
                detail: String::new(),
                n: None,
            });
            entries.push(entry);
        }
    }
    let skip = entries.len().saturating_sub(max.clamp(1, MAX_READ_ENTRIES));
    Ok(entries.split_off(skip))
}

/// Supprime les deux fichiers (un lien est supprimé lui-même, jamais sa cible).
pub fn clear_files(dir: &Path) -> Result<(), LogError> {
    if !ensure_dir(dir, false)? {
        return Ok(());
    }
    for name in [CURRENT_FILE, PREVIOUS_FILE] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(fail(io_code(&error))),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------------------------------------
// Limitation de débit
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct Rate {
    minute: u64,
    count: u32,
    suppressed: u32,
}

/// Compteurs par couple (`scope`, `code`) et par minute.
#[derive(Debug, Default)]
pub struct RateTable {
    rates: BTreeMap<(String, String), Rate>,
}

impl RateTable {
    pub const fn new() -> Self {
        Self { rates: BTreeMap::new() }
    }

    /// Résumés des minutes passées (`log` / `suppressed`, `n`), à écrire avant les nouvelles entrées.
    fn summaries(&mut self, minute: u64, now_iso: &str) -> Vec<LogEntry> {
        let mut out = Vec::new();
        for ((scope, code), rate) in &mut self.rates {
            if rate.minute < minute && rate.suppressed > 0 {
                out.push(LogEntry { at: now_iso.to_owned(), scope: "log".to_owned(), code: "suppressed".to_owned(), detail: format!("{scope} {code}"), n: Some(rate.suppressed) });
                rate.suppressed = 0;
            }
        }
        self.rates.retain(|_, rate| rate.minute >= minute || rate.suppressed > 0);
        out
    }

    /// L'entrée peut-elle être écrite cette minute ? Sinon elle est comptée.
    fn admit(&mut self, entry: &LogEntry, minute: u64) -> bool {
        if entry.scope == "log" && entry.code == "suppressed" {
            return true;
        }
        let rate = self.rates.entry((entry.scope.clone(), entry.code.clone())).or_default();
        if rate.minute != minute {
            rate.minute = minute;
            rate.count = 0;
        }
        if rate.count < RATE_PER_MINUTE {
            rate.count += 1;
            true
        } else {
            rate.suppressed += entry.n.unwrap_or(1);
            false
        }
    }
}

/// Filtre une suite d'entrées par la limitation de débit et y ajoute les résumés des minutes passées ; rend les lignes à écrire.
pub fn admit_lines(rates: &mut RateTable, entries: &[LogEntry], now: u64) -> Vec<String> {
    let minute = now / 60;
    let now_iso = iso_of(now);
    let mut lines: Vec<String> = rates.summaries(minute, &now_iso).iter().map(line_of).collect();
    lines.extend(entries.iter().filter(|e| rates.admit(e, minute)).map(line_of));
    lines
}

// ------------------------------------------------------------------------------------------------------------------------------
// État du processus
// ------------------------------------------------------------------------------------------------------------------------------

struct State {
    dir: Option<PathBuf>,
    pending: Vec<LogEntry>,
    write_error: Option<&'static str>,
    rates: RateTable,
}

static STATE: Mutex<State> = Mutex::new(State { dir: None, pending: Vec::new(), write_error: None, rates: RateTable::new() });

#[cfg(feature = "test-hooks")]
thread_local! {
    /// Tests seulement : état propre au fil du test qui a appelé `reset_for_tests` (chaque test d'un processus s'exécute sur son fil).
    static LOCAL: std::cell::RefCell<Option<State>> = const { std::cell::RefCell::new(None) };
}

/// Accès à l'état du processus. Avec `test-hooks`, un fil qui a appelé `reset_for_tests` a son état à lui : les écritures des autres tests,
/// sur d'autres fils, ne peuvent pas entrer dans son journal (elles allaient dans le dossier fixé par `init` du dernier test, d'où le
/// test intermittent « base illisible » de P-04-iOS qui y trouvait un `provisional-marker-settled` venu d'un autre test).
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    #[cfg(feature = "test-hooks")]
    {
        /// Remet l'état du fil en place même si `f` panique (sinon il serait perdu et les écritures suivantes iraient à l'état global).
        struct Restore(Option<State>);
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(own) = self.0.take() {
                    LOCAL.with(|cell| *cell.borrow_mut() = Some(own));
                }
            }
        }
        let local = LOCAL.with(|cell| cell.borrow_mut().take());
        if let Some(own) = local {
            let mut guard = Restore(Some(own));
            return f(guard.0.as_mut().expect("état du fil"));
        }
    }
    f(&mut STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
}

/// Copie sur la sortie d'erreur (développement et `test-hooks` seulement) : **le seul `eprintln!` du code**.
pub fn echo(line: &str) {
    #[cfg(any(debug_assertions, feature = "test-hooks"))]
    eprintln!("{line}");
    #[cfg(not(any(debug_assertions, feature = "test-hooks")))]
    let _ = line;
}

fn record_outcome(state: &mut State, outcome: &Result<usize, LogError>) {
    match outcome {
        Ok(_) => state.write_error = None,
        Err(error) => state.write_error = Some(error.code),
    }
}

/// Fixe le dossier du journal (`<app_config_dir>/logs`, début du `setup` PC et iPhone) et écrit les entrées internes en attente.
pub fn init(dir: PathBuf) {
    with_state(|state| init_in(state, dir));
}

fn init_in(state: &mut State, dir: PathBuf) {
    let pending = std::mem::take(&mut state.pending);
    let lines = admit_lines(&mut state.rates, &pending, now_secs());
    let outcome = append_lines(&dir, &lines);
    record_outcome(state, &outcome);
    state.dir = Some(dir);
}

/// Tests seulement (`test-hooks`) : état propre au fil appelant, remis à neuf (dossier, entrées en attente, débit) ; l'état global n'est pas
/// touché. Les écritures faites SUR CE FIL (le test lui-même et le code synchrone qu'il appelle) vont dans ce journal, et les écritures des
/// autres tests n'y entrent plus. Limite : une écriture faite depuis un autre fil (`thread::spawn`, `spawn_blocking`, exécuteur asynchrone)
/// va à l'état global, pas au journal du test ; un test qui relit un journal ne doit donc écrire que depuis son fil.
/// À appeler sous `support::applog_dir_lock()` (voir ce verrou).
#[cfg(feature = "test-hooks")]
pub fn reset_for_tests() {
    LOCAL.with(|cell| *cell.borrow_mut() = Some(State { dir: None, pending: Vec::new(), write_error: None, rates: RateTable::new() }));
}

/// Écriture interne à Rust : deux identifiants fixes, aucun texte dynamique. Avant `init`, gardée en mémoire (100 au plus).
pub fn write(scope: &'static str, code: &'static str) {
    write_entry(scope, code, None);
}

/// Comme `write`, avec un compteur (`n`, par exemple le nombre de temporaires purgés) : toujours aucun texte dynamique.
pub fn write_count(scope: &'static str, code: &'static str, count: u32) {
    write_entry(scope, code, Some(count));
}

fn write_entry(scope: &'static str, code: &'static str, count: Option<u32>) {
    echo(&format!("[{scope}] {code}"));
    let entry = LogEntry { at: iso_of(now_secs()), scope: scope.to_owned(), code: code.to_owned(), detail: String::new(), n: count };
    with_state(|state| {
        let Some(dir) = state.dir.clone() else {
            if state.pending.len() >= MAX_PENDING {
                state.pending.remove(0);
            }
            state.pending.push(entry);
            return;
        };
        let lines = admit_lines(&mut state.rates, &[entry], now_secs());
        let outcome = append_lines(&dir, &lines);
        record_outcome(state, &outcome);
    });
}

/// Dernier échec d'écriture du processus (`None` après une écriture réussie).
pub fn write_error() -> Option<&'static str> {
    with_state(|state| state.write_error)
}

/// Réponse de `log_append`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendOutcome {
    pub written: usize,
    pub write_error: Option<&'static str>,
}

/// Réponse de `log_read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOutcome {
    pub entries: Vec<LogEntry>,
    pub write_error: Option<&'static str>,
}

/// Réponse de `log_clear`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ClearOutcome {
    pub cleared: bool,
}

/// `log_append` sur un dossier donné (tests) : au plus 100 entrées (`too-many`, rien n'est écrit), normalisées, limitées, écrites.
pub fn append_in(dir: &Path, rates: &mut RateTable, entries: &[LogEntryIn], now: u64) -> Result<usize, LogError> {
    if entries.len() > MAX_APPEND_ENTRIES {
        return Err(fail("too-many"));
    }
    let now_iso = iso_of(now);
    let normalized: Vec<LogEntry> = entries.iter().map(|e| normalize(e, &now_iso)).collect();
    let lines = admit_lines(rates, &normalized, now);
    append_lines(dir, &lines)
}

/// `log_clear` sur un dossier donné (tests) : supprime les deux fichiers, puis écrit `logs` / `logs-cleared` en première entrée.
pub fn clear_in(dir: &Path, now: u64) -> Result<(), LogError> {
    clear_files(dir)?;
    let entry = LogEntry { at: iso_of(now), scope: "logs".to_owned(), code: "logs-cleared".to_owned(), detail: String::new(), n: None };
    append_lines(dir, &[line_of(&entry)]).map(|_| ())
}

fn logs_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, LogError> {
    use tauri::Manager;
    app.path().app_config_dir().map(|dir| dir.join(LOG_DIR)).map_err(|_| fail("io"))
}

/// Ajoute des entrées de la WebView (100 au plus, hors du fil de l'interface).
#[tauri::command]
pub async fn log_append(app: tauri::AppHandle, entries: Vec<LogEntryIn>) -> Result<AppendOutcome, LogError> {
    if entries.len() > MAX_APPEND_ENTRIES {
        return Err(fail("too-many"));
    }
    let dir = logs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_state(|state| {
            let outcome = append_in(&dir, &mut state.rates, &entries, now_secs());
            record_outcome(state, &outcome);
            outcome.map(|written| AppendOutcome { written, write_error: state.write_error })
        })
    })
    .await
    .map_err(|_| fail("io"))?
}

/// Les `max` dernières entrées (1 à 500) et le dernier échec d'écriture.
#[tauri::command]
pub async fn log_read(app: tauri::AppHandle, max: usize) -> Result<ReadOutcome, LogError> {
    let dir = logs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_state(|state| {
            let entries = read_entries(&dir, max.clamp(1, MAX_READ_ENTRIES))?;
            Ok(ReadOutcome { entries, write_error: state.write_error })
        })
    })
    .await
    .map_err(|_| fail("io"))?
}

/// Efface le journal (après confirmation dans l'interface).
#[tauri::command]
pub async fn log_clear(app: tauri::AppHandle) -> Result<ClearOutcome, LogError> {
    let dir = logs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_state(|state| {
            let outcome = clear_in(&dir, now_secs()).map(|()| 1);
            record_outcome(state, &outcome);
            outcome.map(|_| ClearOutcome { cleared: true })
        })
    })
    .await
    .map_err(|_| fail("io"))?
}
