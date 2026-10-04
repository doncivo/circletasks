//! Agendas externes (K-01 à K-03, ADR 0008) : `calendar_http` (hôtes autorisés, redirections, ajout de `Authorization`, refresh
//! Google), flux OAuth PKCE en boucle locale et coffre, contre des serveurs simulés en mémoire (aucun compte réel, aucun réseau).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use circletasks_lib::calendars::google::{self, build_auth_url, parse_callback, pkce_challenge, Callback, ClientConfig, GoogleEndpoints, GoogleTokens};
use circletasks_lib::calendars::http::{execute, HttpEnv};
use circletasks_lib::calendars::vault::{MemoryVault, SecretVault};
use circletasks_lib::calendars::{HttpAuth, HttpRequest};

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    target: String,
    headers: BTreeMap<String, String>,
    body: String,
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn reply(status: u16, body: &str) -> Reply {
    Reply { status, headers: vec![], body: body.to_owned() }
}

fn redirect(status: u16, location: &str) -> Reply {
    Reply { status, headers: vec![("Location".to_owned(), location.to_owned())], body: String::new() }
}

struct Mock {
    base: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
}

impl Mock {
    fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&chunk[..read]);
        if let Some(position) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: BTreeMap<String, String> = lines.filter_map(|line| line.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while data.len() < head_end + length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&data[head_end..]).to_string();
    Some(Recorded { method, target, headers, body })
}

fn start_mock(handler: impl Fn(&Recorded) -> Reply + Send + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_thread = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(request) = read_request(&mut stream) else { continue };
            seen_thread.lock().unwrap().push(request.clone());
            let answer = handler(&request);
            let mut text = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", answer.status, answer.body.len());
            for (name, value) in &answer.headers {
                text.push_str(&format!("{name}: {value}\r\n"));
            }
            text.push_str("\r\n");
            text.push_str(&answer.body);
            let _ = stream.write_all(text.as_bytes());
        }
    });
    Mock { base, seen }
}

/// Navigateur simulé : GET brut, rend (statut, en-tête Location).
fn raw_get(url: &str) -> (u16, Option<String>) {
    let parsed = url::Url::parse(url).unwrap();
    let mut stream = TcpStream::connect((parsed.host_str().unwrap(), parsed.port().unwrap())).unwrap();
    let target = format!("{}{}", parsed.path(), parsed.query().map(|q| format!("?{q}")).unwrap_or_default());
    write!(stream, "GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    let mut text = String::new();
    let _ = stream.read_to_string(&mut text);
    let status = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let location = text.lines().find_map(|line| line.strip_prefix("Location: ").or_else(|| line.strip_prefix("location: "))).map(str::to_owned);
    (status, location)
}

fn config() -> ClientConfig {
    ClientConfig { client_id: "client-test".to_owned(), client_secret: None }
}

fn request(method: &str, url: &str, auth: HttpAuth) -> HttpRequest {
    HttpRequest { method: method.to_owned(), url: url.to_owned(), headers: BTreeMap::new(), body: None, auth, timeout_ms: Some(5000) }
}

fn google_auth(token_ref: &str) -> HttpAuth {
    HttpAuth::GoogleOauth { token_ref: token_ref.to_owned() }
}

fn put_tokens(vault: &MemoryVault, token_ref: &str, access: &str, expires_in: i64) {
    let tokens = GoogleTokens { refresh: "refresh-1".to_owned(), access: access.to_owned(), expires_at: google::now_secs() + expires_in };
    google::store_tokens(vault, token_ref, &tokens).unwrap();
}

fn form_value(body: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

#[tokio::test]
async fn refuse_les_hotes_hors_liste_et_http_hors_boucle_locale() {
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::production();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    for url in ["https://evil.example/x", "http://www.googleapis.com/calendar/v3", "https://caldav.icloud.com.evil.example/", "file:///etc/passwd"] {
        let error = execute(&env, request("GET", url, google_auth("r"))).await.unwrap_err();
        assert_eq!(error, "host-not-allowed", "{url}");
    }
}

#[tokio::test]
async fn refuse_un_en_tete_authorization_fourni_par_la_webview() {
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::production();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    let mut req = request("GET", "https://www.googleapis.com/calendar/v3/users/me/calendarList", google_auth("r"));
    req.headers.insert("Authorization".to_owned(), "Bearer vole".to_owned());
    assert_eq!(execute(&env, req).await.unwrap_err(), "unsupported");
    let req = request("DELETE", "https://www.googleapis.com/x", google_auth("r"));
    assert_eq!(execute(&env, req).await.unwrap_err(), "unsupported");
}

#[tokio::test]
async fn basic_ajoute_l_identifiant_et_le_mot_de_passe_du_coffre() {
    let mock = start_mock(|_| reply(207, "<multistatus/>"));
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::production();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    let basic = HttpAuth::Basic { token_ref: "ref-icloud".to_owned(), username: "ali@icloud.com".to_owned() };
    let mut req = request("PROPFIND", &format!("{}/", mock.base), basic);
    req.headers.insert("Depth".to_owned(), "0".to_owned());
    req.body = Some("<propfind/>".to_owned());
    assert_eq!(execute(&env, req.clone()).await.unwrap_err(), "secret-missing");
    vault.set("ref-icloud", "abcd-efgh").unwrap();
    let response = execute(&env, req).await.unwrap();
    assert_eq!(response.status, 207);
    assert_eq!(response.body, "<multistatus/>");
    let seen = mock.requests();
    assert_eq!(seen[0].method, "PROPFIND");
    assert_eq!(seen[0].headers["depth"], "0");
    assert_eq!(seen[0].body, "<propfind/>");
    assert_eq!(seen[0].headers["authorization"], format!("Basic {}", STANDARD.encode("ali@icloud.com:abcd-efgh")));
}

#[tokio::test]
async fn les_erreurs_http_sont_des_reponses_avec_leurs_en_tetes() {
    let mock = start_mock(|_| Reply { status: 429, headers: vec![("Retry-After".to_owned(), "30".to_owned())], body: "{}".to_owned() });
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    let response = execute(&env, request("GET", &format!("{}/calendar/v3/x", mock.base), google_auth("r"))).await.unwrap();
    assert_eq!(response.status, 429);
    assert_eq!(response.headers["retry-after"], "30");
}

#[tokio::test]
async fn google_ajoute_bearer_sans_rafraichir_tant_que_le_jeton_est_valide() {
    let mock = start_mock(|_| reply(200, "{\"items\":[]}"));
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    execute(&env, request("GET", &format!("{}/calendar/v3/users/me/calendarList", mock.base), google_auth("r"))).await.unwrap();
    let seen = mock.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].headers["authorization"], "Bearer access-1");
}

#[tokio::test]
async fn google_rafraichit_un_jeton_expire_puis_le_range_au_coffre() {
    let mock = start_mock(|request| if request.target == "/token" { reply(200, "{\"access_token\":\"access-2\",\"expires_in\":3599}") } else { reply(200, "{}") });
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", -10);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    execute(&env, request("GET", &format!("{}/calendar/v3/users/me/calendarList", mock.base), google_auth("r"))).await.unwrap();
    let seen = mock.requests();
    assert_eq!(seen[0].target, "/token");
    assert_eq!(form_value(&seen[0].body, "grant_type").as_deref(), Some("refresh_token"));
    assert_eq!(form_value(&seen[0].body, "refresh_token").as_deref(), Some("refresh-1"));
    assert_eq!(form_value(&seen[0].body, "client_id").as_deref(), Some("client-test"));
    assert_eq!(seen[1].headers["authorization"], "Bearer access-2");
    let stored = google::load_tokens(&vault, "r").unwrap();
    assert_eq!((stored.access.as_str(), stored.refresh.as_str()), ("access-2", "refresh-1"));
}

#[tokio::test]
async fn google_sur_401_rafraichit_une_fois_puis_reessaie_une_fois() {
    let mock = start_mock(|request| {
        if request.target == "/token" {
            reply(200, "{\"access_token\":\"access-2\",\"expires_in\":3599}")
        } else if request.headers.get("authorization").map(String::as_str) == Some("Bearer access-2") {
            reply(200, "{\"ok\":true}")
        } else {
            reply(401, "{}")
        }
    });
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    let response = execute(&env, request("GET", &format!("{}/calendar/v3/x", mock.base), google_auth("r"))).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(mock.requests().len(), 3);
}

#[tokio::test]
async fn google_401_persistant_ou_invalid_grant_demande_de_reconnecter_sans_boucle() {
    let mock = start_mock(|request| if request.target == "/token" { reply(200, "{\"access_token\":\"access-2\",\"expires_in\":3599}") } else { reply(401, "{}") });
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    let url = format!("{}/calendar/v3/x", mock.base);
    assert_eq!(execute(&env, request("GET", &url, google_auth("r"))).await.unwrap_err(), "reauth-required");
    assert_eq!(mock.requests().len(), 3);

    let revoked = start_mock(|request| if request.target == "/token" { reply(400, "{\"error\":\"invalid_grant\"}") } else { reply(401, "{}") });
    put_tokens(&vault, "r", "access-1", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&revoked.base);
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    let url = format!("{}/calendar/v3/x", revoked.base);
    assert_eq!(execute(&env, request("GET", &url, google_auth("r"))).await.unwrap_err(), "reauth-required");
    assert_eq!(revoked.requests().len(), 2);
}

#[tokio::test]
async fn google_sans_secret_ou_sans_configuration() {
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::production();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    let url = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
    assert_eq!(execute(&env, request("GET", url, google_auth("absent"))).await.unwrap_err(), "secret-missing");
    put_tokens(&vault, "r", "access-1", -10);
    assert_eq!(execute(&env, request("GET", url, google_auth("r"))).await.unwrap_err(), "config-missing");
}

#[tokio::test]
async fn les_redirections_gardent_la_methode_et_restent_dans_la_liste() {
    let mock = start_mock(|request| match request.target.as_str() {
        "/.well-known/caldav" => redirect(301, "/"),
        "/evil" => redirect(302, "https://evil.example/steal"),
        _ => reply(207, "ok"),
    });
    let vault = MemoryVault::default();
    vault.set("ref", "pw").unwrap();
    let endpoints = GoogleEndpoints::production();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    let basic = HttpAuth::Basic { token_ref: "ref".to_owned(), username: "u".to_owned() };
    let response = execute(&env, request("PROPFIND", &format!("{}/.well-known/caldav", mock.base), basic.clone())).await.unwrap();
    assert_eq!(response.status, 207);
    let seen = mock.requests();
    assert_eq!((seen[0].method.as_str(), seen[1].method.as_str(), seen[1].target.as_str()), ("PROPFIND", "PROPFIND", "/"));
    assert_eq!(execute(&env, request("GET", &format!("{}/evil", mock.base), basic)).await.unwrap_err(), "host-not-allowed");
}

#[test]
fn pkce_suit_le_vecteur_de_la_rfc_7636() {
    assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    let verifier = google::random_verifier();
    assert!((43..=128).contains(&verifier.len()));
    assert_ne!(google::random_state(), google::random_state());
}

#[test]
fn l_url_de_consentement_demande_la_lecture_seule_en_pkce_s256() {
    let endpoints = GoogleEndpoints::production();
    let url = build_auth_url(&endpoints, "cid", "http://127.0.0.1:5555/", "st", "ch").unwrap();
    let parsed = url::Url::parse(&url).unwrap();
    let pairs: BTreeMap<String, String> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    assert_eq!(parsed.host_str(), Some("accounts.google.com"));
    assert_eq!(pairs["scope"], "https://www.googleapis.com/auth/calendar.readonly");
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(pairs["state"], "st");
    assert!(!pairs.contains_key("client_secret") && !pairs.contains_key("code_verifier"));
}

#[test]
fn analyse_de_la_redirection_locale() {
    assert_eq!(parse_callback("GET /?code=abc&state=s1 HTTP/1.1", "s1"), Callback::Code("abc".to_owned()));
    assert_eq!(parse_callback("GET /?code=abc&state=autre HTTP/1.1", "s1"), Callback::Failure("state-mismatch"));
    assert_eq!(parse_callback("GET /?code=abc HTTP/1.1", "s1"), Callback::Failure("state-mismatch"));
    assert_eq!(parse_callback("GET /?error=access_denied&state=s1 HTTP/1.1", "s1"), Callback::Failure("cancelled"));
    assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", "s1"), Callback::Ignore);
    assert_eq!(parse_callback("POST /?code=abc&state=s1 HTTP/1.1", "s1"), Callback::Ignore);
}

/// Serveur Google simulé : consentement (302 vers la boucle locale), échange de code avec contrôle PKCE.
struct GoogleMock {
    mock: Mock,
    challenge: Arc<Mutex<String>>,
}

fn start_google(deny: bool, wrong_state: bool) -> GoogleMock {
    let challenge = Arc::new(Mutex::new(String::new()));
    let shared = challenge.clone();
    let mock = start_mock(move |request| {
        let path = request.target.split('?').next().unwrap_or("");
        if path == "/o/oauth2/v2/auth" {
            let query = url::Url::parse(&format!("http://x{}", request.target)).unwrap();
            let get = |key: &str| query.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).unwrap_or_default();
            assert_eq!(get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
            assert_eq!(get("code_challenge_method"), "S256");
            assert_eq!(get("client_id"), "client-test");
            *shared.lock().unwrap() = get("code_challenge");
            let mut target = url::Url::parse(&get("redirect_uri")).unwrap();
            let state = if wrong_state { "pirate".to_owned() } else { get("state") };
            if deny {
                target.query_pairs_mut().append_pair("error", "access_denied").append_pair("state", &state);
            } else {
                target.query_pairs_mut().append_pair("code", "code-1").append_pair("state", &state);
            }
            return redirect(302, target.as_str());
        }
        if path == "/token" {
            let verifier = form_value(&request.body, "code_verifier").unwrap_or_default();
            if form_value(&request.body, "code").as_deref() != Some("code-1") || pkce_challenge(&verifier) != *shared.lock().unwrap() {
                return reply(400, "{\"error\":\"invalid_grant\"}");
            }
            return reply(200, "{\"access_token\":\"acc\",\"refresh_token\":\"ref\",\"expires_in\":3599}");
        }
        if path == "/revoke" {
            return reply(200, "{}");
        }
        reply(404, "")
    });
    GoogleMock { mock, challenge }
}

fn browser(url: &str) -> Result<(), String> {
    let url = url.to_owned();
    std::thread::spawn(move || {
        let (_, location) = raw_get(&url);
        if let Some(location) = location {
            raw_get(&location);
        }
    });
    Ok(())
}

#[tokio::test]
async fn oauth_boucle_locale_range_les_jetons_au_coffre_apres_verification_pkce() {
    let google_mock = start_google(false, false);
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base(&google_mock.mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    google::authorize(&env, "circletasks.calendar.a1", browser, Duration::from_secs(10)).await.unwrap();
    let tokens = google::load_tokens(&vault, "circletasks.calendar.a1").unwrap();
    assert_eq!((tokens.access.as_str(), tokens.refresh.as_str()), ("acc", "ref"));
    assert!(tokens.expires_at > google::now_secs() + 3000);
    assert!(!google_mock.challenge.lock().unwrap().is_empty());
}

#[tokio::test]
async fn oauth_refus_ou_state_different_n_enregistre_rien() {
    for (deny, wrong_state, expected) in [(true, false, "cancelled"), (false, true, "state-mismatch")] {
        let google_mock = start_google(deny, wrong_state);
        let vault = MemoryVault::default();
        let endpoints = GoogleEndpoints::from_sim_base(&google_mock.mock.base);
        let cfg = config();
        let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
        let error = google::authorize(&env, "r", browser, Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(vault.get("r").unwrap(), None);
    }
}

#[tokio::test]
async fn oauth_delai_depasse_et_configuration_absente() {
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    assert_eq!(google::authorize(&env, "r", |_| Ok(()), Duration::from_millis(150)).await.unwrap_err(), "timeout");
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    assert_eq!(google::authorize(&env, "r", |_| Ok(()), Duration::from_millis(150)).await.unwrap_err(), "config-missing");
}

#[tokio::test]
async fn revocation_au_mieux_puis_effacement_meme_si_google_est_injoignable() {
    let google_mock = start_google(false, false);
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "acc", 3000);
    let endpoints = GoogleEndpoints::from_sim_base(&google_mock.mock.base);
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    google::revoke(&env, "r").await.unwrap();
    assert_eq!(vault.get("r").unwrap(), None);
    let seen = google_mock.mock.requests();
    assert_eq!(seen[0].target, "/revoke");
    assert_eq!(form_value(&seen[0].body, "token").as_deref(), Some("refresh-1"));

    put_tokens(&vault, "r2", "acc", 3000);
    let down = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
    let env = HttpEnv { vault: &vault, google: &down, client: None };
    google::revoke(&env, "r2").await.unwrap();
    assert_eq!(vault.get("r2").unwrap(), None);
    // Idempotent.
    google::revoke(&env, "r2").await.unwrap();
}

#[test]
fn les_secrets_n_apparaissent_pas_dans_le_debug_de_la_configuration() {
    let cfg = ClientConfig { client_id: "id-secret-123".to_owned(), client_secret: Some("shh-456".to_owned()) };
    let shown = format!("{cfg:?}");
    assert!(!shown.contains("id-secret-123") && !shown.contains("shh-456"));
}

#[test]
fn liste_des_hotes_de_production() {
    use circletasks_lib::calendars::hosts::is_allowed;
    assert!(is_allowed("https", "accounts.google.com", false));
    assert!(is_allowed("https", "p42-caldav.icloud.com", false));
    assert!(!is_allowed("https", "evil-caldav.icloud.com", false));
    assert!(!is_allowed("http", "127.0.0.1", false));
    assert!(is_allowed("http", "127.0.0.1", true));
}

/// Coffre réel de Windows (Gestionnaire d'identification) : écriture, lecture, effacement idempotent d'une entrée d'essai.
#[cfg(windows)]
#[test]
fn le_coffre_systeme_range_lit_et_efface() {
    use circletasks_lib::calendars::vault::SystemVault;
    let vault = SystemVault;
    let token_ref = format!("circletasks.calendar.test-{}", std::process::id());
    assert_eq!(vault.get(&token_ref).unwrap(), None);
    vault.set(&token_ref, "{\"refresh\":\"r\",\"access\":\"a\",\"expires_at\":1}").unwrap();
    assert_eq!(vault.get(&token_ref).unwrap().as_deref(), Some("{\"refresh\":\"r\",\"access\":\"a\",\"expires_at\":1}"));
    vault.delete(&token_ref).unwrap();
    vault.delete(&token_ref).unwrap();
    assert_eq!(vault.get(&token_ref).unwrap(), None);
}

// ---- QA du lot K : jetons expirés, réseau coupé, réponses malformées, aucun secret dans les erreurs ----

fn assert_no_secret(text: &str) {
    for secret in ["access-1", "access-2", "refresh-1", "client-test"] {
        assert!(!text.contains(secret), "secret « {secret} » dans : {text}");
    }
}

#[tokio::test]
async fn k01_jeton_expire_reponse_de_rafraichissement_malformee_garde_le_coffre_et_ne_fuit_rien() {
    let mock = start_mock(|request| if request.target == "/token" { reply(200, "<html>pas du json {access-2") } else { reply(200, "{}") });
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", -10);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
    let error = execute(&env, request("GET", &format!("{}/calendar/v3/x", mock.base), google_auth("r"))).await.unwrap_err();
    assert_no_secret(&error);
    assert_eq!(mock.requests().len(), 1, "une seule tentative de rafraîchissement, pas de boucle");
    let stored = google::load_tokens(&vault, "r").unwrap();
    assert_eq!((stored.access.as_str(), stored.refresh.as_str()), ("access-1", "refresh-1"));
}

#[tokio::test]
async fn k03_rafraichissement_en_429_ou_5xx_n_efface_pas_les_jetons_et_ne_boucle_pas() {
    for status in [429u16, 500, 503] {
        let mock = start_mock(move |request| if request.target == "/token" { reply(status, "{}") } else { reply(200, "{}") });
        let vault = MemoryVault::default();
        put_tokens(&vault, "r", "access-1", -10);
        let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
        let cfg = config();
        let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&cfg) };
        let result = execute(&env, request("GET", &format!("{}/calendar/v3/x", mock.base), google_auth("r"))).await;
        if let Err(error) = &result {
            assert_no_secret(error);
            assert_ne!(error, "reauth-required", "statut {status} : le jeton n'est pas révoqué");
        }
        assert_eq!(mock.requests().len(), 1, "statut {status} : une seule tentative");
        assert_eq!(google::load_tokens(&vault, "r").unwrap().refresh, "refresh-1");
    }
}

#[tokio::test]
async fn k03_reseau_coupe_pendant_le_rafraichissement_garde_les_jetons_et_ne_fuit_rien() {
    let vault = MemoryVault::default();
    put_tokens(&vault, "r", "access-1", -10);
    let down = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
    let cfg = config();
    let env = HttpEnv { vault: &vault, google: &down, client: Some(&cfg) };
    let error = execute(&env, request("GET", "http://127.0.0.1:9/calendar/v3/x", google_auth("r"))).await.unwrap_err();
    assert_no_secret(&error);
    assert_ne!(error, "reauth-required");
    assert_eq!(google::load_tokens(&vault, "r").unwrap().refresh, "refresh-1");
}

#[tokio::test]
async fn k02_basic_401_et_reseau_coupe_ne_fuient_pas_le_mot_de_passe() {
    let mock = start_mock(|_| reply(401, "{}"));
    let vault = MemoryVault::default();
    vault.set("ic", "mot-de-passe-app-secret").unwrap();
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let env = HttpEnv { vault: &vault, google: &endpoints, client: None };
    let basic = HttpAuth::Basic { token_ref: "ic".to_owned(), username: "ali@icloud.com".to_owned() };
    let outcome = execute(&env, request("GET", &format!("{}/x", mock.base), basic.clone())).await;
    let shown = format!("{outcome:?}");
    assert!(!shown.contains("mot-de-passe-app-secret"), "{shown}");
    let down = execute(&env, request("GET", "http://127.0.0.1:9/x", basic)).await;
    let shown = format!("{down:?}");
    assert!(!shown.contains("mot-de-passe-app-secret"), "{shown}");
}
