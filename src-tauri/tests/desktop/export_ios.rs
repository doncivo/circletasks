//! FILES-IOS-01 (ADR 0009 avenant lot F, points A1 à A3) : export sur iPhone. Contrôles de taille et de nom (module commun), temporaire
//! sous `exports/<16 hex>/` en création exclusive, suppression dans tous les cas (succès, annulation, rejet, `panic`), un seul
//! enregistrement à la fois, dossier piégé refusé, purge au démarrage ; contrat statique du plugin Swift `ct-files` (fixture, Swift, Rust).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use circletasks_lib::export_common::{mime_for, ALLOWED_EXTENSIONS, MAX_EXPORT_BYTES};
use circletasks_lib::export_ios::{prepare, purge_exports, save_prepared, ExportIosState, PreparedExport, SaveTransport, EXPORTS_DIR, PLUGIN_REJECT_CODES};
use serde_json::Value;

const CONTRACT: &str = include_str!("../../../tests/fixtures/files/files-contract.json");
const SWIFT: &str = include_str!("../../plugins/files/ios/Sources/CtFilesPlugin.swift");
const EXPORT_IOS_RS: &str = include_str!("../../src/export_ios.rs");
const PLUGIN_LIB: &str = include_str!("../../plugins/files/src/lib.rs");
const PLUGIN_BUILD: &str = include_str!("../../plugins/files/build.rs");
const PLUGIN_CARGO: &str = include_str!("../../plugins/files/Cargo.toml");
const PACKAGE_SWIFT: &str = include_str!("../../plugins/files/ios/Package.swift");

fn header(name: &str) -> String {
    STANDARD.encode(name.as_bytes())
}

fn raw(bytes: &[u8]) -> tauri::ipc::InvokeBody {
    tauri::ipc::InvokeBody::Raw(bytes.to_vec())
}

fn prepared(name: &str, data: &[u8]) -> PreparedExport {
    prepare(Some(&header(name)), &raw(data)).expect("préparé")
}

/// Ce que le faux transport a vu pendant la présentation (le fichier doit alors exister).
#[derive(Default, Clone)]
struct Seen {
    path: Option<PathBuf>,
    mime: Option<String>,
    content: Option<Vec<u8>>,
}

struct FakeTransport {
    answer: Result<bool, String>,
    seen: Arc<Mutex<Seen>>,
}

impl FakeTransport {
    fn new(answer: Result<bool, String>) -> (Self, Arc<Mutex<Seen>>) {
        let seen = Arc::new(Mutex::new(Seen::default()));
        (Self { answer, seen: seen.clone() }, seen)
    }
}

impl SaveTransport for FakeTransport {
    fn present(&self, path: &Path, mime: &str) -> Result<bool, String> {
        let mut seen = self.seen.lock().unwrap();
        seen.path = Some(path.to_path_buf());
        seen.mime = Some(mime.to_owned());
        seen.content = fs::read(path).ok();
        self.answer.clone()
    }
}

fn exports_entries(cache: &Path) -> usize {
    fs::read_dir(cache.join(EXPORTS_DIR)).map(|entries| entries.count()).unwrap_or(0)
}

// --- critère 3 : taille et nom (module commun, mêmes règles qu'au PC) ---

#[test]
fn files_ios_01_3_a_body_above_64_mib_is_refused_before_anything_else() {
    let big = tauri::ipc::InvokeBody::Raw(vec![0u8; MAX_EXPORT_BYTES + 1]);
    assert_eq!(prepare(Some(&header("x.csv")), &big).unwrap_err().code, "too-large");
    // La taille passe avant le nom : un en-tête absent ne change rien.
    assert_eq!(prepare(None, &big).unwrap_err().code, "too-large");
}

#[test]
fn files_ios_01_3_missing_or_unreadable_name_header_is_bad_name() {
    assert_eq!(prepare(None, &raw(b"x")).unwrap_err().code, "bad-name");
    assert_eq!(prepare(Some("***"), &raw(b"x")).unwrap_err().code, "bad-name");
    assert_eq!(prepare(Some(&"A".repeat(2000)), &raw(b"x")).unwrap_err().code, "bad-name");
}

#[test]
fn files_ios_01_3_names_are_reduced_like_on_the_pc() {
    assert_eq!(prepared("..\\x", b"1").name, "x");
    assert_eq!(prepared("/etc/x", b"1").name, "x");
    assert_eq!(prepared("", b"1").name, "export");
    assert_eq!(prepared("..", b"1").name, "export");
    assert_eq!(prepared("CON.csv", b"1").name, "_CON.csv");
    assert_eq!(prepared(&format!("{}.pdf", "a".repeat(400)), b"1").name.chars().count(), 200);
}

#[test]
fn files_ios_01_3_the_type_is_derived_from_the_extension_never_from_the_request() {
    for (name, mime) in [("a.csv", "text/csv"), ("a.JSON", "application/json"), ("a.pdf", "application/pdf"), ("a.png", "image/png"), ("circletasks-logs-20261008-0912.txt", "text/plain")] {
        assert_eq!(prepared(name, b"1").mime, mime, "{name}");
    }
    assert_eq!(prepared("a.exe", b"1").mime, "application/octet-stream");
    assert!(ALLOWED_EXTENSIONS.contains(&"txt"), "export des logs d'I-04, PC compris");
}

// --- critère 3 : temporaire et suppression dans tous les cas ---

#[test]
fn files_ios_01_3_success_writes_under_exports_then_removes_everything() {
    let cache = tempfile::tempdir().unwrap();
    let state = ExportIosState::default();
    let (transport, seen) = FakeTransport::new(Ok(true));
    let (result, report) = save_prepared(&state, cache.path(), &prepared("circletasks-taches.csv", b"titre;date\r\n"), &transport);
    assert!(result.unwrap().completed);
    assert!(!report.remove_failed);
    let seen = seen.lock().unwrap().clone();
    let path = seen.path.expect("présenté");
    assert_eq!(seen.content.as_deref(), Some(&b"titre;date\r\n"[..]), "fichier complet au moment de la présentation");
    assert_eq!(seen.mime.as_deref(), Some("text/csv"));
    assert_eq!(path.file_name().unwrap(), "circletasks-taches.csv", "le nom proposé reste visible dans le sélecteur");
    let token = path.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(token.len(), 16);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{token}");
    assert_eq!(path.parent().unwrap().parent().unwrap(), cache.path().join(EXPORTS_DIR));
    assert!(!path.exists() && !path.parent().unwrap().exists(), "fichier et sous-dossier supprimés");
    assert_eq!(exports_entries(cache.path()), 0);
}

#[test]
fn files_ios_01_3_cancel_is_not_an_error_and_removes_the_temporary() {
    let cache = tempfile::tempdir().unwrap();
    let (transport, _) = FakeTransport::new(Ok(false));
    let (result, _) = save_prepared(&ExportIosState::default(), cache.path(), &prepared("a.pdf", b"%PDF"), &transport);
    assert!(!result.unwrap().completed);
    assert_eq!(exports_entries(cache.path()), 0);
}

#[test]
fn files_ios_01_3_plugin_rejections_keep_known_codes_and_remove_the_temporary() {
    for (rejected, expected) in [("not-foreground", "not-foreground"), ("failed", "failed"), ("boom", "failed"), ("", "failed")] {
        let cache = tempfile::tempdir().unwrap();
        let (transport, _) = FakeTransport::new(Err(rejected.to_owned()));
        let (result, _) = save_prepared(&ExportIosState::default(), cache.path(), &prepared("a.json", b"{}"), &transport);
        assert_eq!(result.unwrap_err().code, expected, "{rejected}");
        assert_eq!(exports_entries(cache.path()), 0, "{rejected}");
    }
}

struct PanickingTransport;

impl SaveTransport for PanickingTransport {
    fn present(&self, _path: &Path, _mime: &str) -> Result<bool, String> {
        panic!("transport en panne");
    }
}

#[test]
fn files_ios_01_3_a_panic_during_presentation_still_removes_the_temporary() {
    let cache = tempfile::tempdir().unwrap();
    let state = ExportIosState::default();
    let item = prepared("a.png", b"\x89PNG");
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| save_prepared(&state, cache.path(), &item, &PanickingTransport)));
    assert!(outcome.is_err());
    assert_eq!(exports_entries(cache.path()), 0, "garde Drop");
}

/// Transport qui tente un second enregistrement pendant le premier.
struct Reentrant<'a> {
    state: &'a ExportIosState,
    cache: PathBuf,
    second: Mutex<Option<&'static str>>,
}

impl SaveTransport for Reentrant<'_> {
    fn present(&self, _path: &Path, _mime: &str) -> Result<bool, String> {
        let (transport, _) = FakeTransport::new(Ok(true));
        let (result, _) = save_prepared(self.state, &self.cache, &prepared("b.csv", b"2"), &transport);
        *self.second.lock().unwrap() = Some(result.map_or_else(|e| e.code, |_| "ok"));
        Ok(true)
    }
}

#[test]
fn files_ios_01_3_a_second_save_while_one_is_presented_is_busy() {
    let cache = tempfile::tempdir().unwrap();
    let state = ExportIosState::default();
    let transport = Reentrant { state: &state, cache: cache.path().to_path_buf(), second: Mutex::new(None) };
    let (result, _) = save_prepared(&state, cache.path(), &prepared("a.csv", b"1"), &transport);
    assert!(result.unwrap().completed);
    assert_eq!(*transport.second.lock().unwrap(), Some("busy"));
    assert_eq!(exports_entries(cache.path()), 0);
}

#[test]
fn files_ios_01_3_an_exports_entry_that_is_not_a_plain_folder_is_refused_without_writing() {
    // Fichier à la place du dossier.
    let cache = tempfile::tempdir().unwrap();
    fs::write(cache.path().join(EXPORTS_DIR), b"trap").unwrap();
    let (transport, seen) = FakeTransport::new(Ok(true));
    let (result, _) = save_prepared(&ExportIosState::default(), cache.path(), &prepared("a.csv", b"1"), &transport);
    assert_eq!(result.unwrap_err().code, "unsafe-folder");
    assert!(seen.lock().unwrap().path.is_none(), "rien n'est présenté");
    assert_eq!(fs::read(cache.path().join(EXPORTS_DIR)).unwrap(), b"trap");

    // Lien (jonction sous Windows, lien symbolique sous Unix) vers un autre dossier : rien n'y est écrit.
    let cache = tempfile::tempdir().unwrap();
    let elsewhere = cache.path().join("ailleurs");
    fs::create_dir_all(&elsewhere).unwrap();
    let link = cache.path().join(EXPORTS_DIR);
    #[cfg(windows)]
    let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&elsewhere).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&elsewhere, &link).is_ok();
    assert!(made, "lien créé");
    let (transport, seen) = FakeTransport::new(Ok(true));
    let (result, _) = save_prepared(&ExportIosState::default(), cache.path(), &prepared("a.csv", b"1"), &transport);
    assert_eq!(result.unwrap_err().code, "unsafe-folder");
    assert!(seen.lock().unwrap().path.is_none());
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "aucune écriture à travers le lien");
}

#[test]
fn files_ios_01_3_the_exports_folder_is_created_when_missing() {
    let cache = tempfile::tempdir().unwrap();
    let nested = cache.path().join("fr.circletasks.planner");
    let (transport, _) = FakeTransport::new(Ok(true));
    let (result, _) = save_prepared(&ExportIosState::default(), &nested, &prepared("a.txt", b"log"), &transport);
    assert!(result.unwrap().completed);
    assert!(nested.join(EXPORTS_DIR).is_dir());
}

// --- critère 3 : purge au démarrage ---

#[test]
fn files_ios_01_3_startup_purge_removes_leftovers_without_following_links() {
    let cache = tempfile::tempdir().unwrap();
    assert_eq!(purge_exports(cache.path()), Ok(0), "aucun dossier : rien à faire");
    let exports = cache.path().join(EXPORTS_DIR);
    fs::create_dir_all(exports.join("0123456789abcdef")).unwrap();
    fs::write(exports.join("0123456789abcdef").join("reste.csv"), b"x").unwrap();
    fs::write(exports.join("orphelin.tmp"), b"y").unwrap();
    // Un lien dans exports/ est supprimé lui-même, jamais sa cible.
    let target = cache.path().join("cible");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("garder.txt"), b"z").unwrap();
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(exports.join("lien")).arg(&target).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, exports.join("lien")).is_ok();
    assert!(linked);
    assert_eq!(purge_exports(cache.path()), Ok(3));
    assert_eq!(fs::read_dir(&exports).unwrap().count(), 0);
    assert_eq!(fs::read(target.join("garder.txt")).unwrap(), b"z", "cible d'un lien intacte");
}

#[test]
fn files_ios_01_3_startup_purge_removes_an_exports_entry_that_is_a_file() {
    let cache = tempfile::tempdir().unwrap();
    fs::write(cache.path().join(EXPORTS_DIR), b"trap").unwrap();
    assert_eq!(purge_exports(cache.path()), Ok(1));
    assert!(!cache.path().join(EXPORTS_DIR).exists());
}

// --- critère 4 : contrat statique (fixture, Swift, Rust) ---

/// Lignes du Swift sans commentaires.
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

#[test]
fn files_ios_01_4_contract_commands_and_fields_match_swift_and_rust() {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let code = swift_code();
    let commands = contract["commands"].as_object().unwrap();
    for (name, spec) in commands {
        assert!(code.contains(&format!("@objc public func {name}(_ invoke: Invoke)")), "{name} absent du Swift");
        let input: BTreeSet<String> = spec["input"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        let start = code.find("struct PresentArgs: Decodable {").expect("structure d'arguments");
        let body = &code[start..start + code[start..].find('}').unwrap()];
        let fields: BTreeSet<String> = body.lines().filter_map(|l| l.trim().strip_prefix("let ")).map(|l| l.split(':').next().unwrap().trim().to_owned()).collect();
        assert_eq!(fields, input, "{name} : champs d'entrée Swift");
        assert!(code.contains("invoke.parseArgs(PresentArgs.self)"));
        for shape in spec["output"].as_array().unwrap() {
            for key in shape.as_array().unwrap() {
                let key = key.as_str().unwrap();
                assert!(code.contains(&format!("[\"{key}\":")), "{name} : clé de sortie {key} absente du Swift");
                assert!(EXPORT_IOS_RS.contains(&format!("get(\"{key}\")")), "{name} : clé {key} non lue par Rust");
            }
        }
        assert!(EXPORT_IOS_RS.contains(&format!("call(\"{name}\"")), "{name} jamais appelé par Rust");
        for field in &input {
            assert!(EXPORT_IOS_RS.contains(&format!("\"{field}\":")), "{name} : champ {field} absent de l'appel Rust");
        }
    }
    let methods: BTreeSet<String> = code
        .split("@objc public func ")
        .skip(1)
        .map(|rest| rest[..rest.find('(').unwrap()].to_owned())
        .collect();
    assert_eq!(methods, commands.keys().cloned().collect::<BTreeSet<_>>(), "méthodes Swift = commandes du contrat");
    // Classe, point d'entrée, liaison Rust, nom du plugin.
    assert!(code.contains(&format!("class {}: Plugin", contract["swiftClass"].as_str().unwrap())));
    assert!(code.contains(&format!("@_cdecl(\"{}\")", contract["binding"].as_str().unwrap())));
    assert!(PLUGIN_LIB.contains(&format!("tauri::ios_plugin_binding!({});", contract["binding"].as_str().unwrap())));
    assert!(PLUGIN_LIB.contains(&format!("Builder::new(\"{}\")", contract["plugin"].as_str().unwrap())));
}

#[test]
fn files_ios_01_4_reject_codes_are_known_to_rust_and_swift_rejects_only_through_codes() {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let codes: BTreeSet<&str> = contract["rejectCodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(codes, PLUGIN_REJECT_CODES.iter().copied().collect::<BTreeSet<_>>());
    let code = swift_code();
    let start = code.find("private enum Code: String {").unwrap();
    let body = &code[start..start + code[start..].find('}').unwrap()];
    let swift_codes: BTreeSet<String> = body.lines().filter_map(|l| l.split('"').nth(1)).map(str::to_owned).collect();
    assert_eq!(swift_codes, codes.iter().map(|c| (*c).to_owned()).collect::<BTreeSet<_>>());
    assert_eq!(code.matches("invoke.reject(").count(), 1, "un seul appel direct, dans `reject`");
    assert!(code.contains("invoke.reject(code.rawValue, code: code.rawValue)"));
    // Codes renvoyés à la WebView : ceux de la fixture, tous présents dans export_ios.rs.
    for rust_code in contract["rustErrorCodes"].as_array().unwrap() {
        assert!(EXPORT_IOS_RS.contains(&format!("\"{}\"", rust_code.as_str().unwrap())), "{rust_code}");
    }
}

#[test]
fn files_ios_01_4_types_match_between_fixture_swift_and_rust() {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let table = contract["mimeByExtension"].as_object().unwrap();
    let extensions: BTreeSet<&str> = table.keys().map(String::as_str).collect();
    assert_eq!(extensions, ALLOWED_EXTENSIONS.iter().copied().collect::<BTreeSet<_>>());
    let code = swift_code();
    for (ext, mime) in table {
        let mime = mime.as_str().unwrap();
        assert_eq!(mime_for(ext), mime, "{ext}");
        assert!(code.contains(&format!("\"{ext}\": \"{mime}\"")), "{ext} absent de la table Swift");
    }
    assert!(code.contains(&format!("\"{}\"", contract["fallbackMime"].as_str().unwrap())));
    assert!(code.contains(&format!("\"{}\"", contract["exportsFolder"].as_str().unwrap())));
    assert!(EXPORT_IOS_RS.contains(&format!("pub const EXPORTS_DIR: &str = \"{}\";", contract["exportsFolder"].as_str().unwrap())));
}

#[test]
fn files_ios_01_4_swift_saves_to_files_and_never_shares() {
    let code = swift_code();
    // Décision du 2026-10-08 (H-03 : aucune donnée ne quitte l'appareil) : sélecteur d'export, jamais le panneau de partage.
    assert!(code.contains("UIDocumentPickerViewController(forExporting: [url], asCopy: true)"));
    assert!(!code.contains("UIActivityViewController"), "aucun panneau de partage");
    // Présentation et résolution sur le fil principal ; refus hors du premier plan ; fin garantie au retour au premier plan.
    assert!(code.contains("DispatchQueue.main.async {"));
    assert!(code.contains("UIApplication.shared.applicationState != .active"));
    assert!(code.contains("UIApplication.didBecomeActiveNotification"));
    assert!(code.contains("isSymbolicLink") && code.contains("isRegularFile") && code.contains(".cachesDirectory"));
}

#[test]
fn files_ios_01_4_swift_has_no_french_text_nor_label() {
    const FRENCH: [&str; 10] = ["Annuler", "Enregistrer", "Fichier", "fichier", "Partager", "Erreur", "erreur", "Exporter", "Valider", "Fermer"];
    for literal in swift_literals() {
        assert!(literal.is_ascii(), "littéral non ASCII dans le Swift : {literal:?}");
        assert!(!literal.contains(' '), "littéral avec espace (libellé ?) dans le Swift : {literal:?}");
        for word in FRENCH {
            assert!(!literal.contains(word), "texte français dans le Swift : {literal:?}");
        }
    }
}

#[test]
fn files_ios_01_4_plugin_exposes_no_command_to_the_webview() {
    assert!(PLUGIN_BUILD.contains("const COMMANDS: &[&str] = &[];"), "aucune commande déclarée");
    assert!(PLUGIN_BUILD.contains(".ios_path(\"ios\")"));
    assert!(PLUGIN_CARGO.contains("name = \"tauri-plugin-ct-files\"") && PLUGIN_CARGO.contains("links = \"tauri-plugin-ct-files\""));
    assert!(PACKAGE_SWIFT.contains("name: \"tauri-plugin-ct-files\""));
    assert!(!PLUGIN_LIB.contains("invoke_handler"));
    assert!(PLUGIN_LIB.contains("pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String>"));
}
