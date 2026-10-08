//! K-TECH-01 (ADR 0008 §9) : connexion Google sur iPhone. Flux `authorize_ios` contre un Google simulé en mémoire et un faux du plugin
//! web-auth qui parle le JSON du contrat ; contrôle statique du Swift, de Rust et de la configuration. Aucun compte réel, aucun réseau.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use circletasks_lib::calendars::google::{self, pkce_challenge, GoogleEndpoints};
use circletasks_lib::calendars::http::HttpEnv;
use circletasks_lib::calendars::vault::{MemoryVault, SecretVault};
use circletasks_lib::calendars::web_auth::{self, authorize_ios, ios_redirect, parse_redirect, IosClientConfig, TransportWebAuth, WebAuthError, WebAuthRunner, WebAuthSession};
use circletasks_lib::sync::log;
use serde_json::Value;

use crate::support::fake_web_auth::{FakeWebAuth, CONTRACT};
use crate::support::http_mock::{raw_get_location, redirect, reply, start_mock, Mock};

const CLIENT_ID: &str = "123-abc.apps.googleusercontent.com";
const SCHEME: &str = "com.googleusercontent.apps.123-abc";
const REDIRECT: &str = "com.googleusercontent.apps.123-abc:/oauth2redirect";
const SECRET_CODE: &str = "code-tres-secret-777";

const SWIFT: &str = include_str!("../../plugins/web-auth/ios/Sources/WebAuthPlugin.swift");
const PLUGIN_LIB: &str = include_str!("../../plugins/web-auth/src/lib.rs");
const PLUGIN_BUILD: &str = include_str!("../../plugins/web-auth/build.rs");
const PACKAGE_SWIFT: &str = include_str!("../../plugins/web-auth/ios/Package.swift");
const WEB_AUTH_RS: &str = include_str!("../../src/calendars/web_auth.rs");
const MOD_RS: &str = include_str!("../../src/calendars/mod.rs");
const LIB_RS: &str = include_str!("../../src/lib.rs");
const CARGO: &str = include_str!("../../Cargo.toml");
const INFO_IOS_PLIST: &str = include_str!("../../Info.ios.plist");
const PLIST_CONTRACT: &str = include_str!("../../../scripts/ios/plist-contract.json");

// ------------------------------------------------------------------------------------------------------------------------------
// Google simulé
// ------------------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Consent {
    Grant,
    Deny,
    OtherError,
    WrongState,
    NoState,
    DoubleState,
    NoCode,
}

struct GoogleMock {
    mock: Mock,
    challenge: Arc<Mutex<String>>,
}

/// Autorisation (302 vers le schéma de l'app) et jeton (PKCE contrôlé, ID client contrôlé, **aucun secret accepté**).
fn start_google(consent: Consent) -> GoogleMock {
    let challenge = Arc::new(Mutex::new(String::new()));
    let shared = challenge.clone();
    let mock = start_mock(move |request| {
        let path = request.target.split('?').next().unwrap_or("");
        if path == "/o/oauth2/v2/auth" {
            let query = url::Url::parse(&format!("http://x{}", request.target)).unwrap();
            let get = |key: &str| query.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).unwrap_or_default();
            assert_eq!(get("client_id"), CLIENT_ID);
            assert_eq!(get("redirect_uri"), REDIRECT);
            *shared.lock().unwrap() = get("code_challenge");
            let mut target = url::Url::parse(&get("redirect_uri")).unwrap();
            let state = get("state");
            let params: Vec<(&str, String)> = match consent {
                Consent::Grant => vec![("code", SECRET_CODE.to_owned()), ("state", state)],
                Consent::Deny => vec![("error", "access_denied".to_owned()), ("state", state)],
                Consent::OtherError => vec![("error", "server_error".to_owned()), ("state", state)],
                Consent::WrongState => vec![("code", SECRET_CODE.to_owned()), ("state", "pirate".to_owned())],
                Consent::NoState => vec![("code", SECRET_CODE.to_owned())],
                Consent::DoubleState => vec![("code", SECRET_CODE.to_owned()), ("state", state.clone()), ("state", state)],
                Consent::NoCode => vec![("state", state)],
            };
            for (key, value) in params {
                target.query_pairs_mut().append_pair(key, &value);
            }
            return redirect(target.as_str());
        }
        if path == "/token" {
            let form = |key: &str| url::form_urlencoded::parse(request.body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
            if form("client_secret").is_some() || form("client_id").as_deref() != Some(CLIENT_ID) {
                return reply(401, "{\"error\":\"invalid_client\"}");
            }
            let verifier = form("code_verifier").unwrap_or_default();
            if form("code").as_deref() != Some(SECRET_CODE) || form("redirect_uri").as_deref() != Some(REDIRECT) || pkce_challenge(&verifier) != *shared.lock().unwrap() {
                return reply(400, "{\"error\":\"invalid_grant\"}");
            }
            return reply(200, "{\"access_token\":\"acc\",\"refresh_token\":\"ref\",\"expires_in\":3599}");
        }
        reply(404, "")
    });
    GoogleMock { mock, challenge }
}

/// Faux qui suit l'autorisation du simulateur : l'URL de retour est celle de sa redirection.
fn follow_google() -> FakeWebAuth {
    FakeWebAuth::new(|url, scheme| {
        assert_eq!(scheme, SCHEME);
        raw_get_location(url).ok_or_else(|| "failed".to_owned())
    })
}

fn ios_config() -> google::ClientConfig {
    IosClientConfig::from_value(Some(CLIENT_ID)).unwrap().into_client()
}

fn runner(fake: FakeWebAuth) -> Arc<dyn WebAuthRunner> {
    Arc::new(TransportWebAuth(fake))
}

struct Run {
    result: Result<(), String>,
    vault: MemoryVault,
    google: GoogleMock,
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

async fn run_with(consent: Consent, fake: FakeWebAuth) -> Run {
    let google_mock = start_google(consent);
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base(&google_mock.mock.base);
    let config = ios_config();
    let calls = fake.calls();
    let result = {
        let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
        authorize_ios(&env, "circletasks.calendar.google.a1", runner(fake), &WebAuthSession::new()).await
    };
    Run { result, vault, google: google_mock, calls }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 1 : schéma dérivé, URL d'autorisation, configuration
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn k_tech_01_1_the_scheme_is_derived_from_the_client_id() {
    assert_eq!(ios_redirect(CLIENT_ID), Some((SCHEME.to_owned(), REDIRECT.to_owned())));
    assert_eq!(ios_redirect("1234567890-abcdefghijklmnopqrstuv012345.apps.googleusercontent.com").unwrap().0, "com.googleusercontent.apps.1234567890-abcdefghijklmnopqrstuv012345");
}

#[test]
fn k_tech_01_1_a_malformed_or_missing_client_id_is_config_missing_and_nothing_is_built() {
    for bad in ["", "abc", "123.apps.googleusercontent.com", "-abc.apps.googleusercontent.com", "123-.apps.googleusercontent.com", "12a-abc.apps.googleusercontent.com", "123-ABC.apps.googleusercontent.com", "123-abc.apps.googleusercontent.com.evil.example", "123-abc.apps.googleusercontent.com/x", "123-a-b.apps.googleusercontent.com", "123-abc.apps.googleusercontent.com\n", "sim-client.apps.googleusercontent.com"] {
        assert_eq!(ios_redirect(bad), None, "{bad:?}");
    }
    assert!(IosClientConfig::from_value(None).is_none());
    assert!(IosClientConfig::from_value(Some("n'importe quoi")).is_none());
    // Une valeur de CI avec fin de ligne est acceptée une fois nettoyée.
    assert!(IosClientConfig::from_value(Some("123-abc.apps.googleusercontent.com\n")).is_some());
    assert!(IosClientConfig::from_value(Some(CLIENT_ID)).unwrap().into_client().client_secret.is_none());
}

#[tokio::test]
async fn k_tech_01_1_config_missing_runs_nothing_and_writes_nothing() {
    for client in [None, Some(google::ClientConfig { client_id: "client-test".to_owned(), client_secret: None }), Some(google::ClientConfig { client_id: "sim-client.apps.googleusercontent.com".to_owned(), client_secret: Some("x".to_owned()) })] {
        let vault = MemoryVault::default();
        let endpoints = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
        let fake = follow_google();
        let calls = fake.calls();
        let env = HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() };
        let error = authorize_ios(&env, "r", runner(fake), &WebAuthSession::new()).await.unwrap_err();
        assert_eq!(error, "config-missing");
        assert!(calls.lock().unwrap().is_empty(), "la feuille ne s'ouvre pas");
        assert_eq!(vault.get("r").unwrap(), None);
    }
}

#[tokio::test]
async fn k_tech_01_1_the_authorization_url_asks_read_only_with_pkce_s256_and_a_random_state() {
    let first = run_with(Consent::Grant, follow_google()).await;
    let second = run_with(Consent::Grant, follow_google()).await;
    assert_eq!(first.result, Ok(()));
    let parse = |run: &Run| -> BTreeMap<String, String> {
        let (url, scheme) = run.calls.lock().unwrap()[0].clone();
        assert_eq!(scheme, SCHEME);
        url::Url::parse(&url).unwrap().query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    };
    let (a, b) = (parse(&first), parse(&second));
    assert_eq!(a["scope"], "https://www.googleapis.com/auth/calendar.readonly");
    assert_eq!(a["code_challenge_method"], "S256");
    assert_eq!(a["response_type"], "code");
    assert_eq!(a["redirect_uri"], REDIRECT);
    assert_eq!(a["client_id"], CLIENT_ID);
    assert!(!a["code_challenge"].is_empty() && a["code_challenge"] == *first.google.challenge.lock().unwrap());
    assert!(a["state"].len() >= 32);
    assert_ne!(a["state"], b["state"], "state aléatoire");
    assert_ne!(a["code_challenge"], b["code_challenge"], "vérificateur aléatoire");
    assert!(!a.contains_key("client_secret") && !a.contains_key("code_verifier"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 2 : échange sans secret, coffre, rejets
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn k_tech_01_2_the_code_is_exchanged_without_a_secret_and_tokens_go_to_the_vault() {
    let run = run_with(Consent::Grant, follow_google()).await;
    assert_eq!(run.result, Ok(()));
    let tokens = google::load_tokens(&run.vault, "circletasks.calendar.google.a1").unwrap();
    assert_eq!((tokens.access.as_str(), tokens.refresh.as_str()), ("acc", "ref"));
    assert!(tokens.expires_at > google::now_secs() + 3000);
    let exchange = run.google.mock.requests_to("/token");
    assert_eq!(exchange.len(), 1);
    assert!(!exchange[0].body.contains("client_secret"));
    assert!(exchange[0].body.contains("code_verifier="));
}

#[tokio::test]
async fn k_tech_01_2_a_falsified_return_url_is_rejected_before_anything_else_and_writes_nothing() {
    for (consent, expected) in [
        (Consent::WrongState, "state-mismatch"),
        (Consent::NoState, "state-mismatch"),
        (Consent::DoubleState, "state-mismatch"),
        (Consent::Deny, "cancelled"),
        (Consent::OtherError, "web-auth-failed"),
        (Consent::NoCode, "web-auth-failed"),
    ] {
        let run = run_with(consent, follow_google()).await;
        assert_eq!(run.result, Err(expected.to_owned()));
        assert_eq!(run.vault.get("circletasks.calendar.google.a1").unwrap(), None);
        assert!(run.google.mock.requests_to("/token").is_empty(), "aucun échange de code");
    }
}

#[tokio::test]
async fn k_tech_01_2_a_return_url_of_another_scheme_or_path_is_a_failure() {
    for callback in [
        "evil.app:/oauth2redirect?code=c&state=s",
        "com.googleusercontent.apps.123-abc:/autre?code=c&state=s",
        "com.googleusercontent.apps.123-abc://oauth2redirect?code=c&state=s",
        "com.googleusercontent.apps.123-abc:/oauth2redirectx?code=c&state=s",
        "https://127.0.0.1/oauth2redirect?code=c&state=s",
        "",
    ] {
        assert_eq!(parse_redirect(callback, REDIRECT, "s"), Err("web-auth-failed".to_owned()), "{callback}");
    }
    assert_eq!(parse_redirect("com.googleusercontent.apps.123-abc:/oauth2redirect?code=c&state=s", REDIRECT, "s"), Ok("c".to_owned()));
    assert_eq!(parse_redirect("com.googleusercontent.apps.123-abc:/oauth2redirect?state=s&code=a%2Fb", REDIRECT, "s"), Ok("a/b".to_owned()));
    // Le `state` prime : une erreur avec un mauvais `state` est un `state-mismatch`, jamais un « annulé ».
    assert_eq!(parse_redirect("com.googleusercontent.apps.123-abc:/oauth2redirect?error=access_denied&state=x", REDIRECT, "s"), Err("state-mismatch".to_owned()));
    assert_eq!(parse_redirect("com.googleusercontent.apps.123-abc:/oauth2redirect?error=access_denied&state=s", REDIRECT, "s"), Err("cancelled".to_owned()));
    assert_eq!(parse_redirect("com.googleusercontent.apps.123-abc:/oauth2redirect?code=&state=s", REDIRECT, "s"), Err("web-auth-failed".to_owned()));
}

#[tokio::test]
async fn k_tech_01_2_plugin_rejections_map_to_distinct_codes_and_write_nothing() {
    for (plugin_code, expected) in [("cancelled", "cancelled"), ("unavailable", "web-auth-unavailable"), ("failed", "web-auth-failed"), ("code-inconnu", "web-auth-failed"), ("", "web-auth-failed")] {
        let code = plugin_code.to_owned();
        let run = run_with(Consent::Grant, FakeWebAuth::new(move |_, _| Err(code.clone()))).await;
        assert_eq!(run.result, Err(expected.to_owned()), "{plugin_code}");
        assert_eq!(run.vault.get("circletasks.calendar.google.a1").unwrap(), None);
        assert!(run.google.mock.requests_to("/token").is_empty());
    }
    assert_ne!(WebAuthError::Unavailable.code(), WebAuthError::Failed.code(), "messages distincts côté écran");
}

#[tokio::test]
async fn k_tech_01_2_a_google_token_error_after_a_good_return_writes_nothing() {
    // Google refuse l'échange (code inconnu) : aucun jeton rangé.
    let run = run_with(Consent::Grant, FakeWebAuth::new(|url, _| {
        let mut target = url::Url::parse(REDIRECT).unwrap();
        let state = url::Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.into_owned()).unwrap();
        target.query_pairs_mut().append_pair("code", "code-refuse").append_pair("state", &state);
        Ok(target.to_string())
    }))
    .await;
    assert_eq!(run.result, Err("cancelled".to_owned()));
    assert_eq!(run.vault.get("circletasks.calendar.google.a1").unwrap(), None);
}

#[tokio::test]
async fn k_tech_01_2_only_one_session_at_a_time() {
    let google_mock = start_google(Consent::Grant);
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base(&google_mock.mock.base);
    let config = ios_config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let session = WebAuthSession::new();
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let started_tx = Mutex::new(started_tx);
    let release_rx = Mutex::new(release_rx);
    let blocking = FakeWebAuth::new(move |url, _| {
        started_tx.lock().unwrap().send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
        raw_get_location(url).ok_or_else(|| "failed".to_owned())
    });
    let first = authorize_ios(&env, "circletasks.calendar.google.a1", runner(blocking), &session);
    let second = async {
        started_rx.recv().unwrap();
        let rejected = authorize_ios(&env, "circletasks.calendar.google.a2", runner(follow_google()), &session).await;
        release_tx.send(()).unwrap();
        rejected
    };
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first, Ok(()));
    assert_eq!(second, Err("web-auth-unavailable".to_owned()));
    assert_eq!(vault.get("circletasks.calendar.google.a2").unwrap(), None);
    // La garde est libérée : une session suivante réussit.
    assert_eq!(authorize_ios(&env, "circletasks.calendar.google.a3", runner(follow_google()), &session).await, Ok(()));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 5 : ni l'URL, ni le code, ni l'ID client dans les journaux, les erreurs ou l'état
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn k_tech_01_5_neither_url_nor_code_nor_client_id_leaks_into_errors_or_the_technical_log() {
    let capture = log::capture();
    let mut outputs: Vec<String> = Vec::new();
    for consent in [Consent::Grant, Consent::WrongState, Consent::Deny, Consent::OtherError, Consent::NoCode] {
        let run = run_with(consent, follow_google()).await;
        outputs.push(format!("{:?}", run.result));
    }
    for plugin_code in ["cancelled", "unavailable", "failed", "https://accounts.google.com/?code=code-tres-secret-777"] {
        let code = plugin_code.to_owned();
        let run = run_with(Consent::Grant, FakeWebAuth::new(move |_, _| Err(code.clone()))).await;
        outputs.push(format!("{:?}", run.result));
    }
    // Configuration absente ou invalide.
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
    let bad = google::ClientConfig { client_id: "999-secretclient.apps.googleusercontent.com.x".to_owned(), client_secret: None };
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&bad) };
    outputs.push(format!("{:?}", authorize_ios(&env, "r", runner(follow_google()), &WebAuthSession::new()).await));
    outputs.push(format!("{:?}", IosClientConfig::from_value(Some(CLIENT_ID))));
    outputs.push(format!("{:?}", ios_config()));
    outputs.extend(capture.lines());
    assert!(capture.lines().iter().any(|line| line.contains("web-auth")), "les échecs sont consignés (codes seuls)");
    for text in &outputs {
        for secret in [SECRET_CODE, CLIENT_ID, "123-abc", "accounts.google.com", "oauth2redirect", "code_challenge", "pirate", "secretclient"] {
            assert!(!text.contains(secret), "« {secret} » dans « {text} »");
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 3 : contrôle statique (Swift, Rust, contrat, capabilities, Cargo)
// ------------------------------------------------------------------------------------------------------------------------------

/// Lignes du Swift sans commentaires `//` (hors chaîne).
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

fn contract() -> Value {
    serde_json::from_str(CONTRACT).unwrap()
}

fn strings(value: &Value) -> BTreeSet<String> {
    value.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect()
}

#[test]
fn k_tech_01_3_the_declared_command_exists_on_both_sides_with_the_same_fields() {
    let contract = contract();
    assert_eq!(contract["plugin"], "web-auth");
    let commands = contract["commands"].as_array().unwrap();
    assert_eq!(commands.len(), 1, "une seule commande");
    let command = &commands[0];
    let name = command["name"].as_str().unwrap();
    assert_eq!(name, command["swiftMethod"].as_str().unwrap());
    assert_eq!(name, web_auth::PLUGIN_COMMAND, "nom appelé par Rust");
    let code = swift_code();
    // Méthodes exposées : exactement celle du contrat.
    let methods: BTreeSet<String> = code.match_indices("@objc public func ").map(|(i, _)| code[i + "@objc public func ".len()..].split('(').next().unwrap().to_owned()).collect();
    assert_eq!(methods, BTreeSet::from([name.to_owned()]));
    assert!(code.contains(&format!("@objc public func {name}(_ invoke: Invoke)")));
    // Champs d'entrée : structure Decodable.
    let start = code.find("struct AuthenticateArgs: Decodable {").unwrap();
    let body = &code[start..start + code[start..].find('}').unwrap()];
    let fields: BTreeSet<String> = body.lines().filter_map(|l| l.trim().strip_prefix("let ")).map(|l| l.split(':').next().unwrap().trim().to_owned()).collect();
    assert_eq!(fields, strings(&command["input"]));
    // Champs de sortie : clés du `resolve`.
    let resolve = code.find("invoke.resolve([").unwrap();
    let keys: BTreeSet<String> = code[resolve..resolve + code[resolve..].find("])").unwrap()].split('"').skip(1).step_by(2).map(str::to_owned).collect();
    assert_eq!(keys, strings(&command["output"]));
    // Côté Rust : les champs envoyés (le faux les compare au contrat à chaque appel) et lus.
    for field in strings(&command["input"]) {
        assert!(WEB_AUTH_RS.contains(&format!("\"{field}\"")), "{field} côté Rust");
    }
    for field in strings(&command["output"]) {
        assert!(WEB_AUTH_RS.contains(&format!("\"{field}\"")), "{field} côté Rust");
    }
    // Le plugin hors iOS rend `unavailable`, jamais un texte.
    assert!(PLUGIN_LIB.contains("Err(\"unavailable\".to_owned())"));
}

#[test]
fn k_tech_01_3_every_swift_error_code_is_known_to_rust_and_nothing_else_is_rejected() {
    let errors = strings(&contract()["errors"]);
    assert_eq!(errors, BTreeSet::from(["cancelled".to_owned(), "unavailable".to_owned(), "failed".to_owned()]));
    let code = swift_code();
    // Valeurs de l'énumération Swift.
    let start = code.find("private enum Code: String {").unwrap();
    let body = &code[start..start + code[start..].find("\n}").unwrap()];
    let swift_codes: BTreeSet<String> = body.lines().filter_map(|l| l.split('"').nth(1)).map(str::to_owned).collect();
    assert_eq!(swift_codes, errors);
    // Tout rejet passe par `reject(invoke, .x)` / `invoke.reject(code.rawValue, code: code.rawValue)` : aucun texte libre.
    assert_eq!(code.matches("invoke.reject(").count(), 1);
    assert!(code.contains("invoke.reject(code.rawValue, code: code.rawValue)"));
    // Rust distingue les trois codes.
    let mapped: BTreeSet<&str> = errors.iter().map(|code| WebAuthError::from_plugin_code(code).code()).collect();
    assert_eq!(mapped, BTreeSet::from(["cancelled", "web-auth-unavailable", "web-auth-failed"]));
}

#[test]
fn k_tech_01_3_swift_has_no_french_text_no_log_and_the_expected_session_settings() {
    for literal in swift_literals() {
        assert!(literal.is_ascii() && !literal.contains(' '), "chaîne d'interface en Swift : « {literal} »");
    }
    let code = swift_code();
    assert!(code.contains("prefersEphemeralWebBrowserSession = false"), "session partagée avec Safari");
    assert!(code.contains("ASWebAuthenticationSession(url: url, callbackURLScheme: input.callbackScheme)"));
    assert!(code.contains("presentationContextProvider = presentation"));
    assert!(code.contains("self.manager.viewController?.view.window"), "ancre = fenêtre active de l'app");
    assert!(code.contains(".canceledLogin"), "fermeture de la feuille = cancelled");
    // Ni l'URL ni l'URL de retour ne sont journalisées.
    for forbidden in ["print(", "NSLog", "os_log", "Logger(", "debugPrint", "dump("] {
        assert!(!code.contains(forbidden), "{forbidden}");
    }
    // Le schéma de l'URL rendue est contrôlé.
    assert!(code.contains("returned.scheme?.lowercased() == callbackScheme.lowercased()"));
}

#[test]
fn k_tech_01_3_no_capability_grants_the_plugin_and_the_crate_is_an_ios_only_dependency() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|x| x == "json") {
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(!text.contains("web-auth:"), "{}", path.display());
        }
    }
    assert!(PLUGIN_BUILD.contains("const COMMANDS: &[&str] = &[];"), "aucune commande, donc aucune permission générée");
    let ios_deps = &CARGO[CARGO.find("[target.'cfg(target_os = \"ios\")'.dependencies]").unwrap()..];
    let ios_deps = &ios_deps[..ios_deps[1..].find("\n[").map_or(ios_deps.len(), |i| i + 1)];
    assert!(ios_deps.contains("tauri-plugin-web-auth = { path = \"plugins/web-auth\" }"));
    assert_eq!(CARGO.matches("tauri-plugin-web-auth").count(), 1, "aucune autre cible");
    assert!(LIB_RS.contains("#[cfg(target_os = \"ios\")]\n    let builder = builder.plugin(tauri_plugin_folder_bookmark::init()).plugin(tauri_plugin_web_auth::init())"));
    assert_eq!(LIB_RS.matches("tauri_plugin_web_auth").count(), 1);
    // Les usages du crate dans l'app sont sous cfg(target_os = "ios").
    assert!(WEB_AUTH_RS.contains("#[cfg(target_os = \"ios\")]\npub struct PluginTransport<R: tauri::Runtime>(pub tauri_plugin_web_auth::WebAuth<R>);"));
    assert!(MOD_RS.contains("#[cfg(target_os = \"ios\")]\n#[tauri::command]\npub async fn calendar_oauth_google_authorize(app: tauri::AppHandle, token_ref: String)"));
    assert_eq!(MOD_RS.matches("tauri_plugin_web_auth").count(), 1);
}

#[test]
fn k_tech_01_3_package_swift_uses_a_platform_known_to_its_tools_version() {
    assert!(PACKAGE_SWIFT.starts_with("// swift-tools-version:5.3"));
    assert!(PACKAGE_SWIFT.contains(".iOS(.v14)"));
    for unknown in [".v15", ".v16", ".v17", ".v18"] {
        assert!(!PACKAGE_SWIFT.contains(unknown), "{unknown} n'existe pas en swift-tools-version 5.3");
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 8 (partie locale) : aucune clé Info.plist, ID client iOS compilé
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn k_tech_01_8_no_info_plist_key_is_added_for_the_redirect_scheme() {
    assert!(!INFO_IOS_PLIST.contains("CFBundleURLTypes"), "le schéma intercepté par la session n'a pas à être enregistré");
    assert!(!INFO_IOS_PLIST.contains("googleusercontent"));
    assert!(!PLIST_CONTRACT.contains("web-auth") && !PLIST_CONTRACT.contains("googleusercontent"));
}

#[test]
fn k_tech_01_8_the_ios_client_id_is_read_with_option_env_and_mixed_with_no_secret() {
    assert!(WEB_AUTH_RS.contains("option_env!(\"CT_GOOGLE_IOS_CLIENT_ID\")"));
    assert!(include_str!("../../build.rs").contains("\"CT_GOOGLE_IOS_CLIENT_ID\""));
    let google = include_str!("../../src/calendars/google.rs");
    assert!(google.contains("#[cfg(target_os = \"ios\")]\n        return super::web_auth::IosClientConfig::from_environment().map(super::web_auth::IosClientConfig::into_client);"));
}
