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


// ------------------------------------------------------------------------------------------------------------------------------
// Synchronisation (ADR 0011 section 11.1, test « config.rs » du lot Y1) et correctif F-01
// ------------------------------------------------------------------------------------------------------------------------------

const LIB_SOURCE: &str = include_str!("../../src/lib.rs");
const BUILD_SOURCE: &str = include_str!("../../build.rs");
const SYNC_CAPABILITY: &str = include_str!("../../capabilities/sync.json");
const SYNC_PAIRING_CAPABILITY: &str = include_str!("../../capabilities/sync-pairing.json");
const FOCUS_LAUNCHER_CAPABILITY: &str = include_str!("../../capabilities/focus-launcher.json");

/// Les 21 commandes `sync_*`, dans l'ordre de la section 11.1 (même liste que `SYNC_COMMANDS` de `types.ts`).
const SYNC_COMMANDS: [&str; 21] = [
    "sync_folder_info",
    "sync_folder_choose",
    "sync_folder_forget",
    "sync_bind_device",
    "sync_key_status",
    "sync_key_create",
    "sync_pairing_open",
    "sync_pairing_payload",
    "sync_key_import",
    "sync_pairing_close",
    "sync_scan",
    "sync_read_journal",
    "sync_append_journal",
    "sync_write_state",
    "sync_snapshot_begin",
    "sync_snapshot_append",
    "sync_snapshot_commit",
    "sync_read_snapshot",
    "sync_delete_own",
    "sync_restore_marker_get",
    "sync_restore_marker_clear",
];
const PAIRING_ONLY: [&str; 3] = ["sync_pairing_payload", "sync_key_import", "sync_pairing_close"];

fn permission_of(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

/// Noms des commandes de tous les `tauri::generate_handler![…]` de lib.rs (dernier segment de chemin).
fn handler_commands() -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for block in LIB_SOURCE.split("generate_handler![").skip(1) {
        let body = &block[..block.find(']').expect("fin de generate_handler!")];
        let body: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join(" ");
        for item in body.split(',') {
            let item = item.trim();
            if !item.is_empty() {
                out.insert(item.rsplit("::").next().unwrap().trim().to_owned());
            }
        }
    }
    out
}

/// Commandes déclarées dans `AppManifest::commands` de build.rs.
fn manifest_commands() -> std::collections::BTreeSet<String> {
    let start = BUILD_SOURCE.find(".commands(&[").expect("manifeste");
    let body = &BUILD_SOURCE[start..start + BUILD_SOURCE[start..].find("])").expect("fin du manifeste")];
    body.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .flat_map(|l| l.split('"').skip(1).step_by(2).map(str::to_owned).collect::<Vec<_>>())
        .collect()
}

/// (1) `generate_handler!` = `AppManifest::commands`.
#[test]
fn sync_1_handlers_equal_the_build_manifest() {
    let handlers = handler_commands();
    let manifest = manifest_commands();
    assert_eq!(handlers, manifest);
    for command in SYNC_COMMANDS.iter().chain(["focus_window_open", "focus_window_bring_to_front", "focus_window_close"].iter()) {
        assert!(manifest.contains(*command), "{command}");
    }
    assert_eq!(manifest.iter().filter(|c| c.starts_with("sync_")).count(), 21);
}

/// (2) `sync.json` : exactement les 18 permissions de `main`, Windows, sans les trois commandes de `pairing`.
#[test]
fn sync_2_main_capability_grants_exactly_eighteen_commands() {
    let capability: Value = serde_json::from_str(SYNC_CAPABILITY).expect("sync.json valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert!(capability.get("webviews").is_none());
    let mut granted = permissions_of(SYNC_CAPABILITY);
    granted.sort();
    let mut expected: Vec<String> = SYNC_COMMANDS.iter().filter(|c| !PAIRING_ONLY.contains(c)).map(|c| permission_of(c)).collect();
    expected.sort();
    assert_eq!(granted.len(), 18);
    assert_eq!(granted, expected);
}

/// (3) `sync-pairing.json` : exactement ces trois commandes, fenêtre `pairing`, sans `webviews`, aucune permission `core:`.
#[test]
fn sync_3_pairing_capability_grants_exactly_three_commands_and_no_core_permission() {
    let capability: Value = serde_json::from_str(SYNC_PAIRING_CAPABILITY).expect("sync-pairing.json valide");
    assert_eq!(capability["windows"], serde_json::json!(["pairing"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert!(capability.get("webviews").is_none());
    let granted = permissions_of(SYNC_PAIRING_CAPABILITY);
    assert_eq!(granted, PAIRING_ONLY.iter().map(|c| permission_of(c)).collect::<Vec<_>>());
    let core: Vec<&String> = granted.iter().filter(|p| p.starts_with("core:")).collect();
    assert!(core.is_empty(), "liste vide figée : {core:?}");
}

/// (4) aucune autre capability n'accorde une permission `sync-*`.
#[test]
fn sync_4_no_other_capability_grants_sync_permissions() {
    for (name, text) in all_capabilities() {
        if name == "sync.json" || name == "sync-pairing.json" {
            continue;
        }
        assert!(!permissions_of(&text).iter().any(|p| p.contains("sync-")), "{name}");
    }
}

fn all_capabilities() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut out: Vec<(String, String)> = std::fs::read_dir(dir)
        .expect("dossier capabilities")
        .map(|e| e.expect("entrée").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&p).expect("capability")))
        .collect();
    out.sort();
    out
}

/// Motif de fenêtre de Tauri (`*` joker, `?` un caractère) appliqué à un libellé.
fn glob_matches(pattern: &str, label: &str) -> bool {
    fn go(p: &[u8], l: &[u8]) -> bool {
        match (p.first(), l.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], l) || (!l.is_empty() && go(p, &l[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &l[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &l[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), label.as_bytes())
}

/// Développe une permission composée (`core:default`, `*:default`, ensembles) à partir des manifestes ACL générés.
fn expand(id: &str, manifests: &Value, out: &mut std::collections::BTreeSet<String>) {
    let Some((plugin, name)) = id.rsplit_once(':') else {
        out.insert(id.to_owned());
        return;
    };
    let manifest = &manifests[plugin];
    let list = if name == "default" { &manifest["default_permission"]["permissions"] } else { &manifest["permission_sets"][name]["permissions"] };
    match list.as_array() {
        Some(children) => {
            for child in children.iter().filter_map(Value::as_str) {
                let full = if child.contains(':') { child.to_owned() } else { format!("{plugin}:{child}") };
                expand(&full, manifests, out);
            }
        }
        None => {
            out.insert(id.to_owned());
        }
    }
}

/// (5) aucune capability qui s'applique à `main` (y compris par joker ou `webviews`, ensembles `default` développés) n'accorde la
/// création de fenêtre ou de webview.
#[test]
fn sync_5_no_capability_applying_to_main_grants_window_creation() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen").join("schemas").join("acl-manifests.json");
    let manifests: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("acl-manifests.json (généré par la compilation)")).expect("manifestes");
    assert!(manifests["core:webview"]["permissions"].get("allow-create-webview-window").is_some(), "manifestes complets");
    let forbidden = ["core:webview:allow-create-webview-window", "core:webview:allow-create-webview", "core:window:allow-create"];
    let mut applying = 0;
    for (name, text) in all_capabilities() {
        let capability: Value = serde_json::from_str(&text).expect("capability valide");
        let targets = |key: &str| capability[key].as_array().is_some_and(|a| a.iter().filter_map(Value::as_str).any(|w| glob_matches(w, "main")));
        if !targets("windows") && !targets("webviews") {
            continue;
        }
        applying += 1;
        let mut granted = std::collections::BTreeSet::new();
        for id in permissions_of(&text) {
            expand(&id, &manifests, &mut granted);
        }
        for permission in forbidden {
            assert!(!granted.contains(permission), "{name} accorde {permission} à main");
        }
    }
    assert!(applying >= 5, "les capabilities de main ont bien été trouvées");
    // Le développement des ensembles fonctionne : core:default contient bien core:window:allow-get-all-windows.
    let mut core = std::collections::BTreeSet::new();
    expand("core:default", &manifests, &mut core);
    assert!(core.contains("core:window:allow-get-all-windows"));
    assert!(glob_matches("*", "main") && glob_matches("ma?n", "main") && !glob_matches("pairing", "main"));
}

/// (6) `focus-launcher.json` n'accorde que les trois commandes de la mini-fenêtre Focus.
#[test]
fn sync_6_focus_launcher_grants_only_the_three_focus_commands() {
    let capability: Value = serde_json::from_str(FOCUS_LAUNCHER_CAPABILITY).expect("focus-launcher.json valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    let mut granted = permissions_of(FOCUS_LAUNCHER_CAPABILITY);
    granted.sort();
    assert_eq!(granted, ["allow-focus-window-bring-to-front", "allow-focus-window-close", "allow-focus-window-open"]);
}
