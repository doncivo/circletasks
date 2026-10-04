//! Banc de test de la mise à jour (D-03, critères 1 à 6 côté Rust), sans clé de production ni dépôt.
//!
//! - Une paire de clés minisign jetable est générée en mémoire à chaque test : rien n'est écrit
//!   sur le disque, aucune clé privée n'existe dans le dépôt.
//! - Un serveur HTTP local (std) sert `latest.json` et un faux paquet.
//! - Le vrai plugin `tauri-plugin-updater` interroge ce serveur, télécharge et vérifie la
//!   signature (`Update::download`). L'installation elle-même (lancement du NSIS) n'est pas
//!   exécutée ici : elle est à vérifier à la main (docs/stories/D-03.md).

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Cursor, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign::KeyPair;
use serde_json::json;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::UpdaterExt;

/// Version courante de l'app de test : celle du paquet (tauri::test::mock_context la lit dans Cargo.toml).
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const TARGET: &str = "test-target";
const PAYLOAD: &[u8] = b"faux installeur CircleTasks";

type Routes = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// Serveur HTTP minimal : GET d'un chemin connu -> 200, sinon 404.
struct Server {
    base: String,
    routes: Routes,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("port local libre");
        let base = format!("http://{}", listener.local_addr().expect("adresse locale"));
        let routes: Routes = Arc::default();
        let shared = Arc::clone(&routes);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let body = shared.lock().expect("verrou").get(&path).cloned();
                let mut stream = reader.into_inner();
                let _ = match body {
                    Some(body) => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(&body))
                    }
                    None => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                };
            }
        });
        Self { base, routes }
    }

    fn serve(&self, path: &str, body: Vec<u8>) {
        self.routes.lock().expect("verrou").insert(path.to_owned(), body);
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

struct TestKey {
    pair: KeyPair,
}

impl TestKey {
    fn generate() -> Self {
        Self { pair: KeyPair::generate_unencrypted_keypair().expect("clé jetable") }
    }

    /// Clé publique au format attendu dans tauri.conf.json (fichier .pub encodé en base64).
    fn pubkey(&self) -> String {
        STANDARD.encode(self.pair.pk.to_box().expect("boîte clé").to_string())
    }

    /// Signature au format de `latest.json` (fichier .sig encodé en base64), version signée incluse.
    fn sign(&self, data: &[u8], signed_version: Option<&str>) -> String {
        let trusted = match signed_version {
            Some(v) => format!("timestamp:1\tfile:CircleTasks_setup.exe\tversion:{v}"),
            None => "timestamp:1\tfile:CircleTasks_setup.exe".to_owned(),
        };
        let signature = minisign::sign(Some(&self.pair.pk), &self.pair.sk, Cursor::new(data), Some(&trusted), Some("jetable"))
            .expect("signature");
        STANDARD.encode(signature.to_string())
    }
}

fn manifest(server: &Server, version: &str, signature: &str) -> Vec<u8> {
    json!({
        "version": version,
        "notes": "Corrections et nouveautés.",
        "pub_date": "2026-10-02T10:00:00Z",
        "platforms": { TARGET: { "url": server.url("/CircleTasks_setup.exe"), "signature": signature } }
    })
    .to_string()
    .into_bytes()
}

fn build_app(pubkey: &str, endpoint: &str) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    // mock_context fixe la version à 0.1.0 : on prend celle du paquet, comme l'app réelle.
    context.package_info_mut().version = CURRENT_VERSION.parse().expect("version du paquet");
    context.config_mut().plugins.0.insert(
        "updater".to_owned(),
        json!({
            "endpoints": [endpoint],
            "pubkey": pubkey,
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true
        }),
    );
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .expect("application de test")
}

async fn check(app: &tauri::App<MockRuntime>) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    app.handle().updater_builder().target(TARGET).build()?.check().await
}

async fn download(update: &tauri_plugin_updater::Update) -> tauri_plugin_updater::Result<Vec<u8>> {
    update.download(|_, _| {}, || {}).await
}

/// Serveur avec `latest.json` (version annoncée, signature donnée) et le paquet `payload`.
fn server_with(version: &str, signature: &str, payload: &[u8]) -> Server {
    let server = Server::start();
    server.serve("/latest.json", manifest(&server, version, signature));
    server.serve("/CircleTasks_setup.exe", payload.to_vec());
    server
}

#[tokio::test(flavor = "current_thread")]
async fn newer_version_is_offered_with_its_notes() {
    let key = TestKey::generate();
    let server = server_with("1.1.0", &key.sign(PAYLOAD, Some("1.1.0")), PAYLOAD);
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("mise à jour proposée");
    assert_eq!(update.version, "1.1.0");
    assert_eq!(update.current_version, CURRENT_VERSION);
    assert_eq!(update.body.as_deref(), Some("Corrections et nouveautés."));
}

#[tokio::test(flavor = "current_thread")]
async fn equal_or_older_version_is_not_offered() {
    let key = TestKey::generate();
    for version in [CURRENT_VERSION, "0.0.1"] {
        let server = server_with(version, &key.sign(PAYLOAD, Some(version)), PAYLOAD);
        let app = build_app(&key.pubkey(), &server.url("/latest.json"));
        assert!(check(&app).await.expect("vérification").is_none(), "{version}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn signed_package_is_downloaded_and_verified() {
    let key = TestKey::generate();
    let server = server_with("1.1.0", &key.sign(PAYLOAD, Some("1.1.0")), PAYLOAD);
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert_eq!(download(&update).await.expect("signature valide"), PAYLOAD);
}

#[tokio::test(flavor = "current_thread")]
async fn package_signed_with_another_key_is_refused() {
    let (trusted, attacker) = (TestKey::generate(), TestKey::generate());
    let server = server_with("1.1.0", &attacker.sign(PAYLOAD, Some("1.1.0")), PAYLOAD);
    let app = build_app(&trusted.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert!(download(&update).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn modified_package_is_refused() {
    let key = TestKey::generate();
    let server = server_with("1.1.0", &key.sign(PAYLOAD, Some("1.1.0")), b"paquet modifie en chemin");
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert!(download(&update).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn old_signed_package_cannot_pass_for_a_newer_version() {
    // Signature valide d'une ancienne version, annoncée comme 9.9.9 (rétrogradation).
    let key = TestKey::generate();
    let server = server_with("9.9.9", &key.sign(PAYLOAD, Some("0.5.0")), PAYLOAD);
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert!(download(&update).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn signature_without_version_is_refused() {
    let key = TestKey::generate();
    let server = server_with("1.1.0", &key.sign(PAYLOAD, None), PAYLOAD);
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert!(download(&update).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn placeholder_public_key_never_installs_anything() {
    // Tant que la clé de production n'est pas fournie (PREP-01), aucun paquet n'est accepté.
    let key = TestKey::generate();
    let server = server_with("1.1.0", &key.sign(PAYLOAD, Some("1.1.0")), PAYLOAD);
    let app = build_app("A_REMPLACER_PAR_LA_CLE_PUBLIQUE", &server.url("/latest.json"));
    let update = check(&app).await.expect("vérification").expect("proposée");
    assert!(download(&update).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn unreachable_or_missing_manifest_is_an_error_not_a_panic() {
    let key = TestKey::generate();
    // Port fermé : on réserve un port puis on le libère.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("port");
        format!("http://{}/latest.json", listener.local_addr().expect("adresse"))
    };
    let app = build_app(&key.pubkey(), &closed);
    assert!(check(&app).await.is_err());

    // Serveur joignable mais latest.json absent (404).
    let server = Server::start();
    let app = build_app(&key.pubkey(), &server.url("/latest.json"));
    assert!(check(&app).await.is_err());
}
