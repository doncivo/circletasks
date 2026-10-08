//! CAP-IOS-01 (ADR 0015 §4.1) : contrôle statique des plugins Swift `vision` et `speech` contre leurs contrats
//! (`tests/fixtures/capture/*-contract.json`) et le Rust : mêmes méthodes et champs, chaque code de rejet connu de Rust, aucune chaîne
//! française en Swift, aucune permission `vision:` ni `speech:` (Rust seul appelle), crates sous `cfg(target_os = "ios")` seulement,
//! interdits de fichier, de réseau et de repli en ligne, capability exacte.

use std::collections::BTreeSet;

use serde_json::Value;

const VISION_SWIFT: &str = include_str!("../../plugins/vision/ios/Sources/VisionPlugin.swift");
const SPEECH_SWIFT: &str = include_str!("../../plugins/speech/ios/Sources/SpeechPlugin.swift");
const VISION_CONTRACT: &str = include_str!("../../../tests/fixtures/capture/vision-contract.json");
const SPEECH_CONTRACT: &str = include_str!("../../../tests/fixtures/capture/speech-contract.json");
const VISION_RS: &str = include_str!("../../src/ocr/vision.rs");
const SPEECH_RS: &str = include_str!("../../src/speech/mod.rs");
const LIB_RS: &str = include_str!("../../src/lib.rs");
const BUILD_RS: &str = include_str!("../../build.rs");
const CARGO_TOML: &str = include_str!("../../Cargo.toml");
const CAPTURE_IOS: &str = include_str!("../../capabilities/capture-ios.json");
const OCR_CAPABILITY: &str = include_str!("../../capabilities/ocr.json");

/// Un plugin à contrôler.
struct Plugin {
    name: &'static str,
    swift: &'static str,
    contract: &'static str,
}

const PLUGINS: [Plugin; 2] = [
    Plugin { name: "vision", swift: VISION_SWIFT, contract: VISION_CONTRACT },
    Plugin { name: "speech", swift: SPEECH_SWIFT, contract: SPEECH_CONTRACT },
];

/// Swift sans commentaires (`//` en début de ligne ou en fin de ligne hors chaîne).
fn code_of(swift: &str) -> String {
    swift
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

fn literals_of(swift: &str) -> Vec<String> {
    let code = code_of(swift);
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

/// Méthodes appelables par Tauri (`@objc public [override] func nom(_ invoke: Invoke)`) ; le corps est délimité par ses accolades.
fn methods_of(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let marker = "@objc public ";
    let mut from = 0;
    while let Some(found) = code[from..].find(marker) {
        let start = from + found + marker.len();
        from = start;
        let after = code[start..].strip_prefix("override ").unwrap_or(&code[start..]);
        let Some(signature) = after.strip_prefix("func ") else { continue };
        let Some((name, tail)) = signature.split_once('(') else { continue };
        if !tail.starts_with("_ invoke: Invoke)") {
            continue;
        }
        let open = start + code[start..].find('{').expect("accolade ouvrante");
        let mut depth = 0usize;
        let mut end = open;
        for (offset, c) in code[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        out.push((name.to_owned(), code[open..end].to_owned()));
    }
    out
}

fn struct_fields(code: &str, name: &str) -> BTreeSet<String> {
    let start = code.find(&format!("struct {name}: Decodable {{")).unwrap_or_else(|| panic!("structure absente : {name}"));
    let body = &code[start..start + code[start..].find('}').unwrap()];
    body.lines().filter_map(|l| l.trim().strip_prefix("let ")).map(|l| l.split(':').next().unwrap().trim().to_owned()).collect()
}

fn strings(list: &Value) -> BTreeSet<String> {
    list.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[test]
fn cap_ios_01_5_every_contract_command_exists_in_swift_with_the_same_fields() {
    for plugin in PLUGINS {
        let contract: Value = serde_json::from_str(plugin.contract).unwrap();
        let code = code_of(plugin.swift);
        let methods = methods_of(&code);
        let commands = contract["commands"].as_object().unwrap();
        assert_eq!(
            methods.iter().map(|(name, _)| name.clone()).collect::<BTreeSet<_>>(),
            commands.keys().cloned().collect::<BTreeSet<_>>(),
            "{} : méthodes Swift = commandes du contrat",
            plugin.name
        );
        for (name, body) in &methods {
            let spec = &commands[name.as_str()];
            let input = strings(&spec["input"]);
            let decoded = body.split("args(invoke, ").nth(1).map(|rest| rest[..rest.find(".self").unwrap()].to_owned());
            match decoded {
                Some(structure) => assert_eq!(struct_fields(&code, &structure), input, "{} {name} : champs d'entrée Swift", plugin.name),
                None => assert!(input.is_empty(), "{} {name} : aucune structure d'arguments", plugin.name),
            }
            for shape in spec["output"].as_array().unwrap() {
                for key in shape.as_array().unwrap() {
                    let key = key.as_str().unwrap();
                    assert!(plugin.swift.contains(&format!("\"{key}\":")), "{} {name} : clé de sortie {key} absente du Swift", plugin.name);
                }
            }
        }
        // Chaque structure `Decodable` du Swift sert à une commande du contrat.
        let decodables = code.matches(": Decodable {").count();
        let used: BTreeSet<_> = methods.iter().filter(|(_, body)| body.contains("args(invoke, ")).collect();
        assert_eq!(decodables, used.len(), "{} : une structure Decodable par commande à arguments", plugin.name);
    }
    // Lignes de Vision : champs du contrat dans le Swift.
    let vision: Value = serde_json::from_str(VISION_CONTRACT).unwrap();
    for key in strings(&vision["commands"]["recognize"]["line"]) {
        assert!(VISION_SWIFT.contains(&format!("\"{key}\":")), "champ de ligne {key} absent du Swift");
    }
}

#[test]
fn cap_ios_01_5_reject_codes_are_the_contract_codes_and_go_through_one_function() {
    for plugin in PLUGINS {
        let contract: Value = serde_json::from_str(plugin.contract).unwrap();
        let codes = strings(&contract["rejectCodes"]);
        let code = code_of(plugin.swift);
        let start = code.find("private enum Code: String {").unwrap();
        let body = &code[start..start + code[start..].find('}').unwrap()];
        let swift_codes: BTreeSet<String> = body.lines().filter_map(|l| l.split('"').nth(1)).map(str::to_owned).collect();
        assert_eq!(swift_codes, codes, "{} : codes Swift = contrat", plugin.name);
        // Chaque code Swift a sa correspondance Rust, et chaque correspondance vise un code que le Rust connaît.
        let mapping = contract["swiftToRust"].as_object().unwrap();
        assert_eq!(mapping.keys().cloned().collect::<BTreeSet<_>>(), codes, "{} : correspondances", plugin.name);
        let rust = if plugin.name == "vision" { VISION_RS } else { SPEECH_RS };
        let rust_manifest = if plugin.name == "vision" { include_str!("../../src/ocr/mod.rs") } else { SPEECH_RS };
        for target in mapping.values() {
            let target = target.as_str().unwrap();
            assert!(rust_manifest.contains(&format!("\"{target}\"")) || rust.contains(&format!("\"{target}\"")), "{} : code Rust inconnu {target}", plugin.name);
        }
        // Tout rejet passe par `reject(invoke, code)` : jamais un message libre.
        assert_eq!(code.matches("invoke.reject(").count(), 1, "{} : un seul appel direct, dans `reject`", plugin.name);
        assert!(code.contains("invoke.reject(code.rawValue, code: code.rawValue)"));
    }
}

#[test]
fn cap_ios_01_5_swift_has_no_french_text_nor_label() {
    const FRENCH: [&str; 16] = ["Annuler", "Choisir", "Dictée", "dictée", "Micro", "micro ", "Réglages", "Erreur", "erreur", "Écoute", "Lecture", "Fermer", "Valider", "Continuer", "Autoris", "Parlez"];
    for plugin in PLUGINS {
        for literal in literals_of(plugin.swift) {
            assert!(literal.is_ascii(), "{} : littéral non ASCII : {literal:?}", plugin.name);
            assert!(!literal.contains(' '), "{} : littéral avec espace (libellé ?) : {literal:?}", plugin.name);
            for word in FRENCH {
                assert!(!literal.contains(word), "{} : texte français dans le Swift : {literal:?}", plugin.name);
            }
        }
    }
}

#[test]
fn cap_ios_01_every_method_resolves_or_rejects_on_all_paths() {
    for plugin in PLUGINS {
        let code = code_of(plugin.swift);
        for (name, body) in methods_of(&code) {
            // Réponse directe, ou confiée à l'assistant qui répond une fois (listen).
            let answers = ["invoke.resolve(", "reject(invoke", "startListening(", "resolvePermissions(", "args(invoke"];
            assert!(answers.iter().any(|a| body.contains(a)), "{} {name} : aucune réponse", plugin.name);
            // Aucun `return` nu sans réponse juste avant (guard qui sort en silence).
            let lines: Vec<&str> = body.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            for (i, line) in lines.iter().enumerate() {
                if *line == "return" {
                    let previous = lines[i - 1];
                    let ok = ["resolve(", "reject(", "args(invoke"].iter().any(|a| previous.contains(a));
                    assert!(ok, "{} {name} : `return` sans réponse après `{previous}`", plugin.name);
                }
            }
        }
    }
    // `openAppSettings` résout dans tous ses chemins, y compris l'échec d'ouverture (constat 5 de l'ADR 0015).
    let settings = methods_of(&code_of(SPEECH_SWIFT)).into_iter().find(|(name, _)| name == "openAppSettings").unwrap().1;
    assert!(settings.contains("invoke.resolve([\"opened\": false])") && settings.contains("invoke.resolve([\"opened\": success])"), "{settings}");
}

#[test]
fn cap_ios_01_11_dictation_is_on_device_only_and_nothing_is_written_or_sent() {
    let code = code_of(SPEECH_SWIFT);
    assert_eq!(code.matches("requiresOnDeviceRecognition").count(), 1, "une seule affectation de requiresOnDeviceRecognition");
    assert!(code.contains("request.requiresOnDeviceRecognition = true"));
    assert!(!code.contains("requiresOnDeviceRecognition = false") && !code.contains("requiresOnDeviceRecognition=false"));
    // Sans modèle hors ligne : refus avant toute requête.
    let start = code.find("private func startListening").unwrap();
    let body = &code[start..];
    assert!(body.find("supportsOnDeviceRecognition").unwrap() < body.find("recognitionTask(with:").unwrap(), "le modèle hors ligne est vérifié avant toute tâche");
    assert!(body.contains("reject(invoke, .onDeviceUnavailable)"));
    // Décision d'Ali : aucun chemin ne peut envoyer l'audio à Apple. Ordre dans `startListening` : reconnaisseur disponible, modèle hors ligne
    // présent, PUIS création de la requête, affectation de `requiresOnDeviceRecognition = true`, PUIS seulement la tâche.
    let order = ["recognizer.isAvailable", "supportsOnDeviceRecognition", "Listening(invoke:", "requiresOnDeviceRecognition = true", "recognitionTask(with:"];
    let positions: Vec<usize> = order.iter().map(|needle| body.find(needle).unwrap_or_else(|| panic!("{needle} absent de startListening"))).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "ordre des garde-fous : {positions:?}");
    assert!(body.contains("reject(invoke, .recognizerUnavailable)"));
    // Une seule requête et une seule tâche dans tout le plugin ; aucune autre sorte de requête (fichier, URL).
    assert_eq!(code.matches("SFSpeechAudioBufferRecognitionRequest()").count(), 1);
    assert_eq!(code.matches("recognitionTask(with:").count(), 1);
    for forbidden in ["SFSpeechURLRecognitionRequest", "SFSpeechRecognitionRequest(", "defaultTaskHint", "requiresOnDeviceRecognition ="] {
        let allowed = usize::from(forbidden == "requiresOnDeviceRecognition =");
        assert_eq!(code.matches(forbidden).count(), allowed, "{forbidden}");
    }
    // Tampon audio : directement à la requête.
    assert!(code.contains("request.append(buffer)"));
    // Session désactivée, moteur arrêté, tap retiré à chaque fin.
    for needle in ["setActive(false, options: .notifyOthersOnDeactivation)", "engine.stop()", "removeTap(onBus: 0)", "request.endAudio()", "task?.cancel()"] {
        assert!(code.contains(needle), "{needle} absent");
    }
    // Arrêts natifs.
    for needle in ["didEnterBackgroundNotification", "interruptionNotification", "routeChangeNotification", "mediaServicesWereResetNotification"] {
        assert!(code.contains(needle), "{needle} absent");
    }
    assert!(!code.contains("willResignActive"), "le Centre de contrôle et les bannières n'arrêtent pas la dictée");
    for plugin in PLUGINS {
        let code = code_of(plugin.swift);
        for forbidden in [
            "AVAudioRecorder",
            "AVAudioFile",
            "FileManager",
            "write(to:",
            "URLSession",
            "URLRequest",
            "NWConnection",
            "fileURLWithPath",
            "UIImageWriteToSavedPhotosAlbum",
            "Data(contentsOf",
            "NSKeyedArchiver",
            "UserDefaults",
            "print(",
            "NSLog(",
            "os_log",
            "Logger(",
        ] {
            assert!(!code.contains(forbidden), "{} : `{forbidden}` interdit", plugin.name);
        }
    }
    // Pas de mode d'arrière-plan demandé par le code.
    assert!(!code.contains("beginBackgroundTask"));
}

#[test]
fn cap_ios_01_5_vision_runs_off_the_main_and_ipc_queues_with_a_time_guard() {
    let code = code_of(VISION_SWIFT);
    assert!(code.contains("visionQueue.async"));
    assert!(!code.contains("DispatchQueue.main") && !code.contains("Thread.isMainThread"));
    for needle in ["kCGImageSourceShouldCache", "kCGImagePropertyPixelWidth", "kCGImagePropertyOrientation", "VNRecognizeTextRequestRevision3", "request.cancel()", ".accurate", "usesLanguageCorrection = true"] {
        assert!(code.contains(needle), "{needle} absent");
    }
    // Dimensions contrôlées avant le décodage de l'image.
    assert!(code.find("width > input.maxSide").unwrap() < code.find("CGImageSourceCreateImageAtIndex").unwrap());
    // Un seul résultat par appel.
    assert!(code.contains("settle.first()"));
}

#[test]
fn cap_ios_01_5_plugins_are_called_by_rust_only() {
    for (name, build, lib) in [
        ("vision", include_str!("../../plugins/vision/build.rs"), include_str!("../../plugins/vision/src/lib.rs")),
        ("speech", include_str!("../../plugins/speech/build.rs"), include_str!("../../plugins/speech/src/lib.rs")),
    ] {
        assert!(build.contains("const COMMANDS: &[&str] = &[];"), "{name} : aucune commande déclarée");
        assert!(build.contains(".ios_path(\"ios\")"));
        assert!(lib.contains("pub fn call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String>"));
        assert!(lib.contains("run_mobile_plugin") && !lib.contains("#[tauri::command]"));
        assert!(lib.contains(&format!("Builder::new(\"{name}\")")) && lib.contains(&format!("init_plugin_{name}")));
    }
    // Aucune capability n'accorde une permission des plugins (elles n'existent pas).
    for entry in std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")).expect("capabilities") {
        let path = entry.expect("entrée").path();
        let text = std::fs::read_to_string(&path).expect("capability");
        for needle in ["\"vision:", "\"speech:"] {
            assert!(!text.contains(needle), "{} accorde une permission de plugin", path.display());
        }
    }
}

#[test]
fn cap_ios_01_15_crates_are_ios_dependencies_only_and_registered_for_ios_only() {
    let mut section = String::new();
    let mut found = 0;
    for line in CARGO_TOML.lines() {
        if line.starts_with('[') {
            section = line.trim().to_owned();
        }
        if line.starts_with("tauri-plugin-vision") || line.starts_with("tauri-plugin-speech") {
            found += 1;
            assert_eq!(section, "[target.'cfg(target_os = \"ios\")'.dependencies]", "plugin hors de la section iOS : {line}");
        }
    }
    assert_eq!(found, 2);
    let lines: Vec<&str> = LIB_RS.lines().collect();
    let line_of = |needle: &str| lines.iter().position(|l| l.contains(needle)).unwrap_or_else(|| panic!("{needle} absent de lib.rs"));
    // Enregistrement des plugins et de leurs états : sous cfg(target_os = "ios").
    let plugins = line_of("tauri_plugin_vision::init()");
    assert_eq!(lines[plugins - 1].trim(), "#[cfg(target_os = \"ios\")]");
    assert!(lines[plugins].contains("tauri_plugin_speech::init()") && lines[plugins].contains("SpeechState::default()") && lines[plugins].contains("VisionState::default()"));
    // Commandes de dictée : dans le gestionnaire iOS seulement.
    let first_speech_command = line_of("speech::ios::speech_status");
    let handler = (0..first_speech_command).rev().find(|i| lines[*i].contains("invoke_handler")).expect("gestionnaire");
    assert_eq!(lines[handler - 1].trim(), "#[cfg(target_os = \"ios\")]", "les commandes speech_* ne sont que dans le gestionnaire iOS");
    assert_eq!(LIB_RS.matches("speech::ios::").count(), 5, "cinq commandes, une fois chacune");
    assert!(LIB_RS.contains("#[cfg(any(desktop, target_os = \"ios\"))]\npub mod ocr;"));
    // Manifeste des commandes.
    for command in ["speech_status", "speech_request_permissions", "speech_listen", "speech_stop", "app_settings_open", "ocr_status", "ocr_recognize"] {
        assert!(BUILD_RS.contains(&format!("\"{command}\"")), "{command} absent de build.rs");
    }
}

#[test]
fn cap_ios_01_15_capture_capability_is_ios_only_with_the_exact_list_and_ocr_stays_windows_only() {
    let capability: Value = serde_json::from_str(CAPTURE_IOS).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "allow-ocr-status",
            "allow-ocr-recognize",
            "allow-speech-status",
            "allow-speech-request-permissions",
            "allow-speech-listen",
            "allow-speech-stop",
            "allow-app-settings-open"
        ])
    );
    let ocr: Value = serde_json::from_str(OCR_CAPABILITY).expect("capability valide");
    assert_eq!(ocr["platforms"], serde_json::json!(["windows"]));
    // Aucune autre capability n'accorde les commandes de dictée ni de Réglages.
    for entry in std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")).expect("capabilities") {
        let path = entry.expect("entrée").path();
        if path.file_name().is_some_and(|n| n == "capture-ios.json") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("capability");
        for needle in ["allow-speech-", "allow-app-settings-open"] {
            assert!(!text.contains(needle), "{} accorde {needle}", path.display());
        }
    }
}
