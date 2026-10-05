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
    // P-04 : la fenêtre est créée par `setup` APRÈS la récupération d'une restauration interrompue (desktop.rs::create_main_window), jamais par
    // Tauri avant `setup` : sinon la WebView pourrait ouvrir une base vide pendant la récupération ou la boîte d'erreur.
    expected["create"] = Value::Bool(false);
    assert_eq!(win, &expected);
    assert!(base.get("create").is_none(), "iOS garde la création automatique de la fenêtre");
}

/// `setup` récupère d'abord, puis crée la fenêtre principale, puis seulement le reste (zone de notification, capture rapide, affichage).
#[test]
fn setup_recovers_first_then_creates_the_main_window_before_anything_that_uses_it() {
    let setup = DESKTOP_SOURCE.split(".setup(|app| {").nth(1).expect("setup");
    let position = |needle: &str| setup.find(needle).unwrap_or_else(|| panic!("{needle} absent de setup"));
    let recover = position("recover_interrupted_restore");
    let create = position("create_main_window(app.handle())");
    assert!(recover < create, "récupération avant la création de la fenêtre");
    for later in ["crate::shortcut::manage", "crate::capture::setup", "create_tray(", "show_main_window("] {
        assert!(create < position(later), "{later} après la création de la fenêtre");
    }
    // Dossier de données introuvable ou fenêtre impossible à créer : même arrêt avec la boîte système, jamais une app sans interface.
    assert!(setup.contains("\"no-data-dir\"") && setup.contains("\"window-failed\""));
    assert!(!setup.contains("create_main_window(app.handle())?"), "l'échec de création ne doit pas contourner la boîte");
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

fn permissions_of(capability: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(capability).expect("capability valide");
    value["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .map(|p| p.as_str().map(str::to_owned).unwrap_or_else(|| p["identifier"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// H-03 critère 7 : l'export passe par deux commandes Rust ; la WebView n'a aucune permission de plugin dialog, fs ni opener pour écrire.
#[test]
fn export_capability_grants_only_the_two_export_commands_to_the_main_window_on_windows() {
    let capability: Value = serde_json::from_str(include_str!("../../capabilities/export.json")).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let mut names = permissions_of(include_str!("../../capabilities/export.json"));
    names.sort();
    assert_eq!(names, ["allow-export-save-file", "allow-reveal-exported-file"]);
}

/// Texte de toutes les capabilities du dossier, sauf `except` (aucune capability ne doit accorder les commandes d'une autre).
fn other_capabilities(except: &str) -> Vec<String> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    std::fs::read_dir(dir)
        .expect("dossier capabilities")
        .map(|e| e.expect("entrée").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && p.file_name().is_some_and(|n| n != except))
        .map(|p| std::fs::read_to_string(p).expect("capability"))
        .collect()
}

/// P-07 : l'import passe par une seule commande Rust ; fenêtre principale et Windows seulement, aucune permission de plugin.
#[test]
fn import_capability_grants_only_the_open_file_command_to_the_main_window_on_windows() {
    let text = include_str!("../../capabilities/import.json");
    let capability: Value = serde_json::from_str(text).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert_eq!(permissions_of(text), ["allow-import-open-file"]);
    for other in other_capabilities("import.json") {
        assert!(!permissions_of(&other).iter().any(|p| p.contains("import-open-file")));
    }
}

/// P-04 : sauvegarde et restauration par cinq commandes Rust, fenêtre principale et Windows seulement, aucune permission de plugin.
#[test]
fn backups_capability_grants_only_the_five_backup_commands_to_the_main_window_on_windows() {
    let text = include_str!("../../capabilities/backups.json");
    let capability: Value = serde_json::from_str(text).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    let mut names = permissions_of(text);
    names.sort();
    assert_eq!(names, ["allow-check-backup", "allow-daily-backup", "allow-list-backups", "allow-restore-backup", "allow-reveal-backups-folder"]);
    // Aucune autre capability n'accorde ces commandes (la restauration n'est jamais appelable depuis une fenêtre secondaire).
    for other in other_capabilities("backups.json") {
        assert!(!permissions_of(&other).iter().any(|p| p.contains("restore-backup") || p.contains("daily-backup") || p.contains("list-backups") || p.contains("check-backup") || p.contains("reveal-backups")));
    }
}

/// Les fenêtres secondaires (capture rapide, Focus) n'ont aucun accès aux fichiers, aux boîtes système ni à l'ouverture d'adresses.
#[test]
fn secondary_window_capabilities_have_no_fs_dialog_or_opener_permission() {
    for (name, text) in [("capture", include_str!("../../capabilities/capture.json")), ("focus", include_str!("../../capabilities/focus.json"))] {
        for permission in permissions_of(text) {
            assert!(!["fs:", "dialog:", "opener:"].iter().any(|prefix| permission.starts_with(prefix)), "{name} : {permission}");
        }
    }
}

/// Pas de plugin fs côté WebView : ni crate fs, ni enregistrement du plugin.
#[test]
fn no_fs_plugin_is_registered_for_the_webview() {
    assert!(!CARGO.contains("tauri-plugin-fs"));
    assert!(!DESKTOP_SOURCE.contains("tauri_plugin_fs"));
}

