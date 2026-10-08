//! CAP-IOS-01 (ADR 0015 §1) : Vision derrière `ocr_recognize` et `ocr_status`, joué avec un faux transport qui parle exactement le JSON du
//! contrat (`tests/fixtures/capture/vision-contract.json`) : entrées contrôlées avant tout appel du plugin (critère 3), confiance 0 à 100,
//! tri des lignes, codes d'erreur, une seule lecture à la fois, délais, aucune écriture de fichier dans le module.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use circletasks_lib::ocr::vision::{error_of_code, read_lines, recognize_with, status_with, VisionState, VisionTransport, PLUGIN_REJECT_CODES, VISION_LANGUAGES};
use circletasks_lib::ocr::{declared_dimensions, validate_for_vision, ImageKind, OcrError, MAX_LINES, VISION_MAX_SIDE};
use serde_json::{json, Value};

const CONTRACT: &str = include_str!("../../../tests/fixtures/capture/vision-contract.json");
const VISION_RS: &str = include_str!("../../src/ocr/vision.rs");
const OCR_MOD_RS: &str = include_str!("../../src/ocr/mod.rs");
const PRINTED: &[u8] = include_bytes!("../../../tests/fixtures/ocr/liste-imprimee.png");
const PHOTO: &[u8] = include_bytes!("../../../tests/fixtures/ocr/photo-liste.jpg");
const HANDWRITTEN: &[u8] = include_bytes!("../../../tests/fixtures/ocr/liste-manuscrite.png");

const LONG: Duration = Duration::from_secs(10);

fn contract() -> Value {
    serde_json::from_str(CONTRACT).expect("contrat valide")
}

/// Faux transport : refuse (panique) tout champ d'entrée absent du contrat et toute réponse qui n'a pas une forme du contrat.
struct FakeVision {
    status: Mutex<Result<Value, String>>,
    recognize: Mutex<Result<Value, String>>,
    delay: Mutex<Duration>,
    calls: AtomicUsize,
    last_args: Mutex<Option<Value>>,
}

impl FakeVision {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(Ok(json!({ "languages": ["fr-FR", "en-US"] }))),
            recognize: Mutex::new(Ok(json!({ "lines": [] }))),
            delay: Mutex::new(Duration::ZERO),
            calls: AtomicUsize::new(0),
            last_args: Mutex::new(None),
        })
    }

    fn lines(&self, lines: Value) {
        *self.recognize.lock().unwrap() = Ok(json!({ "lines": lines }));
    }

    fn reject(&self, code: &str) {
        *self.recognize.lock().unwrap() = Err(code.to_owned());
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().expect("objet").keys().cloned().collect()
}

fn contract_keys(list: &Value) -> BTreeSet<String> {
    list.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

impl VisionTransport for FakeVision {
    fn status(&self) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let response = self.status.lock().unwrap().clone();
        if let Ok(value) = &response {
            let shapes = contract()["commands"]["status"]["output"].as_array().unwrap().clone();
            assert!(shapes.iter().any(|shape| contract_keys(shape) == keys(value)), "forme de réponse hors contrat : {value}");
        }
        response
    }

    fn recognize(&self, args: Value) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(keys(&args), contract_keys(&contract()["commands"]["recognize"]["input"]), "champs d'entrée hors contrat");
        *self.last_args.lock().unwrap() = Some(args);
        let delay = *self.delay.lock().unwrap();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        let response = self.recognize.lock().unwrap().clone();
        if let Ok(value) = &response {
            let shapes = contract()["commands"]["recognize"]["output"].as_array().unwrap().clone();
            assert!(shapes.iter().any(|shape| contract_keys(shape) == keys(value)), "forme de réponse hors contrat : {value}");
            for line in value["lines"].as_array().unwrap() {
                assert_eq!(keys(line), contract_keys(&contract()["commands"]["recognize"]["line"]), "champs d'une ligne hors contrat");
            }
        }
        response
    }
}

fn transport(fake: &Arc<FakeVision>) -> Arc<dyn VisionTransport> {
    fake.clone()
}

/// PNG minimal valide pour l'en-tête : signature, bloc IHDR (dimensions déclarées), pas de données d'image (jamais décodé par Rust).
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

/// JPEG minimal : SOI, un segment APP0 (JFIF), un segment SOF `marker` aux dimensions données.
fn jpeg(marker: u8, width: u16, height: u16) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    bytes.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    bytes.extend_from_slice(&[0xFF, marker, 0x00, 0x11, 8]);
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    bytes
}

fn recognize(fake: &Arc<FakeVision>, state: &VisionState, bytes: &[u8]) -> Result<Vec<(String, Option<u8>)>, (&'static str, String)> {
    recognize_with(&transport(fake), state, bytes, LONG)
        .map(|result| result.lines.into_iter().map(|l| (l.text, l.confidence)).collect())
        .map_err(|e| (e.code, e.message))
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 2 : confiance
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_2_confidences_are_scaled_to_a_hundred_and_text_is_cleaned() {
    let fake = FakeVision::new();
    fake.lines(json!([
        { "text": "Appeler  le notaire", "confidence": 0.95, "x": 0.1, "y": 0.9 },
        { "text": "Acheter du pain", "confidence": 0.40, "x": 0.1, "y": 0.8 },
        { "text": "Payer\tla facture", "confidence": 0.80, "x": 0.1, "y": 0.7 },
    ]));
    let lines = recognize(&fake, &VisionState::default(), PRINTED).expect("lecture");
    assert_eq!(lines, [("Appeler le notaire".to_owned(), Some(95)), ("Acheter du pain".to_owned(), Some(40)), ("Payer la facture".to_owned(), Some(80))]);
}

#[test]
fn cap_ios_01_2_an_unusable_confidence_is_absent_not_zero() {
    let response = json!({ "lines": [
        { "text": "a", "confidence": f64::NAN, "x": 0.0, "y": 0.9 },
        { "text": "b", "confidence": 1.5, "x": 0.0, "y": 0.8 },
        { "text": "c", "confidence": -0.1, "x": 0.0, "y": 0.7 },
        { "text": "d", "confidence": 0.0, "x": 0.0, "y": 0.6 },
        { "text": "e", "confidence": 1.0, "x": 0.0, "y": 0.5 },
        { "text": "f", "x": 0.0, "y": 0.4 },
    ] });
    let lines: Vec<Option<u8>> = read_lines(&response).unwrap().into_iter().map(|l| l.confidence).collect();
    assert_eq!(lines, [None, None, None, Some(0), Some(100), None]);
}

#[test]
fn cap_ios_01_2_serialized_lines_omit_confidence_for_windows_and_status_omits_reason() {
    use circletasks_lib::ocr::{clean_lines, OcrStatus};
    // Windows : jamais de `confidence` ni de `reason` dans les réponses (additif, compatible avec le front existant).
    assert_eq!(serde_json::to_value(clean_lines(["Ligne"])).unwrap(), json!([{ "text": "Ligne" }]));
    let status = OcrStatus { available: true, languages: vec!["fr-FR".to_owned()], reason: None };
    assert_eq!(serde_json::to_value(status).unwrap(), json!({ "available": true, "languages": ["fr-FR"] }));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Ordre de lecture
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_lines_are_sorted_top_to_bottom_then_left_to_right() {
    let response = json!({ "lines": [
        { "text": "bas", "confidence": 0.9, "x": 0.1, "y": 0.20 },
        { "text": "milieu droite", "confidence": 0.9, "x": 0.60, "y": 0.504 },
        { "text": "haut", "confidence": 0.9, "x": 0.1, "y": 0.95 },
        { "text": "milieu gauche", "confidence": 0.9, "x": 0.05, "y": 0.502 },
    ] });
    let texts: Vec<String> = read_lines(&response).unwrap().into_iter().map(|l| l.text).collect();
    // Les deux lignes du milieu sont dans la même bande de 1 % : de gauche à droite.
    assert_eq!(texts, ["haut", "milieu gauche", "milieu droite", "bas"]);
}

#[test]
fn cap_ios_01_blank_lines_are_dropped_and_the_count_is_capped() {
    let many: Vec<Value> = (0..MAX_LINES + 50).map(|i| json!({ "text": format!("Ligne {i}"), "confidence": 0.9, "x": 0.0, "y": 1.0 - (i as f64) / 1000.0 })).collect();
    let mut with_blank = vec![json!({ "text": "   ", "confidence": 0.9, "x": 0.0, "y": 1.0 })];
    with_blank.extend(many);
    let lines = read_lines(&json!({ "lines": with_blank })).unwrap();
    assert_eq!(lines.len(), MAX_LINES);
    assert_eq!(lines[0].text, "Ligne 0");
    // Réponse sans tableau `lines` : échec, jamais une liste vide silencieuse.
    assert_eq!(read_lines(&json!({})), Err(OcrError::Engine("failed".to_owned())));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 3 : entrées contrôlées avant le plugin
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_3_invalid_inputs_are_rejected_before_the_plugin_is_called() {
    let fake = FakeVision::new();
    let state = VisionState::default();
    let mut huge = vec![0xFF, 0xD8, 0xFF];
    huge.resize(12 * 1024 * 1024 + 1, 0);
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("image vide", vec![], "ocr-empty-image"),
        ("type inconnu", b"just some text".to_vec(), "ocr-unsupported-format"),
        ("pdf", b"%PDF-1.7 ....".to_vec(), "ocr-unsupported-format"),
        ("bmp refusé sur iPhone", [b"BM".as_slice(), &[0u8; 40]].concat(), "ocr-unsupported-format"),
        ("trop lourde", huge, "ocr-too-large"),
        ("png tronqué", PRINTED[..20].to_vec(), "ocr-unsupported-format"),
        ("png sans dimension", png(0, 100), "ocr-unsupported-format"),
        ("jpeg sans segment de dimensions", vec![0xFF, 0xD8, 0xFF, 0xD9], "ocr-unsupported-format"),
        ("côté trop grand", png(VISION_MAX_SIDE + 1, 100), "ocr-dimensions-too-large"),
        ("côté trop grand (jpeg)", jpeg(0xC0, 5000, 100), "ocr-dimensions-too-large"),
        ("bombe de décompression", png(u32::MAX, u32::MAX), "ocr-dimensions-too-large"),
    ];
    for (name, bytes, code) in cases {
        let error = recognize(&fake, &state, &bytes).expect_err(name);
        assert_eq!(error.0, code, "{name}");
    }
    assert_eq!(fake.calls(), 0, "le plugin n'est jamais appelé pour une entrée invalide");
    assert!(!state.is_busy());
}

#[test]
fn cap_ios_01_3_valid_images_pass_the_checks() {
    assert_eq!(validate_for_vision(PRINTED), Ok(ImageKind::Png));
    assert_eq!(validate_for_vision(PHOTO), Ok(ImageKind::Jpeg));
    assert_eq!(validate_for_vision(HANDWRITTEN), Ok(ImageKind::Png));
    // À la limite exacte des côtés (4 096) et des pixels (16 Mpx).
    assert_eq!(validate_for_vision(&png(4096, 4096)), Ok(ImageKind::Png));
    assert_eq!(validate_for_vision(&png(4097, 10)), Err(OcrError::DimensionsTooLarge));
    assert_eq!(validate_for_vision(&jpeg(0xC2, 2000, 1500)), Ok(ImageKind::Jpeg));
}

#[test]
fn cap_ios_01_3_declared_dimensions_read_png_and_jpeg_headers_without_decoding() {
    assert_eq!(declared_dimensions(&png(1234, 567), ImageKind::Png), Some((1234, 567)));
    // SOF0 à SOF15 : tous lus, sauf DHT (C4), JPG (C8) et DAC (CC).
    for marker in (0xC0..=0xCFu8).filter(|m| !matches!(m, 0xC4 | 0xC8 | 0xCC)) {
        assert_eq!(declared_dimensions(&jpeg(marker, 640, 480), ImageKind::Jpeg), Some((640, 480)), "SOF {marker:#x}");
    }
    for marker in [0xC4u8, 0xC8, 0xCC] {
        assert_eq!(declared_dimensions(&jpeg(marker, 640, 480), ImageKind::Jpeg), None, "marqueur {marker:#x} n'est pas un SOF");
    }
    // Octets de bourrage 0xFF avant le marqueur, marqueurs sans longueur.
    let mut padded = vec![0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0x01];
    padded.extend_from_slice(&jpeg(0xC0, 321, 123)[2..]);
    assert_eq!(declared_dimensions(&padded, ImageKind::Jpeg), Some((321, 123)));
    // Tronqué, longueur nulle, début des données avant tout SOF.
    assert_eq!(declared_dimensions(&jpeg(0xC0, 10, 10)[..24], ImageKind::Jpeg), None);
    assert_eq!(declared_dimensions(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00, 0, 0], ImageKind::Jpeg), None);
    assert_eq!(declared_dimensions(&[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x00], ImageKind::Jpeg), None);
    assert_eq!(declared_dimensions(b"\x89PNG\r\n\x1a\n\0\0\0\r", ImageKind::Png), None);
    // Le parcours des segments est borné (jamais de boucle sur une suite de segments vides).
    let mut endless = vec![0xFF, 0xD8];
    for _ in 0..2000 {
        endless.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x02]);
    }
    assert_eq!(declared_dimensions(&endless, ImageKind::Jpeg), None);
    // Fixtures réelles : dimensions plausibles.
    for (bytes, kind) in [(PRINTED, ImageKind::Png), (PHOTO, ImageKind::Jpeg), (HANDWRITTEN, ImageKind::Png)] {
        let (w, h) = declared_dimensions(bytes, kind).expect("dimensions des fixtures");
        assert!(w > 100 && h > 100 && w <= VISION_MAX_SIDE && h <= VISION_MAX_SIDE, "{w}x{h}");
    }
}

#[test]
fn cap_ios_01_3_the_plugin_receives_the_image_in_base64_with_french_first() {
    let fake = FakeVision::new();
    fake.lines(json!([{ "text": "ok", "confidence": 0.9, "x": 0.0, "y": 0.5 }]));
    recognize(&fake, &VisionState::default(), PHOTO).expect("lecture");
    let args = fake.last_args.lock().unwrap().clone().expect("arguments");
    assert_eq!(STANDARD.decode(args["image"].as_str().unwrap()).unwrap(), PHOTO);
    assert_eq!(args["languages"], json!(["fr-FR", "en-US"]));
    assert_eq!(VISION_LANGUAGES, ["fr-FR", "en-US"]);
    assert_eq!(args["maxSide"], json!(4096));
    assert_eq!(args["maxLines"], json!(500));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Codes d'erreur
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_every_swift_code_maps_to_the_documented_rust_code() {
    let contract = contract();
    let swift_codes: BTreeSet<&str> = contract["rejectCodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(swift_codes, PLUGIN_REJECT_CODES.iter().copied().collect::<BTreeSet<_>>(), "codes de vision.rs = contrat");
    let mapping = contract["swiftToRust"].as_object().unwrap();
    assert_eq!(mapping.keys().map(String::as_str).collect::<BTreeSet<_>>(), swift_codes, "chaque code Swift a sa correspondance");
    for (swift, rust) in mapping {
        assert_eq!(error_of_code(swift).code(), rust.as_str().unwrap(), "{swift}");
    }
    // Plugin absent ou refusé, code inconnu ou texte système : codes visibles, jamais le texte.
    assert_eq!(error_of_code("unavailable").code(), "ocr-unavailable");
    assert_eq!(error_of_code("quelque-chose-d-inconnu").code(), "ocr-engine");
    let text = error_of_code("Erreur système : /private/var/mobile/Containers/x.jpg");
    assert_eq!(text.code(), "ocr-engine");
    assert_eq!(text, OcrError::Engine("failed".to_owned()), "un texte n'est jamais conservé");
}

#[test]
fn cap_ios_01_a_rejected_read_carries_the_code_and_never_text() {
    let fake = FakeVision::new();
    let state = VisionState::default();
    for (swift, rust) in [("language-missing", "ocr-language-missing"), ("dimensions", "ocr-dimensions-too-large"), ("timeout", "ocr-engine"), ("failed", "ocr-engine")] {
        fake.reject(swift);
        let error = recognize(&fake, &state, PRINTED).expect_err(swift);
        assert_eq!(error.0, rust);
        assert!(!error.1.contains('/') && !error.1.contains(' '), "le message est un code : {}", error.1);
    }
    assert!(!state.is_busy(), "le drapeau est rendu après chaque échec");
}

// ------------------------------------------------------------------------------------------------------------------------------
// État du moteur
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_status_reports_french_or_the_reason() {
    let fake = FakeVision::new();
    let ready = status_with(&transport(&fake), LONG);
    assert!(ready.available && ready.reason.is_none());
    assert_eq!(ready.languages, ["fr-FR", "en-US"]);

    *fake.status.lock().unwrap() = Ok(json!({ "languages": ["en-US", "de-DE"] }));
    let missing = status_with(&transport(&fake), LONG);
    assert!(!missing.available);
    assert_eq!(missing.reason, Some("language-missing"));

    *fake.status.lock().unwrap() = Ok(json!({ "languages": ["fr"] }));
    assert!(status_with(&transport(&fake), LONG).available, "une variante `fr` suffit");

    // Plugin absent, refusé ou muet (réponse sans langues) : indisponible avec la raison, jamais une erreur.
    for failure in [Err("unavailable".to_owned()), Err("failed".to_owned()), Ok(json!({ "languages": "fr-FR" }))] {
        *fake.status.lock().unwrap() = failure;
        let state = status_with(&transport(&fake), LONG);
        assert!(!state.available && state.languages.is_empty());
        assert_eq!(state.reason, Some("plugin-unavailable"));
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Une lecture à la fois, délais
// ------------------------------------------------------------------------------------------------------------------------------

fn wait_until(condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(10), "condition jamais remplie");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn cap_ios_01_only_one_read_at_a_time() {
    let fake = FakeVision::new();
    fake.lines(json!([{ "text": "ok", "confidence": 0.9, "x": 0.0, "y": 0.5 }]));
    *fake.delay.lock().unwrap() = Duration::from_millis(400);
    let state = VisionState::default();
    let first = {
        let (fake, state) = (fake.clone(), state.clone());
        std::thread::spawn(move || recognize(&fake, &state, PRINTED))
    };
    wait_until(|| state.is_busy());
    let second = recognize(&fake, &state, PRINTED).expect_err("seconde lecture");
    assert_eq!(second.0, "ocr-engine");
    assert!(second.1.contains("busy"), "{}", second.1);
    assert!(first.join().unwrap().is_ok());
    assert!(!state.is_busy());
    assert_eq!(fake.calls(), 1, "la seconde lecture n'atteint jamais le plugin");
}

#[test]
fn cap_ios_01_a_silent_plugin_cannot_freeze_the_caller_and_the_flag_follows_the_real_end() {
    let fake = FakeVision::new();
    fake.lines(json!([]));
    *fake.delay.lock().unwrap() = Duration::from_millis(600);
    let state = VisionState::default();
    let start = Instant::now();
    let result = recognize_with(&transport(&fake), &state, PRINTED, Duration::from_millis(50));
    assert!(start.elapsed() < Duration::from_millis(500), "l'appelant n'attend que le délai");
    assert_eq!(result.expect_err("délai").code, "ocr-unavailable");
    // Swift n'a pas fini : une nouvelle lecture est refusée `busy` (visible), puis le drapeau est rendu à la vraie fin.
    assert!(state.is_busy());
    assert_eq!(recognize(&fake, &state, PRINTED).expect_err("busy").0, "ocr-engine");
    wait_until(|| !state.is_busy());
    assert!(recognize(&fake, &state, PRINTED).is_ok());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 5 (partie Rust) : aucune écriture, aucun réseau
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_5_the_ocr_modules_write_no_file_and_open_no_connection() {
    for (name, source) in [("vision.rs", VISION_RS), ("mod.rs", OCR_MOD_RS)] {
        let code: String = source.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for forbidden in ["std::fs", "fs::", "File::", "tempfile", "OpenOptions", "std::net", "TcpStream", "reqwest", "UdpSocket", "write_all"] {
            assert!(!code.contains(forbidden), "{name} : `{forbidden}` interdit (l'image reste en mémoire)");
        }
    }
}
