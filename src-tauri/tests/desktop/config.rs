//! Garde-fous sur la configuration livrée (tauri.conf.json, capabilities) : D-01 à D-03.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

const CONF: &str = include_str!("../../tauri.conf.json");
const DESKTOP_CAPABILITY: &str = include_str!("../../capabilities/desktop.json");
const WINDOWS_CONF: &str = include_str!("../../tauri.windows.conf.json");
const DEFAULT_CAPABILITY: &str = include_str!("../../capabilities/default.json");

/// Ancien placeholder de `plugins.updater.pubkey` : ne doit plus jamais réapparaître.
const PUBKEY_PLACEHOLDER: &str = "A_REMPLACER_PAR_LA_CLE_PUBLIQUE_DE_tauri_signer_generate";

fn conf() -> Value {
    serde_json::from_str(CONF).expect("tauri.conf.json valide")
}

fn updater() -> Value {
    conf()["plugins"]["updater"].clone()
}

#[test]
fn updater_endpoint_is_the_public_releases_repository_over_https() {
    let endpoints = updater()["endpoints"].clone();
    let endpoints = endpoints.as_array().expect("endpoints");
    assert_eq!(endpoints.len(), 1);
    let url = endpoints[0].as_str().expect("URL");
    assert!(url.starts_with("https://github.com/"), "{url}");
    assert!(url.contains("/circletasks-releases/releases/latest/download/"), "{url}");
    assert!(url.ends_with("/latest.json"), "{url}");
}

#[test]
fn no_private_key_material_in_configuration() {
    for text in [CONF, DESKTOP_CAPABILITY, DEFAULT_CAPABILITY] {
        let lower = text.to_lowercase();
        assert!(!lower.contains("secret key") && !lower.contains("private"), "matériel de clé privée");
    }
}

#[test]
fn downgrade_protection_is_on() {
    assert_eq!(updater()["requireSignedVersion"], Value::Bool(true));
    assert_ne!(updater()["allowDowngrades"], Value::Bool(true));
    assert_ne!(updater()["dangerousInsecureTransportProtocol"], Value::Bool(true));
}

#[test]
fn main_window_starts_hidden_on_windows_only() {
    // Fusion JSON Merge Patch de Tauri : le tableau des fenêtres est remplacé en entier.
    let windows: Value = serde_json::from_str(WINDOWS_CONF).expect("tauri.windows.conf.json valide");
    let win = &windows["app"]["windows"][0];
    assert_eq!(win["visible"], Value::Bool(false), "démarrage réduit sans flash (Windows)");
    assert_eq!(win["label"], Value::String(circletasks_lib::desktop::MAIN_WINDOW.into()));
    // Même fenêtre que la base, hors visibilité : iOS garde la fenêtre visible par défaut.
    let base = &conf()["app"]["windows"][0];
    assert!(base.get("visible").is_none(), "visible:false ne doit pas toucher iOS");
    let mut expected = base.clone();
    expected["visible"] = Value::Bool(false);
    assert_eq!(win, &expected);
}

#[test]
fn desktop_capability_is_scoped_to_windows_and_the_main_window() {
    let capability: Value = serde_json::from_str(DESKTOP_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let permissions = capability["permissions"].as_array().expect("permissions");
    // Permissions minimales : pas de joker, pas de permission « default » de plugin.
    for permission in permissions {
        let id = permission.as_str().or_else(|| permission["identifier"].as_str()).expect("identifiant");
        assert!(!id.ends_with(":default") && !id.contains('*'), "{id}");
    }
}

#[test]
fn opener_scope_is_limited_to_the_releases_repository() {
    let capability: Value = serde_json::from_str(DESKTOP_CAPABILITY).expect("capability valide");
    let permissions = capability["permissions"].as_array().expect("permissions");
    let opener = permissions
        .iter()
        .find(|p| p["identifier"] == "opener:allow-open-url")
        .expect("permission opener");
    let scope = opener["allow"][0]["url"].as_str().expect("URL");
    let endpoint = updater()["endpoints"][0].as_str().expect("endpoint").to_owned();
    let repo = endpoint.split("/releases/").next().expect("dépôt");
    assert_eq!(scope, format!("{repo}/releases/*"));
}

#[test]
fn bundle_metadata_is_filled() {
    let bundle = &conf()["bundle"];
    for key in ["publisher", "copyright", "shortDescription", "longDescription"] {
        assert!(bundle[key].as_str().is_some_and(|s| !s.is_empty()), "bundle.{key}");
    }
}

const DESKTOP_SOURCE: &str = include_str!("../../src/desktop.rs");
const CARGO: &str = include_str!("../../Cargo.toml");

/// D-03 critère 10 : la clé publique réelle est posée (plus de placeholder) et décodable.
#[test]
fn d03_10_real_public_key_is_in_place_and_well_formed() {
    let binding = updater()["pubkey"].clone();
    let pubkey = binding.as_str().expect("pubkey");
    assert_ne!(pubkey, PUBKEY_PLACEHOLDER, "placeholder encore présent");
    let decoded = String::from_utf8(STANDARD.decode(pubkey).expect("base64")).expect("UTF-8");
    let mut lines = decoded.lines();
    assert!(lines.next().is_some_and(|l| l.starts_with("untrusted comment:")));
    let key = STANDARD.decode(lines.next().expect("ligne de clé")).expect("base64 de la clé");
    // Ed (2 octets) + identifiant (8) + clé Ed25519 (32).
    assert_eq!(key.len(), 42);
    assert_eq!(&key[..2], b"Ed");
}

/// D-01 critère 9 : info-bulle « CircleTasks », aucune notification émise par le PC.
#[test]
fn d01_9_tooltip_and_no_notification_plugin() {
    assert_eq!(circletasks_lib::desktop::TRAY_TOOLTIP, "CircleTasks");
    assert!(!CARGO.contains("tauri-plugin-notification"));
    assert!(!DESKTOP_SOURCE.contains("tauri_plugin_notification") && !DESKTOP_SOURCE.contains("NotificationExt"));
}

/// D-02 critère 2 : l'entrée de démarrage porte l'argument de démarrage réduit.
#[test]
fn d02_2_autostart_uses_minimized_argument() {
    assert_eq!(circletasks_lib::desktop::MINIMIZED_ARG, "--minimized");
    assert!(DESKTOP_SOURCE.contains("tauri_plugin_autostart::init"));
    assert!(DESKTOP_SOURCE.contains("Some(vec![MINIMIZED_ARG])"));
}
