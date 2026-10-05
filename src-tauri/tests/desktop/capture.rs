//! Mini-fenêtre de capture rapide (Q-01) : bascule, placement, bornes, capability minimale.

use circletasks_lib::capture::{
    is_valid_submit, SubmitRequest, CONTEXT_REQUEST_EVENT, SUBMIT_EVENT,
    centered_origin, clamp_height, quick_add_route, QuickAddRoute, physical_size, toggle_action, ToggleAction, CAPTURE_PAGE, CAPTURE_WINDOW, DEFAULT_HEIGHT, MAX_HEIGHT, WINDOW_WIDTH,
};
use serde_json::Value;

const CAPTURE_CAPABILITY: &str = include_str!("../../capabilities/capture.json");
const OCR_CAPABILITY: &str = include_str!("../../capabilities/ocr.json");
const CONF: &str = include_str!("../../tauri.conf.json");
const FRONT_EVENTS: &str = include_str!("../../../src/platform/capture/events.ts");

#[test]
fn toggle_opens_when_hidden_closes_when_active_and_refocuses_when_in_background() {
    assert_eq!(toggle_action(false, false), ToggleAction::Show);
    assert_eq!(toggle_action(false, true), ToggleAction::Show);
    assert_eq!(toggle_action(true, true), ToggleAction::Hide);
    // Saisie en cours dans une fenêtre restée ouverte : on la ramène devant, on ne la ferme pas (aucune saisie perdue).
    assert_eq!(toggle_action(true, false), ToggleAction::Focus);
}

#[test]
fn window_is_520_by_160_and_height_is_bounded() {
    assert_eq!((WINDOW_WIDTH, DEFAULT_HEIGHT), (520.0, 160.0));
    assert_eq!(clamp_height(10.0), DEFAULT_HEIGHT);
    assert_eq!(clamp_height(300.0), 300.0);
    assert_eq!(clamp_height(5_000.0), MAX_HEIGHT);
    assert_eq!(clamp_height(f64::NAN), DEFAULT_HEIGHT);
}

#[test]
fn window_is_centered_on_the_active_monitor() {
    // Écran principal 1920 x 1080, échelle 1 : 520 x 160 centré.
    assert_eq!(centered_origin((0, 0), (1920, 1080), (520, 160)), (700, 460));
    // Second écran à droite, 2560 x 1440 à 150 % : la taille physique suit l'échelle.
    let size = physical_size((520.0, 160.0), 1.5);
    assert_eq!(size, (780, 240));
    assert_eq!(centered_origin((1920, 0), (2560, 1440), size), (1920 + 890, 600));
    // Écran placé à gauche du principal (coordonnées négatives).
    assert_eq!(centered_origin((-1280, -200), (1280, 1024), (520, 160)), (-1280 + 380, -200 + 432));
}

#[test]
fn window_larger_than_the_screen_never_overflows_the_arithmetic() {
    assert_eq!(centered_origin((0, 0), (400, 100), (520, 160)), (-60, -30));
}

#[test]
fn capture_capability_is_minimal() {
    let capability: Value = serde_json::from_str(CAPTURE_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!([CAPTURE_WINDOW]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let permissions: Vec<&str> = capability["permissions"].as_array().expect("permissions").iter().filter_map(Value::as_str).collect();
    for forbidden in ["sql", "fs:", "http", "opener", "shell", "core:default", "core:window", "autostart", "updater", "process"] {
        assert!(!permissions.iter().any(|p| p.contains(forbidden)), "permission interdite : {forbidden}");
    }
    // Aucun événement libre : la mini-fenêtre ne peut pas imiter desktop://quitting. Son seul canal sortant : deux commandes qui visent la fenêtre principale.
    assert!(!permissions.iter().any(|p| p.contains("emit")), "émission d'événement libre interdite");
    assert!(permissions.contains(&"allow-submit-quick-capture") && permissions.contains(&"allow-request-capture-context"));
    assert!(permissions.contains(&"allow-hide-quick-capture") && permissions.contains(&"allow-resize-quick-capture"));
}

#[test]
fn ocr_capability_is_limited_to_the_main_window_and_two_commands() {
    let capability: Value = serde_json::from_str(OCR_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert_eq!(capability["permissions"], serde_json::json!(["allow-ocr-status", "allow-ocr-recognize"]));
}

#[test]
fn only_the_main_window_is_declared_in_the_configuration() {
    // La mini-fenêtre est créée par le code (capture::setup) : une déclaration statique la montrerait au démarrage.
    let conf: Value = serde_json::from_str(CONF).expect("tauri.conf.json valide");
    let windows = conf["app"]["windows"].as_array().expect("fenêtres");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], "main");
}

#[test]
fn capture_page_and_events_match_the_front() {
    assert_eq!(CAPTURE_PAGE, "capture.html");
    for needle in [circletasks_lib::capture::SHOWN_EVENT, circletasks_lib::capture::BLURRED_EVENT, CAPTURE_WINDOW] {
        assert!(FRONT_EVENTS.contains(&format!("'{needle}'")), "{needle} absent de src/platform/capture/events.ts");
    }
}

#[test]
fn csp_allows_the_local_ocr_fallback_without_opening_the_network() {
    let conf: Value = serde_json::from_str(CONF).expect("tauri.conf.json valide");
    let csp = &conf["app"]["security"]["csp"];
    let script = csp["script-src"].as_str().expect("script-src");
    assert!(script.contains("'wasm-unsafe-eval'"), "le repli tesseract.js compile du WebAssembly");
    assert!(!script.contains("'unsafe-eval'") && !script.contains("http"), "{script}");
    let connect = csp["connect-src"].as_str().expect("connect-src");
    assert!(!connect.contains("https:") && !connect.contains("*"), "{connect}");
}

fn request(text: &str) -> SubmitRequest {
    SubmitRequest { request_id: "capture-1".into(), text: text.into(), ignored: vec!["date:demain".into()] }
}

#[test]
fn submit_is_bounded() {
    assert!(is_valid_submit(&request("Appeler le notaire demain 10h #pro")));
    assert!(is_valid_submit(&request(&"x".repeat(2_000))));
    assert!(!is_valid_submit(&request(&"x".repeat(2_001))));
    assert!(!is_valid_submit(&SubmitRequest { request_id: String::new(), ..request("a") }));
    assert!(!is_valid_submit(&SubmitRequest { request_id: "i".repeat(65), ..request("a") }));
    assert!(!is_valid_submit(&SubmitRequest { ignored: vec!["k".into(); 51], ..request("a") }));
    assert!(!is_valid_submit(&SubmitRequest { ignored: vec!["k".repeat(201)], ..request("a") }));
}

#[test]
fn submit_events_match_the_front_and_the_request_shape_is_camel_case() {
    for event in [SUBMIT_EVENT, CONTEXT_REQUEST_EVENT] {
        assert!(FRONT_EVENTS.contains(&format!("'{event}'")), "{event}");
    }
    let json = serde_json::to_value(request("a")).expect("json");
    assert_eq!(json["requestId"], "capture-1");
    assert!(json.get("request_id").is_none());
}

#[test]
fn tray_quick_add_opens_the_mini_window_with_today_field_as_fallback() {
    // Q-01 critère 10 : « Ajout rapide » (menu de la zone de notification) passe par capture::trigger, comme la combinaison globale.
    assert_eq!(quick_add_route(true), QuickAddRoute::MiniWindow);
    // Mini-fenêtre non créée : repli D-01 (Aujourd'hui, champ focalisé).
    assert_eq!(quick_add_route(false), QuickAddRoute::TodayField);
    let desktop = include_str!("../../src/desktop.rs");
    assert!(desktop.contains("TrayAction::QuickAdd => crate::capture::trigger(app)"), "le menu doit ouvrir la mini-fenêtre");
}

#[test]
fn desktop_capability_lets_the_main_window_read_the_setup_error() {
    let capability: Value = serde_json::from_str(include_str!("../../capabilities/desktop.json")).expect("capability valide");
    assert!(capability["permissions"].as_array().expect("permissions").iter().any(|p| p == "allow-capture-setup-error"));
}
