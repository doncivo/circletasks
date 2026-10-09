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
    let recover = position("recover_and_settle");
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
    // N-01 (ADR 0012 avenant lot N1) : le plugin existe, mais sous cfg(target_os = "ios") seulement ; le PC n'envoie aucune notification.
    assert_notification_plugin_is_ios_only();
    assert!(!DESKTOP_SOURCE.contains("tauri_plugin_notification") && !DESKTOP_SOURCE.contains("NotificationExt"));
}

const IOS_NOTIFICATIONS_CAPABILITY: &str = include_str!("../../capabilities/notifications-ios.json");

/// Chaque déclaration du plugin dans Cargo.toml est épinglée (=2.5.1) et sous la section des dépendances iOS.
fn assert_notification_plugin_is_ios_only() {
    let mut section = String::new();
    let mut found = 0;
    let mut actions = 0;
    for line in CARGO.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_owned();
        }
        if trimmed.starts_with("tauri-plugin-notification-actions") {
            // N-03 : plugin Swift local, iPhone seulement lui aussi (chemin local, aucune version à épingler).
            actions += 1;
            assert_eq!(section, "[target.'cfg(target_os = \"ios\")'.dependencies]", "plugin d'actions hors de la section iOS");
            assert!(trimmed.contains("path = \"plugins/notification-actions\""), "{trimmed}");
        } else if trimmed.starts_with("tauri-plugin-notification") {
            found += 1;
            assert_eq!(section, "[target.'cfg(target_os = \"ios\")'.dependencies]", "plugin hors de la section iOS");
            assert!(trimmed.contains("\"=2.5.1\""), "version non épinglée : {trimmed}");
        }
    }
    assert_eq!(found, 1, "une seule déclaration du plugin");
    assert_eq!(actions, 1, "une seule déclaration du plugin d'actions");
}

/// N-01 (N1.1) : le plugin n'est enregistré dans lib.rs que sous cfg(target_os = "ios"), jamais sous desktop.
#[test]
fn n01_notification_plugin_is_registered_for_ios_only() {
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("tauri_plugin_notification::")).map(|(i, _)| i).collect();
    assert_eq!(uses.len(), 1, "un seul enregistrement");
    assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(target_os = \"ios\")]");
    assert!(!lines.iter().any(|l| l.contains("NotificationExt")));
}

/// N-03 (N3.1) : le plugin d'actions est enregistré sous cfg(target_os = "ios") seulement, APRÈS le plugin officiel (il prend sa place comme délégué).
#[test]
fn n03_actions_plugin_is_registered_for_ios_only_after_the_official_plugin() {
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("tauri_plugin_notification_actions::")).map(|(i, _)| i).collect();
    assert_eq!(uses.len(), 1, "un seul enregistrement");
    assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(target_os = \"ios\")]");
    let official = lines.iter().position(|l| l.contains("tauri_plugin_notification::init")).expect("plugin officiel");
    assert!(official < uses[0], "le plugin d'actions doit venir après le plugin officiel");
    assert!(!DESKTOP_SOURCE.contains("notification_actions"));
}

/// N-01 (N1.1) : liste EXACTE des permissions de la capability iOS ; fenêtre principale, iOS seulement ; aucune autre capability n'accorde notification:.
#[test]
fn n01_ios_notifications_capability_grants_exactly_the_listed_permissions() {
    let capability: Value = serde_json::from_str(IOS_NOTIFICATIONS_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]));
    let mut names = permissions_of(IOS_NOTIFICATIONS_CAPABILITY);
    names.sort();
    assert_eq!(
        names,
        [
            // N-03 : actions, catégories et écoute par le plugin maison (un seul délégué ; le plugin officiel n'enregistre plus de catégories).
            "notification-actions:allow-ack",
            "notification-actions:allow-drain",
            "notification-actions:allow-register-action-types",
            "notification-actions:allow-register-listener",
            "notification-actions:allow-remove-listener",
            "notification-actions:allow-status",
            "notification:allow-cancel",
            "notification:allow-get-pending",
            "notification:allow-is-permission-granted",
            "notification:allow-request-permission",
            "notification:allow-show",
        ]
    );
    // Le plugin officiel ne touche plus aux catégories ni aux écouteurs : un second jeu de catégories remplacerait celui du plugin maison.
    for retired in ["notification:allow-register-action-types", "notification:allow-register-listener", "notification:allow-remove-listener"] {
        assert!(!names.iter().any(|name| name == retired), "{retired}");
    }
    for forbidden in ["allow-notify", "allow-batch", "allow-get-active", "allow-remove-active", "allow-check-permissions", "allow-permission-state", ":default"] {
        assert!(!names.iter().any(|name| name.contains(forbidden)), "{forbidden}");
    }
    for other in other_capabilities("notifications-ios.json") {
        assert!(!other.contains("notification:"), "une autre capability accorde notification:");
        assert!(!other.contains("notification-actions:"), "une autre capability accorde notification-actions:");
    }
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
    assert_eq!(names, ["allow-backup-restore-marker-write", "allow-check-backup", "allow-daily-backup", "allow-list-backups", "allow-restore-backup", "allow-reveal-backups-folder"]);
    // Aucune autre capability n'accorde ces commandes (la restauration n'est jamais appelable depuis une fenêtre secondaire).
    for other in other_capabilities("backups.json") {
        // P-04-iOS : la capability de l'iPhone porte quatre de ces commandes (liste exacte vérifiée plus bas).
        if other.contains("\"identifier\": \"backups-ios\"") {
            continue;
        }
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

/// Les 25 commandes `sync_*`, dans l'ordre de la section 11.1 (même liste que `SYNC_COMMANDS` de `types.ts`) ; les trois dernières
/// sont celles du lot Y4 (section 18).
const SYNC_COMMANDS: [&str; 25] = [
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
    "sync_abandon_orphan_epoch",
    "sync_restore_marker_get",
    "sync_restore_marker_clear",
    "sync_device_forget",
    "sync_forgotten_delete",
    "sync_reset_key",
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

/// (1) Union des `generate_handler!` (PC et iPhone) = `AppManifest::commands` (ADR 0011 §22 point 7).
#[test]
fn sync_1_handlers_equal_the_build_manifest() {
    let handlers = handler_commands();
    let manifest = manifest_commands();
    assert_eq!(handlers, manifest);
    for command in SYNC_COMMANDS.iter().chain(["focus_window_open", "focus_window_bring_to_front", "focus_window_close"].iter()) {
        assert!(manifest.contains(*command), "{command}");
    }
    assert_eq!(manifest.iter().filter(|c| c.starts_with("sync_")).count(), 25);
}

/// (2) `sync.json` : exactement les 22 permissions de `main` (18, les trois du lot Y4 et `sync_abandon_orphan_epoch`), Windows, sans les trois commandes de `pairing`.
#[test]
fn sync_2_main_capability_grants_exactly_twenty_one_commands() {
    let capability: Value = serde_json::from_str(SYNC_CAPABILITY).expect("sync.json valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert!(capability.get("webviews").is_none());
    let mut granted = permissions_of(SYNC_CAPABILITY);
    granted.sort();
    let mut expected: Vec<String> = SYNC_COMMANDS.iter().filter(|c| !PAIRING_ONLY.contains(c)).map(|c| permission_of(c)).collect();
    expected.sort();
    assert_eq!(granted.len(), 22);
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
        if name == "sync.json" || name == "sync-pairing.json" || name == "sync-ios.json" {
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

/// (5) aucune capability (audit S6 : toutes, et pas seulement celles qui visent `main` par joker ou `webviews` ; ensembles `default` développés) n'accorde la
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
        // Audit S6 : la création de fenêtre ou de webview est interdite à TOUTES les capabilities (Focus, capture, pairing comprises),
        // pas seulement à celles qui visent `main` ; seules les commandes Rust créent des fenêtres.
        if targets("windows") || targets("webviews") {
            applying += 1;
        }
        let mut granted = std::collections::BTreeSet::new();
        for id in permissions_of(&text) {
            expand(&id, &manifests, &mut granted);
        }
        for permission in forbidden {
            assert!(!granted.contains(permission), "{name} accorde {permission}");
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

// ------------------------------------------------------------------------------------------------------------------------------
// iPhone (ADR 0011 §22 point 7, Y-IOS-01)
// ------------------------------------------------------------------------------------------------------------------------------

const SYNC_IOS_CAPABILITY: &str = include_str!("../../capabilities/sync-ios.json");

/// Commandes de l'iPhone (ADR 0011 §23 point 5) : les 25 moins les trois de la fenêtre `pairing`.
const PAIRING_WINDOW_COMMANDS: [&str; 3] = ["sync_pairing_open", "sync_pairing_payload", "sync_pairing_close"];
/// Les cinq commandes du plugin barcode-scanner (scan du QR par le JS, §23 point 2), seules permissions de plugin de `sync-ios.json`.
const BARCODE_PERMISSIONS: [&str; 5] = [
    "barcode-scanner:allow-scan",
    "barcode-scanner:allow-cancel",
    "barcode-scanner:allow-check-permissions",
    "barcode-scanner:allow-request-permissions",
    "barcode-scanner:allow-open-app-settings",
];

fn ios_sync_commands() -> Vec<&'static str> {
    SYNC_COMMANDS.iter().copied().filter(|c| !PAIRING_WINDOW_COMMANDS.contains(c)).collect()
}

/// Commandes du gestionnaire de l'iPhone (`generate_handler!` du bloc `cfg(target_os = "ios")`).
fn ios_handler_commands() -> std::collections::BTreeSet<String> {
    let marker = "#[cfg(target_os = \"ios\")]\n    let builder = builder.invoke_handler(tauri::generate_handler![";
    let start = LIB_SOURCE.find(marker).expect("gestionnaire iOS") + marker.len();
    let body = &LIB_SOURCE[start..start + LIB_SOURCE[start..].find(']').unwrap()];
    let body: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join(" ");
    body.split(',').map(str::trim).filter(|i| !i.is_empty()).map(|i| i.rsplit("::").next().unwrap().to_owned()).collect()
}

/// (7) `sync-ios.json` : exactement sa liste, fenêtre `main`, iOS seulement ; aucune commande de la fenêtre `pairing` accordée à une
/// capability iOS ni présente dans le gestionnaire de l'iPhone, qui contient exactement les commandes accordées.
#[test]
fn sync_7_ios_capability_grants_exactly_its_list_and_no_pairing_window_command() {
    let capability: Value = serde_json::from_str(SYNC_IOS_CAPABILITY).expect("sync-ios.json valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]));
    assert!(capability.get("webviews").is_none());
    let mut granted = permissions_of(SYNC_IOS_CAPABILITY);
    granted.sort();
    let mut expected: Vec<String> = ios_sync_commands().iter().map(|c| permission_of(c)).chain(BARCODE_PERMISSIONS.iter().map(|p| (*p).to_owned())).collect();
    expected.sort();
    assert_eq!(granted.iter().filter(|p| p.starts_with("allow-sync-")).count(), 22);
    assert_eq!(granted, expected);
    // Aucune autre capability n'accorde le scan (une seule fenêtre, iPhone).
    for (name, text) in all_capabilities() {
        if name != "sync-ios.json" {
            assert!(!text.contains("barcode-scanner:"), "{name}");
        }
    }
    let handler = ios_handler_commands();
    let synced: std::collections::BTreeSet<String> = handler.iter().filter(|c| c.starts_with("sync_")).cloned().collect();
    assert_eq!(synced, ios_sync_commands().iter().map(|c| (*c).to_owned()).collect());
    for (name, text) in all_capabilities() {
        let capability: Value = serde_json::from_str(&text).unwrap();
        let ios = capability["platforms"].as_array().is_some_and(|p| p.iter().any(|x| x == "iOS"));
        for command in PAIRING_WINDOW_COMMANDS {
            assert!(!handler.contains(command), "{command} dans le gestionnaire de l'iPhone");
            if ios {
                assert!(!permissions_of(&text).contains(&permission_of(command)), "{name} accorde {command} sur iPhone");
            }
        }
    }
}

/// (8) Aucune capability ne contient `folder-bookmark:` : la WebView ne peut appeler aucune commande du plugin (Rust seul l'appelle).
#[test]
fn sync_8_no_capability_grants_the_folder_bookmark_plugin() {
    for (name, text) in all_capabilities() {
        assert!(!text.contains("folder-bookmark:"), "{name}");
    }
    // Le plugin est une dépendance de la cible iOS seulement, enregistré dans le bloc iOS de lib.rs.
    let ios_deps = &CARGO[CARGO.find("[target.'cfg(target_os = \"ios\")'.dependencies]").unwrap()..];
    let ios_deps = &ios_deps[..ios_deps[1..].find("\n[").map_or(ios_deps.len(), |i| i + 1)];
    assert!(ios_deps.contains("tauri-plugin-folder-bookmark = { path = \"plugins/folder-bookmark\" }"));
    assert_eq!(CARGO.matches("tauri-plugin-folder-bookmark").count(), 1, "aucune autre cible");
    assert!(LIB_SOURCE.contains("#[cfg(target_os = \"ios\")]\n    let builder = builder.plugin(tauri_plugin_folder_bookmark::init())"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Lot M (ADR 0013 §1.1, §2.1, §2.5 et §5) : Face ID (I-03), retour haptique (A-07), cache de confidentialité natif (I-03)
// ------------------------------------------------------------------------------------------------------------------------------

/// Section `[...]` de Cargo.toml où chaque ligne commençant par `crate` est déclarée (une seule déclaration attendue).
fn cargo_sections_of(krate: &str) -> Vec<(String, String)> {
    let mut section = String::new();
    let mut out = Vec::new();
    for line in CARGO.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_owned();
        }
        if trimmed.starts_with(&format!("{krate} ")) || trimmed.starts_with(&format!("{krate}=")) {
            out.push((section.clone(), trimmed.to_owned()));
        }
    }
    out
}

const IOS_SECTION: &str = "[target.'cfg(target_os = \"ios\")'.dependencies]";

/// I-03 critère 3, A-07 critère 15 : dépendances sous cfg(target_os = "ios") seulement ; biometric épinglé à =2.4.1 ; plugins locaux par chemin.
#[test]
fn lot_m_plugins_are_ios_only_dependencies() {
    let biometric = cargo_sections_of("tauri-plugin-biometric");
    assert_eq!(biometric.len(), 1, "une seule déclaration de tauri-plugin-biometric");
    assert_eq!(biometric[0].0, IOS_SECTION);
    assert!(biometric[0].1.contains("\"=2.4.1\""), "version non épinglée : {}", biometric[0].1);
    let haptics = cargo_sections_of("tauri-plugin-ct-haptics");
    assert_eq!(haptics, [(IOS_SECTION.to_owned(), "tauri-plugin-ct-haptics = { path = \"plugins/haptics\" }".to_owned())]);
    let shield = cargo_sections_of("tauri-plugin-privacy-shield");
    assert_eq!(shield, [(IOS_SECTION.to_owned(), "tauri-plugin-privacy-shield = { path = \"plugins/privacy-shield\" }".to_owned())]);
    // Le plugin officiel tauri-plugin-haptics n'est pas ajouté (constat 2 de l'ADR : générateurs hors du fil principal).
    assert!(cargo_sections_of("tauri-plugin-haptics").is_empty());
}

/// I-03 critère 3, A-07 critère 15 : chaque plugin est enregistré une fois, sous cfg(target_os = "ios"), jamais sous desktop.
#[test]
fn lot_m_plugins_are_registered_for_ios_only() {
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    for krate in ["tauri_plugin_biometric", "tauri_plugin_ct_haptics", "tauri_plugin_privacy_shield"] {
        let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains(krate)).map(|(i, _)| i).collect();
        assert_eq!(uses.len(), 1, "{krate} : un seul enregistrement");
        assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(target_os = \"ios\")]", "{krate}");
        assert!(lines[uses[0]].contains(&format!("{krate}::init()")), "{krate}");
        assert!(!DESKTOP_SOURCE.contains(krate), "{krate} dans desktop.rs");
    }
}

/// Liste exacte d'une capability iOS du lot M ; fenêtre `main`, iOS seulement, aucune autre capability n'accorde le préfixe.
fn assert_exact_ios_capability(file: &str, prefix: &str, expected: &[&str]) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(file);
    let text = std::fs::read_to_string(path).expect("capability");
    let capability: Value = serde_json::from_str(&text).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]), "{file}");
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]), "{file}");
    assert!(capability.get("webviews").is_none(), "{file}");
    let mut granted = permissions_of(&text);
    granted.sort();
    let mut wanted: Vec<String> = expected.iter().map(|p| (*p).to_owned()).collect();
    wanted.sort();
    assert_eq!(granted, wanted, "{file}");
    assert!(!granted.iter().any(|p| p.ends_with(":default")), "{file}");
    for (name, other) in all_capabilities() {
        if name != file {
            assert!(!other.contains(prefix), "{name} accorde {prefix}");
        }
    }
}

/// I-03 critère 3 (ADR 0013 §2.1) : exactement status et authenticate, jamais biometric:default.
#[test]
fn i03_biometric_capability_grants_exactly_status_and_authenticate() {
    assert_exact_ios_capability("biometric-ios.json", "biometric:", &["biometric:allow-status", "biometric:allow-authenticate"]);
}

/// A-07 critère 15 (ADR 0013 §1.1) : exactement les trois commandes du plugin local haptics.
#[test]
fn a07_haptics_capability_grants_exactly_the_three_commands() {
    assert_exact_ios_capability(
        "haptics-ios.json",
        "haptics:",
        &["haptics:allow-impact-feedback", "haptics:allow-notification-feedback", "haptics:allow-selection-feedback"],
    );
}

/// I-03 (ADR 0013 §2.5) : exactement set_enabled du plugin local privacy-shield.
#[test]
fn i03_privacy_shield_capability_grants_exactly_set_enabled() {
    assert_exact_ios_capability("privacy-shield-ios.json", "privacy-shield:", &["privacy-shield:allow-set-enabled"]);
}

const HAPTICS_CARGO: &str = include_str!("../../plugins/haptics/Cargo.toml");
const HAPTICS_BUILD: &str = include_str!("../../plugins/haptics/build.rs");
const HAPTICS_LIB: &str = include_str!("../../plugins/haptics/src/lib.rs");
const SHIELD_CARGO: &str = include_str!("../../plugins/privacy-shield/Cargo.toml");
const SHIELD_BUILD: &str = include_str!("../../plugins/privacy-shield/build.rs");
const SHIELD_LIB: &str = include_str!("../../plugins/privacy-shield/src/lib.rs");

/// Le préfixe ACL d'un plugin est tiré de `links` (tauri-utils `read_permissions`, « tauri-plugin- » retiré) : il doit être égal au nom
/// passé à `Builder::new`, sinon tout appel `plugin:<nom>|…` est refusé à l'exécution (avenant lot M de l'ADR 0013).
#[test]
fn lot_m_local_plugins_acl_prefix_matches_runtime_name() {
    assert!(HAPTICS_CARGO.contains("name = \"tauri-plugin-ct-haptics\""));
    assert!(HAPTICS_CARGO.contains("links = \"tauri-plugin-haptics\""));
    assert!(HAPTICS_LIB.contains("Builder::new(\"haptics\")"));
    assert!(HAPTICS_LIB.contains("tauri::ios_plugin_binding!(init_plugin_ct_haptics);"));
    assert!(HAPTICS_BUILD.contains("const COMMANDS: &[&str] = &[\"impact_feedback\", \"notification_feedback\", \"selection_feedback\"];"));
    assert!(SHIELD_CARGO.contains("name = \"tauri-plugin-privacy-shield\""));
    assert!(SHIELD_CARGO.contains("links = \"tauri-plugin-privacy-shield\""));
    assert!(SHIELD_LIB.contains("Builder::new(\"privacy-shield\")"));
    assert!(SHIELD_LIB.contains("tauri::ios_plugin_binding!(init_plugin_privacy_shield);"));
    assert!(SHIELD_BUILD.contains("const COMMANDS: &[&str] = &[\"set_enabled\"];"));
    // Aucune commande Rust : seules les méthodes Swift répondent (pas de invoke_handler dans ces plugins).
    assert!(!HAPTICS_LIB.contains("invoke_handler") && !SHIELD_LIB.contains("invoke_handler"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Lot F (ADR 0009 avenant lot F) : plugin ct-files et export sur iPhone (FILES-IOS-01)
// ------------------------------------------------------------------------------------------------------------------------------

/// FILES-IOS-01 critère 4 : `export-ios.json` n'accorde que `allow-export-save-file` (fenêtre `main`, iOS) ; `export.json` (PC) inchangé ;
/// aucune capability ne contient `ct-files:` (Rust seul appelle le plugin).
#[test]
fn files_ios_01_4_export_ios_capability_is_exact_and_no_capability_grants_the_plugin() {
    assert_exact_ios_capability("export-ios.json", "allow-export-save-file\"]", &["allow-export-save-file"]);
    let mut pc = permissions_of(include_str!("../../capabilities/export.json"));
    pc.sort();
    assert_eq!(pc, ["allow-export-save-file", "allow-reveal-exported-file"]);
    for (name, text) in all_capabilities() {
        assert!(!text.contains("ct-files:"), "{name}");
        let capability: Value = serde_json::from_str(&text).unwrap();
        let ios = capability["platforms"].as_array().is_some_and(|p| p.iter().any(|x| x == "iOS"));
        if ios {
            for permission in permissions_of(&text) {
                assert!(!["fs:", "dialog:", "opener:"].iter().any(|prefix| permission.starts_with(prefix)), "{name} : {permission}");
                assert!(permission != "allow-reveal-exported-file" && permission != "allow-import-open-file", "{name} : {permission}");
            }
        }
    }
}

/// FILES-IOS-01 critères 4 et 10 : le crate est une dépendance de la cible iOS seulement, enregistré une fois dans le bloc iOS ;
/// `export_save_file` est dans les deux gestionnaires (PC et iPhone), `reveal_exported_file` et `import_open_file` jamais sur iPhone ;
/// ni dialog ni fs dans la section iOS.
#[test]
fn files_ios_01_4_plugin_is_ios_only_and_the_ios_handler_has_only_the_save_command() {
    assert_eq!(cargo_sections_of("tauri-plugin-ct-files"), [(IOS_SECTION.to_owned(), "tauri-plugin-ct-files = { path = \"plugins/files\" }".to_owned())]);
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("tauri_plugin_ct_files::init()")).map(|(i, _)| i).collect();
    assert_eq!(uses.len(), 1);
    assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(target_os = \"ios\")]");
    assert!(!DESKTOP_SOURCE.contains("ct_files"));
    let ios = ios_handler_commands();
    assert!(ios.contains("export_save_file"));
    assert!(!ios.contains("reveal_exported_file") && !ios.contains("import_open_file"));
    assert!(LIB_SOURCE.contains("export_ios::export_save_file"));
    for krate in ["tauri-plugin-dialog", "tauri-plugin-fs"] {
        assert!(cargo_sections_of(krate).iter().all(|(section, _)| section != IOS_SECTION), "{krate} dans la section iOS");
    }
}

/// FILES-IOS-01 critère 10 : `build-ios.yml` vérifie par `cargo tree` le plugin ct-files (iOS oui, Windows non) et l'absence de dialog / fs.
#[test]
fn files_ios_01_10_ios_workflow_checks_the_plugin_targets() {
    let workflow = include_str!("../../../.github/workflows/build-ios.yml");
    assert!(workflow.contains("cargo tree --target aarch64-apple-ios -i tauri-plugin-ct-files"));
    assert!(workflow.contains("cargo tree --target x86_64-pc-windows-msvc -i tauri-plugin-ct-files"));
    assert!(workflow.contains("tauri-plugin-dialog tauri-plugin-fs"), "dialog et fs refusés dans la cible iOS");
}

// ------------------------------------------------------------------------------------------------------------------------------
// I-04 (ADR 0014 §2) : journal technique persistant
// ------------------------------------------------------------------------------------------------------------------------------

const LOG_PERMISSIONS: [&str; 3] = ["allow-log-append", "allow-log-clear", "allow-log-read"];

/// I-04 critères 9 et 13 : `logs.json` (PC) et `logs-ios.json` (iPhone) exacts, fenêtre `main` ; aucune autre capability (pairing, capture,
/// focus…) ne porte ces commandes ; les trois commandes sont dans les deux gestionnaires et au manifeste.
#[test]
fn i04_9_log_capabilities_are_exact_and_only_for_the_main_window() {
    for (file, platform) in [("logs.json", "windows"), ("logs-ios.json", "iOS")] {
        let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(file)).expect("capability");
        let capability: Value = serde_json::from_str(&text).expect("capability valide");
        assert_eq!(capability["windows"], serde_json::json!(["main"]), "{file}");
        assert_eq!(capability["platforms"], serde_json::json!([platform]), "{file}");
        assert!(capability.get("webviews").is_none(), "{file}");
        let mut granted = permissions_of(&text);
        granted.sort();
        assert_eq!(granted, LOG_PERMISSIONS, "{file}");
    }
    for (name, text) in all_capabilities() {
        if name != "logs.json" && name != "logs-ios.json" {
            assert!(!permissions_of(&text).iter().any(|p| p.contains("-log-")), "{name} accorde une commande du journal");
        }
    }
    let manifest = manifest_commands();
    let ios = ios_handler_commands();
    for command in ["log_append", "log_read", "log_clear"] {
        assert!(manifest.contains(command), "{command} absent du manifeste");
        assert!(ios.contains(command), "{command} absent du gestionnaire iOS");
        assert!(LIB_SOURCE.contains(&format!("applog::{command}")), "{command}");
    }
}

/// I-04 critère 9 (ADR 0014, « Conséquences ») : le seul `eprintln!` du code Rust est dans `applog.rs` ; le journal est initialisé au début
/// du `setup` PC (avant la récupération) et iPhone (avant la purge).
#[test]
fn i04_9_the_only_eprintln_is_in_applog_and_the_journal_starts_first() {
    fn visit(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("dossier") {
            let path = entry.expect("entrée").path();
            if path.is_dir() {
                visit(&path, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                out.push((path.to_string_lossy().into_owned(), std::fs::read_to_string(&path).expect("source")));
            }
        }
    }
    let mut sources = Vec::new();
    visit(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut sources);
    assert!(sources.len() > 20);
    for (path, text) in &sources {
        // Code seulement : les commentaires peuvent citer la macro.
        let count = text.lines().filter(|l| !l.trim_start().starts_with("//")).map(|l| l.matches("eprintln!").count()).sum::<usize>();
        if path.ends_with("applog.rs") {
            assert_eq!(count, 1, "{path}");
        } else {
            assert_eq!(count, 0, "eprintln! hors d'applog : {path}");
        }
    }
    let setup = DESKTOP_SOURCE.split(".setup(|app| {").nth(1).expect("setup");
    assert!(setup.find("crate::applog::init(").unwrap() < setup.find("recover_and_settle").unwrap());
    let ios = include_str!("../../src/ios_setup.rs");
    assert!(ios.find("crate::applog::init(").unwrap() < ios.find("purge_exports").unwrap());
}

// ------------------------------------------------------------------------------------------------------------------------------
// P-04-iOS (ADR 0009 avenant lot F B1 et B3)
// ------------------------------------------------------------------------------------------------------------------------------

/// P-04-iOS critère 16 : `backups-ios.json` exacte (cinq commandes, jamais `allow-reveal-backups-folder`), `backups.json` (PC) inchangé ;
/// gestionnaire iOS = ces cinq commandes de sauvegarde (plus la sauvegarde avant migration) ; aucune autre capability iOS ne les porte.
#[test]
fn p04_ios_16_backups_capability_and_handler_are_exact() {
    let text = include_str!("../../capabilities/backups-ios.json");
    let capability: Value = serde_json::from_str(text).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]));
    let mut granted = permissions_of(text);
    granted.sort();
    assert_eq!(granted, ["allow-backup-restore-marker-write", "allow-backup-set-aside-conflicts", "allow-backup-startup-status", "allow-check-backup", "allow-daily-backup", "allow-list-backups", "allow-restore-backup"]);
    let ios = ios_handler_commands();
    for command in ["daily_backup", "list_backups", "check_backup", "restore_backup", "backup_startup_status", "backup_set_aside_conflicts"] {
        assert!(ios.contains(command), "{command}");
    }
    assert!(!ios.contains("reveal_backups_folder"));
    for (name, other) in all_capabilities() {
        if name != "backups-ios.json" {
            assert!(!other.contains("allow-backup-startup-status") && !other.contains("allow-backup-set-aside-conflicts"), "{name}");
        }
        if name != "backups.json" {
            assert!(!other.contains("allow-reveal-backups-folder"), "{name}");
        }
    }
}

/// P-04-iOS B3 : sur iPhone le plugin SQL n'est PAS dans la chaîne du builder (enregistré par `ios_setup` après la récupération) ; sur PC
/// il l'est, après les plugins du PC (l'instance unique reste le premier plugin).
#[test]
fn p04_ios_sql_plugin_is_registered_late_on_iphone_only() {
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("tauri_plugin_sql::Builder")).map(|(i, _)| i).collect();
    assert_eq!(uses.len(), 1, "un seul enregistrement dans lib.rs");
    assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(desktop)]");
    let configure = lines.iter().position(|l| l.contains("desktop::configure(builder)")).unwrap();
    assert!(configure < uses[0], "après desktop::configure (instance unique d'abord)");
    let gate = include_str!("../../src/startup_gate.rs");
    let ios = include_str!("../../src/ios_setup.rs");
    assert!(gate.contains("app.plugin(tauri_plugin_sql::Builder::default().build())"));
    assert!(ios.find("crate::applog::init(").unwrap() < ios.find("register_sql_after_recovery").unwrap());
}

// ------------------------------------------------------------------------------------------------------------------------------
// I-02 (ADR 0013 §3.1) : commande app_signing_info, iPhone seulement
// ------------------------------------------------------------------------------------------------------------------------------

/// I-02 critère 3 : exactement `allow-app-signing-info`, fenêtre `main`, iOS ; aucune autre capability (donc aucune capability Windows).
#[test]
fn i02_signing_capability_grants_exactly_the_one_command() {
    assert_exact_ios_capability("signing-ios.json", "allow-app-signing-info", &["allow-app-signing-info"]);
}

/// I-02 critère 3 : la commande est sous cfg(target_os = "ios"), dans le gestionnaire de l'iPhone et pas dans celui du PC.
#[test]
fn i02_signing_command_exists_for_ios_only() {
    const SIGNING: &str = include_str!("../../src/signing.rs");
    assert!(SIGNING.contains("#[cfg(target_os = \"ios\")]\n#[tauri::command]\npub async fn app_signing_info()"));
    assert_eq!(SIGNING.matches("#[tauri::command]").count(), 1);
    assert!(ios_handler_commands().contains("app_signing_info"));
    let desktop_start = LIB_SOURCE.find("#[cfg(desktop)]\n    let builder = desktop::configure(builder)").expect("bloc PC");
    let desktop_block = &LIB_SOURCE[desktop_start..desktop_start + LIB_SOURCE[desktop_start..].find("\n    ]);").expect("fin du bloc PC")];
    assert!(!desktop_block.contains("app_signing_info"), "commande iOS dans le gestionnaire du PC");
    assert!(manifest_commands().contains("app_signing_info"));
}

const IOS_REMINDERS_CAPABILITY: &str = include_str!("../../capabilities/reminders-ios.json");

/// K-05 (ADR 0008 §10.4) : liste EXACTE des permissions de la capability iOS des Rappels Apple ; fenêtre principale, iOS seulement ; aucune
/// capability (Windows comprise) n'accorde `reminders:`.
#[test]
fn k05_ios_reminders_capability_grants_exactly_the_listed_permissions_and_no_other_capability_does() {
    let capability: Value = serde_json::from_str(IOS_REMINDERS_CAPABILITY).expect("capability valide");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["iOS"]));
    let mut names = permissions_of(IOS_REMINDERS_CAPABILITY);
    names.sort();
    assert_eq!(
        names,
        [
            "reminders:allow-delete",
            "reminders:allow-fetch",
            "reminders:allow-lists",
            "reminders:allow-register-listener",
            "reminders:allow-remove-listener",
            "reminders:allow-request-access",
            "reminders:allow-set-completed",
            "reminders:allow-status",
            "reminders:allow-upsert",
        ]
    );
    for forbidden in [":default", "allow-check-permissions", "allow-request-permissions"] {
        assert!(!names.iter().any(|name| name.contains(forbidden)), "{forbidden}");
    }
    for other in other_capabilities("reminders-ios.json") {
        assert!(!other.contains("reminders:"), "une autre capability accorde reminders:");
    }
}

/// K-05 : le plugin des Rappels n'est déclaré que dans la section des dépendances iOS de Cargo.toml et enregistré sous `cfg(target_os = "ios")`.
#[test]
fn k05_reminders_plugin_is_ios_only() {
    let mut section = String::new();
    let mut declarations = 0;
    for line in CARGO.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_owned();
        }
        if trimmed.starts_with("tauri-plugin-reminders") {
            declarations += 1;
            assert_eq!(section, "[target.'cfg(target_os = \"ios\")'.dependencies]", "plugin des Rappels hors de la section iOS");
            assert!(trimmed.contains("path = \"plugins/reminders\""), "{trimmed}");
        }
    }
    assert_eq!(declarations, 1);
    let lines: Vec<&str> = LIB_SOURCE.lines().collect();
    let uses: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("tauri_plugin_reminders::")).map(|(i, _)| i).collect();
    assert_eq!(uses.len(), 1, "un seul enregistrement");
    assert_eq!(lines[uses[0] - 1].trim(), "#[cfg(target_os = \"ios\")]");
    assert!(!DESKTOP_SOURCE.contains("reminders"));
}

/// Fusion du lot C : un seul `setup` dans lib.rs (Tauri n'en garde qu'un ; un second remplacerait `ios_setup` et le plugin SQL ne serait
/// jamais enregistré sur l'iPhone) ; le nettoyage de Vision au lancement passe par `ios_setup`.
#[test]
fn p04_ios_a_single_setup_runs_recovery_then_vision_cleanup() {
    assert_eq!(LIB_SOURCE.matches(".setup(").count(), 1);
    assert!(LIB_SOURCE.contains(".setup(ios_setup::setup)"));
    let ios = include_str!("../../src/ios_setup.rs");
    assert!(ios.find("register_sql_after_recovery").unwrap() < ios.find("clean_on_launch").unwrap());
}
