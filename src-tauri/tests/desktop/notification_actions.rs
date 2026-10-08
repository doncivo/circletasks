//! N-03 (ADR 0012 avenant N-03) : contrôles STATIQUES du plugin Swift `notification-actions` (aucune compilation iOS locale : le Swift ne
//! compile qu'en CI, `build-ios.yml`). Contrat des commandes (Swift, `build.rs`, adaptateur TS), absence de texte d'interface, rôle de
//! délégué, écriture du fichier AVANT le gestionnaire de fin, aucune action sur les notifications elles-mêmes, plugin iPhone seulement.

use std::collections::BTreeSet;

const SWIFT: &str = include_str!("../../plugins/notification-actions/ios/Sources/NotificationActionsPlugin.swift");
const PACKAGE: &str = include_str!("../../plugins/notification-actions/ios/Package.swift");
const BUILD: &str = include_str!("../../plugins/notification-actions/build.rs");
const PLUGIN_LIB: &str = include_str!("../../plugins/notification-actions/src/lib.rs");
const PLUGIN_CARGO: &str = include_str!("../../plugins/notification-actions/Cargo.toml");
const ADAPTER_TS: &str = include_str!("../../../src/platform/notifications/tauriNotificationActions.ts");
const INFO_PLIST: &str = include_str!("../../Info.ios.plist");
const PLIST_CONTRACT: &str = include_str!("../../../scripts/ios/plist-contract.json");

/// Commandes du contrat (snake_case côté Tauri, lowerCamelCase côté Swift).
const COMMANDS: [&str; 6] = ["drain", "ack", "status", "register_action_types", "register_listener", "remove_listener"];

/// Lignes du Swift sans commentaires (`//` en début de ligne ou en fin de ligne hors chaîne).
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

/// Littéraux de chaîne du Swift (hors commentaires).
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

fn lower_camel(snake: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in snake.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn commands_of_build() -> BTreeSet<String> {
    let start = BUILD.find("= &[").expect("liste COMMANDS") + 4;
    let end = start + BUILD[start..].find(']').expect("fin de liste");
    BUILD[start..end].split(',').map(|item| item.trim().trim_matches('"').to_owned()).filter(|item| !item.is_empty()).collect()
}

/// Contrat : les commandes de `build.rs` sont exactement celles du contrat, chacune a sa méthode Swift (ou vient de la classe `Plugin`
/// de Tauri pour l'écoute), et l'adaptateur TS n'appelle que ces commandes.
#[test]
fn n03_contract_commands_match_build_swift_and_the_ts_adapter() {
    assert_eq!(commands_of_build(), COMMANDS.iter().map(|c| (*c).to_owned()).collect::<BTreeSet<_>>());
    let code = swift_code();
    for command in COMMANDS {
        if command.ends_with("_listener") {
            // `registerListener` / `removeListener` : méthodes de la classe `Plugin` de Tauri, jamais redéfinies ici.
            assert!(!code.contains(&format!("func {}(", lower_camel(command))), "{command} ne doit pas être redéfinie");
            continue;
        }
        assert!(code.contains(&format!("@objc public func {}(_ invoke: Invoke)", lower_camel(command))), "méthode Swift absente : {command}");
    }
    for command in ["drain", "ack", "status", "register_action_types"] {
        assert!(ADAPTER_TS.contains(&format!("'{command}'")), "l'adaptateur TS n'appelle pas {command}");
    }
    assert!(ADAPTER_TS.contains("const PLUGIN = 'plugin:notification-actions|';"));
    assert!(ADAPTER_TS.contains("addPluginListener(PLUGIN_NAME, event, handler)") && ADAPTER_TS.contains("PLUGIN_NAME = 'notification-actions'"));
    // Le nom d'événement émis par Swift est celui que l'adaptateur écoute.
    assert!(SWIFT.contains("trigger(\"action\""));
    assert!(ADAPTER_TS.contains("listen('action', listener)"));
}

/// Format du fichier : les clés écrites par Swift sont celles que lit le TS (`parseLine`), et le nom du fichier est celui de l'ADR.
#[test]
fn n03_file_format_keys_are_shared_by_swift_and_ts() {
    for key in ["\"v\"", "\"n\"", "\"a\"", "\"t\"", "\"sid\"", "\"at\""] {
        assert!(swift_code().contains(key), "clé absente du Swift : {key}");
    }
    assert!(ADAPTER_TS.contains("const { n, a, t, sid, at } = value;"));
    assert!(SWIFT.contains("ct-notification-actions") && SWIFT.contains("queue.jsonl"));
    for action in ["\"done\"", "\"snooze15\""] {
        assert!(swift_code().contains(action), "{action}");
    }
    // Les champs d'entrée de `ack` et `registerActionTypes`.
    for field in ["let count: Int", "let writeFailures: Int", "let types: [CategorySpec]", "let foreground: Bool", "let title: String"] {
        assert!(swift_code().contains(field), "{field}");
    }
    assert!(ADAPTER_TS.contains("count: lines, writeFailures"));
}

/// Aucun texte d'interface en Swift (les titres viennent de `src/i18n` par le JS) : littéraux ASCII sans espace.
#[test]
fn n03_swift_has_no_user_visible_text() {
    for literal in swift_literals() {
        assert!(literal.is_ascii(), "littéral non ASCII dans le Swift : {literal:?}");
        assert!(!literal.contains(' '), "littéral avec espace (libellé ?) dans le Swift : {literal:?}");
    }
}

/// Le plugin ne touche à aucune notification : l'envoi, l'annulation et la lecture restent au plugin officiel.
#[test]
fn n03_swift_never_sends_cancels_or_reads_notifications() {
    let code = swift_code();
    for forbidden in [
        "UNNotificationRequest(",
        ".add(",
        "removePendingNotificationRequests",
        "removeAllPendingNotificationRequests",
        "removeDeliveredNotifications",
        "removeAllDeliveredNotifications",
        "getDeliveredNotifications",
        "getPendingNotificationRequests",
        "requestAuthorization",
        "notificationsMap",
    ] {
        assert!(!code.contains(forbidden), "{forbidden}");
    }
}

/// Délégué : bannière, liste et son à la réception app ouverte ; réaffirmé à chaque `didBecomeActive` ; `status` rend l'identité du délégué.
#[test]
fn n03_swift_takes_the_delegate_and_keeps_it() {
    let code = swift_code();
    assert!(code.contains("center.delegate = actionsDelegate"));
    assert!(code.contains("completionHandler([.banner, .list, .sound])"));
    let became_active = code.find("@objc private func appDidBecomeActive()").expect("appDidBecomeActive");
    assert!(code[became_active..].contains("claimDelegate()"));
    assert!(code.contains("UIApplication.didBecomeActiveNotification"));
    assert!(code.contains("UNUserNotificationCenter.current().delegate === actionsDelegate"));
    // Posé dès l'init du plugin, avant tout appel du JS.
    let init = code.find("override init()").expect("init");
    assert!(code[init..].contains("claimDelegate()"));
}

/// L'action est écrite (écriture + fsync) AVANT le gestionnaire de fin ; l'appui simple et le rejet n'écrivent rien.
#[test]
fn n03_swift_writes_the_action_before_the_completion_handler() {
    let code = swift_code();
    let did_receive = code.find("didReceive response: UNNotificationResponse").expect("didReceive");
    let body = &code[did_receive..];
    let guard = body.find("guard knownActions.contains(action) else {").expect("garde des actions connues");
    let early_completion = body[guard..].find("completionHandler()").expect("sortie sans écriture") + guard;
    let append = body.find("ActionStore.shared.append(entry)").expect("écriture");
    let completion_after = body[append..].find("completionHandler()").expect("gestionnaire de fin") + append;
    assert!(early_completion < append, "l'appui simple et le rejet sortent avant toute écriture");
    assert!(append < completion_after, "écriture AVANT le gestionnaire de fin");
    // Le réveil du JS vient après, jamais à la place du fichier.
    assert!(body[completion_after..].contains("plugin?.wake()"));
    let append_fn = &code[code.find("func append(").expect("append")..];
    let append_fn = &append_fn[..append_fn.find("\n  }\n").expect("fin d'append")];
    assert!(append_fn.contains("O_APPEND") && append_fn.contains("try writeAll(fd, line)"));
    let write_all = &code[code.find("private func writeAll(").expect("writeAll")..];
    assert!(write_all[..write_all.find("\n  }\n").unwrap()].contains("fsync(fd)"));
    // Écriture impossible : compteur visible, jamais un silence.
    assert!(append_fn.contains("writeFailuresKey"));
    // `ack` : fichier temporaire, fsync, renommage atomique.
    let ack_fn = &code[code.find("func ack(").expect("ack")..];
    assert!(ack_fn.contains("O_EXCL") && ack_fn.contains("rename(temp.path, url.path)") && ack_fn.contains("try writeAll(fd, rest)"));
}

/// Crate : nom, `links`, binding Swift, aucune commande Rust (transmission à Swift), cible iOS seulement côté app.
#[test]
fn n03_crate_is_a_pure_ios_swift_bridge() {
    assert!(PLUGIN_CARGO.contains("name = \"tauri-plugin-notification-actions\""));
    assert!(PLUGIN_CARGO.contains("links = \"tauri-plugin-notification-actions\""));
    assert!(PLUGIN_LIB.contains("Builder::new(\"notification-actions\")"));
    assert!(PLUGIN_LIB.contains("ios_plugin_binding!(init_plugin_notification_actions)"));
    assert!(SWIFT.contains("@_cdecl(\"init_plugin_notification_actions\")"));
    assert!(BUILD.contains(".ios_path(\"ios\")"));
    assert!(!PLUGIN_LIB.contains("#[tauri::command]") && !PLUGIN_LIB.contains("invoke_handler"), "aucune commande Rust : Tauri transmet à Swift");
}

#[test]
fn n03_package_swift_targets_ios_14_for_banner_and_list() {
    assert!(PACKAGE.starts_with("// swift-tools-version:5.3"));
    assert!(PACKAGE.contains(".iOS(.v14)"), "`.banner` et `.list` existent depuis iOS 14");
    assert!(PACKAGE.contains("name: \"tauri-plugin-notification-actions\""));
    for unknown in [".v15", ".v16", ".v17", ".v18"] {
        assert!(!PACKAGE.contains(unknown), "{unknown} n'existe pas en swift-tools-version 5.3");
    }
}

/// Aucune clé Info.plist ni mode d'arrière-plan : notifications locales, l'action s'ouvre au premier plan.
#[test]
fn n03_needs_no_info_plist_key_and_no_background_mode() {
    assert!(!PLIST_CONTRACT.contains("notification-actions"));
    assert!(!INFO_PLIST.contains("UIBackgroundModes"));
    assert!(swift_code().contains("options: spec.foreground ? [.foreground] : []"));
}
