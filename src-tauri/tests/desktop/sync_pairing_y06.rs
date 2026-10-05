//! Y-06 critères 1, 3, 9 et 18 (a) : page `pairing.html` reconnue par sa clé exacte et son marqueur, contrôle de la page en
//! développement (requête au serveur Vite local, dette soldée), arrivée de l'appareil associé pendant l'affichage du QR (scan simulé
//! par un `SyncFs` de test), décisions prises autour de la vraie fenêtre (destruction, jamais un masquage).

use std::path::Path;

use circletasks_lib::sync::folder::FolderKind;
use circletasks_lib::sync::limits::PAIRING_VALIDITY_MS;
use circletasks_lib::sync::pairing::{
    affinity_outcome, pairing_page_listed, pairing_window_action, watch_decision, Caller, PairingMode, PairingRegistry, PairingWindowAction, PairingWindowEvent,
    WatchInput, PAIRING_PAGE_MARKER, PAIRING_WINDOW,
};
use circletasks_lib::sync::service::KeyInput;
use circletasks_lib::sync::SyncCode;
use zeroize::Zeroizing;

use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, MemFs, DEV_A, DEV_B, DEV_C, FOLDER, NOW};

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Page et contrôle en développement (critères 1 et 3)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y06_1_page_carries_the_marker_and_is_listed_by_exact_key() {
    let page = include_str!("../../../pairing.html");
    assert!(page.contains(PAIRING_PAGE_MARKER), "pairing.html porte le marqueur");
    assert!(page.contains("/theme-init.js") && page.contains("<div id=\"root\"></div>") && page.contains("/src/features/sync/pairing-window/main.tsx"));
    for other in [include_str!("../../../index.html"), include_str!("../../../capture.html")] {
        assert!(!other.contains(PAIRING_PAGE_MARKER), "aucune autre page ne porte le marqueur");
    }
    assert!(pairing_page_listed(["/index.html", "/pairing.html"].into_iter()));
    assert!(pairing_page_listed(["pairing.html"].into_iter()));
    assert!(!pairing_page_listed(["/index.html", "/assets/pairing.html", "/pairing.html.map"].into_iter()));
    // Le contrôle par les clés des actifs vient d'abord ; la requête au serveur Vite n'existe qu'en développement (D2).
    let source = include_str!("../../src/sync/commands.rs");
    let listed = source.find("if pairing_page_listed(").expect("clés des actifs");
    let dev = source.find("dev_page_has_marker(host, port)").expect("requête de développement");
    assert!(listed < dev);
    assert!(source[..dev].rfind("#[cfg(debug_assertions)]").is_some_and(|at| at > listed), "requête sous cfg(debug_assertions)");
    assert!(!source.contains("dev_url.is_some() {\n        return true;"), "plus de contrôle sauté");
    // La fenêtre n'est jamais déclarée dans la configuration (§2.1).
    for conf in [include_str!("../../tauri.conf.json"), include_str!("../../tauri.windows.conf.json")] {
        assert!(!conf.contains("pairing"));
    }
}

/// Serveur local d'un seul échange : renvoie la réponse donnée, puis la requête reçue.
#[cfg(debug_assertions)]
fn serve_once(response: Vec<u8>) -> (u16, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 1024];
        while !request.ends_with(b"\r\n\r\n") {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        stream.write_all(&response).unwrap();
        String::from_utf8(request).unwrap()
    });
    (port, handle)
}

#[cfg(debug_assertions)]
fn http(status: &str, body: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

#[cfg(debug_assertions)]
#[test]
fn y06_3_dev_server_answering_index_html_is_refused_the_pairing_page_is_accepted() {
    use circletasks_lib::sync::pairing::{dev_page_has_marker, dev_response_is_pairing_page};
    // Page absente : Vite répond index.html (l'application entière) avec un code 200 : refus.
    let (port, server) = serve_once(http("200 OK", include_str!("../../../index.html")));
    assert!(!dev_page_has_marker("127.0.0.1", port));
    let request = server.join().unwrap();
    assert!(request.starts_with("GET /pairing.html HTTP/1.1\r\n"), "{request}");
    // La vraie page : acceptée.
    let (port, server) = serve_once(http("200 OK", include_str!("../../../pairing.html")));
    assert!(dev_page_has_marker("127.0.0.1", port));
    server.join().unwrap();
    // Marqueur avec un autre statut, réponse vide, hôte qui n'est pas de bouclage, serveur absent : refus.
    assert!(!dev_response_is_pairing_page(&http("404 Not Found", include_str!("../../../pairing.html"))));
    assert!(!dev_response_is_pairing_page(b""));
    assert!(!dev_page_has_marker("example.com", 80));
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let free = closed.local_addr().unwrap().port();
    drop(closed);
    assert!(!dev_page_has_marker("127.0.0.1", free));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Vraie fenêtre (critère 18 a) : décisions extraites en fonctions pures, appliquées par commands.rs
// ------------------------------------------------------------------------------------------------------------------------------

fn caller(hwnd: isize) -> Caller<'static> {
    Caller { label: PAIRING_WINDOW, url: "http://tauri.localhost/pairing.html", hwnd }
}

#[test]
fn y06_18_window_decisions_destroy_and_never_hide() {
    // Croix native : fermeture empêchée puis destruction ; destruction : instance effacée.
    assert_eq!(pairing_window_action(PairingWindowEvent::CloseRequested), PairingWindowAction::PreventAndDestroy);
    assert_eq!(pairing_window_action(PairingWindowEvent::Destroyed), PairingWindowAction::Clear);
    assert_eq!(pairing_window_action(PairingWindowEvent::Other), PairingWindowAction::Ignore);
    // Échec de SetWindowDisplayAffinity (ou HWND inconnu) : `io`, la fenêtre est détruite avant tout affichage.
    assert_eq!(code(affinity_outcome(42, false)), SyncCode::Io);
    assert_eq!(code(affinity_outcome(0, true)), SyncCode::Io);
    assert!(affinity_outcome(42, true).is_ok());
    // Surveillance : `main` réduite, masquée ou fermée → destruction ; échéance → destruction ; sinon rien.
    assert_eq!(watch_decision(WatchInput { main_shown: false, expired: false }), Some("main-hidden"));
    assert_eq!(watch_decision(WatchInput { main_shown: false, expired: true }), Some("main-hidden"));
    assert_eq!(watch_decision(WatchInput { main_shown: true, expired: true }), Some("expired"));
    assert_eq!(watch_decision(WatchInput { main_shown: true, expired: false }), None);
    // Les commandes appliquent ces décisions : destruction (jamais `hide`), fermeture limitée à l'instance appelante.
    let source = include_str!("../../src/sync/commands.rs");
    assert!(source.contains("match pairing_window_action(seen)") && source.contains("watch_decision(WatchInput { main_shown, expired })"));
    assert!(source.contains("if let Err(error) = affinity_outcome(hwnd, excluded)"));
    assert!(!source.contains(".hide()"), "la fenêtre pairing n'est jamais masquée");
    let close = &source[source.find("pub async fn sync_pairing_close").unwrap()..];
    let close = &close[..close.find("\n}\n").unwrap()];
    assert!(close.contains("state.pairing.verify(&caller") && close.contains("destroy_pairing(&app, &state.pairing, instance.hwnd)"));
    assert!(!close.contains("get_webview_window(PAIRING_WINDOW)"), "aucune cible autre que l'instance vérifiée");
}

#[test]
fn y06_18_close_only_targets_the_calling_instance() {
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(42, PairingMode::Show, NOW);
    // Une autre fenêtre (même libellé, autre HWND) ne peut ni se faire passer pour l'instance ni l'effacer.
    assert_eq!(code(registry.verify(&caller(43), NOW)), SyncCode::WrongWindow);
    registry.clear(43);
    assert!(registry.current().is_some(), "effacement demandé pour un autre HWND : sans effet");
    registry.clear(42);
    assert!(registry.current().is_none());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Arrivée de l'appareil associé (critère 9)
// ------------------------------------------------------------------------------------------------------------------------------

fn publish(d: &Device, dev: &str, ep: &str, paired_by: Option<&str>) {
    let mut state = serde_json::json!({
        "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": 1,
        "head": { "epoch": ep, "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(5, dev), "forgotten": [], "reset": null
    });
    if let Some(p) = paired_by {
        state["pairedBy"] = serde_json::json!(p);
    }
    d.core.write_state(14, state).expect("état");
}

/// Appareil qui rejoint le dossier : dossier choisi et appareil lié, sans clé.
fn joiner(fs: &std::sync::Arc<MemFs>, dev: &str) -> Device {
    let d = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()));
    d.core.choose_folder(Path::new(FOLDER)).unwrap();
    d.core.bind_device(dev).unwrap();
    d
}

#[test]
fn y06_9_arrival_of_the_paired_device_closes_the_show_window_once() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish(&a, DEV_A, &epoch(1, DEV_A), None);
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(42, PairingMode::Show, NOW);
    let scan = a.core.scan(&[]).unwrap();
    assert!(a.core.paired_with_self(&scan).is_empty());
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None, "premier scan : référence");

    // C rejoint par la clé de secours (aucun pairedBy) : la fenêtre reste.
    let payload = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    let c = joiner(&fs, DEV_C);
    c.core.key_import(KeyInput::RecoveryKey(Zeroizing::new(payload.recovery_key.clone())), 1).unwrap();
    publish(&c, DEV_C, &epoch(1, DEV_A), None);
    let scan = a.core.scan(&[]).unwrap();
    assert!(scan.devices.iter().any(|d| d.device_id == DEV_C && d.state_status == "ok"));
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None);

    // B rejoint par le QR du PC : pairedBy = A → fenêtre détruite, une seule fois.
    let b = joiner(&fs, DEV_B);
    let result = b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1).unwrap();
    assert_eq!(result.paired_by.as_deref(), Some(DEV_A));
    publish(&b, DEV_B, &epoch(1, DEV_A), Some(DEV_A));
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(a.core.paired_with_self(&scan), vec![DEV_B.to_owned()]);
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), Some(42));
    assert!(registry.current().is_none(), "instance effacée");
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None, "un seul événement");
}

#[test]
fn y06_9_already_paired_device_other_pc_and_import_instance_do_not_close() {
    let (a, fs) = device();
    a.setup(DEV_A);
    publish(&a, DEV_A, &epoch(1, DEV_A), None);
    let payload = a.core.pairing_payload(a.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    // B, déjà associé par A avant l'ouverture de la fenêtre.
    let b = joiner(&fs, DEV_B);
    b.core.key_import(KeyInput::QrText(Zeroizing::new(payload.qr_text.clone())), 1).unwrap();
    publish(&b, DEV_B, &epoch(1, DEV_A), Some(DEV_A));
    let registry = PairingRegistry::default();
    registry.begin_open(false).unwrap();
    registry.register(42, PairingMode::Show, NOW);
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None, "déjà là au premier scan");
    // B se resynchronise pendant l'affichage : la fenêtre reste.
    let scan = a.core.scan(&[]).unwrap();
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None);
    // C associé par B (un autre appareil) : pas pour ce PC.
    let from_b = b.core.pairing_payload(b.clock.now() + PAIRING_VALIDITY_MS).unwrap();
    let c = joiner(&fs, DEV_C);
    c.core.key_import(KeyInput::QrText(Zeroizing::new(from_b.qr_text.clone())), 1).unwrap();
    publish(&c, DEV_C, &epoch(1, DEV_A), Some(DEV_B));
    let scan = a.core.scan(&[]).unwrap();
    assert!(!a.core.paired_with_self(&scan).contains(&DEV_C.to_owned()));
    assert_eq!(registry.observe_paired(&a.core.paired_with_self(&scan)), None);
    assert!(registry.current().is_some());
    // Instance `import` : jamais concernée, même par un nouvel arrivant.
    let import = PairingRegistry::default();
    import.begin_open(false).unwrap();
    import.register(7, PairingMode::Import, NOW);
    assert_eq!(import.observe_paired(&[]), None);
    assert_eq!(import.observe_paired(&[DEV_B.to_owned()]), None);
    assert!(import.current().is_some());
}

#[test]
fn y06_9_state_not_authenticated_never_counts() {
    // Un état qui ne se déchiffre pas avec la clé locale (appareil `foreign`, écrit avec une autre clé) ne compte jamais.
    let (a, fs) = device();
    a.setup(DEV_A);
    publish(&a, DEV_A, &epoch(1, DEV_A), None);
    let other = MemFs::new();
    let stranger = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, other.clone()));
    stranger.setup(DEV_B);
    publish(&stranger, DEV_B, &epoch(1, DEV_B), None);
    for (name, bytes) in other.all_files() {
        let parts: Vec<&str> = name.split('/').collect();
        fs.put(&parts, &bytes);
    }
    let scan = a.core.scan(&[]).unwrap();
    let foreign = scan.devices.iter().find(|d| d.device_id == DEV_B).expect("appareil listé");
    assert_ne!(foreign.state_status, "ok");
    assert!(a.core.paired_with_self(&scan).is_empty());
}
