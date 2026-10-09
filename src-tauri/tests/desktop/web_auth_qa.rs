//! K-TECH-01, passe QA : ID client iOS (espaces, forme), URL de retour limites, annulation, rafraîchissement et révocation avec le client
//! iOS (sans secret), absence de fuite dans toutes les sorties. Google simulé en mémoire, aucun réseau, aucun compte réel.

use std::sync::{Arc, Mutex};

use circletasks_lib::calendars::google::{self, GoogleEndpoints, GoogleTokens};
use circletasks_lib::calendars::http::HttpEnv;
use circletasks_lib::calendars::vault::{MemoryVault, SecretVault};
use circletasks_lib::calendars::web_auth::{authorize_ios, ios_redirect, parse_redirect, IosClientConfig, TransportWebAuth, WebAuthError, WebAuthRunner, WebAuthSession};
#[cfg(debug_assertions)]
use circletasks_lib::sync::log;

use crate::support::fake_web_auth::FakeWebAuth;
use crate::support::http_mock::{reply, start_mock, Mock};

const CLIENT_ID: &str = "123-abc.apps.googleusercontent.com";
const REDIRECT: &str = "com.googleusercontent.apps.123-abc:/oauth2redirect";
const REF: &str = "circletasks.calendar.google.a1";

fn runner(fake: FakeWebAuth) -> Arc<dyn WebAuthRunner> {
    Arc::new(TransportWebAuth(fake))
}

fn ios_client() -> google::ClientConfig {
    IosClientConfig::from_value(Some(CLIENT_ID)).unwrap().into_client()
}

// ---- ID client iOS : absent, vide, mal formé, avec espaces --------------------------------------------------------------------

#[test]
fn k_tech_01_qa_1_client_id_with_surrounding_spaces_is_trimmed_and_inner_or_odd_spaces_are_config_missing() {
    for padded in [" 123-abc.apps.googleusercontent.com", "123-abc.apps.googleusercontent.com ", "\t123-abc.apps.googleusercontent.com\r\n", "  123-abc.apps.googleusercontent.com  "] {
        let config = IosClientConfig::from_value(Some(padded)).unwrap_or_else(|| panic!("{padded:?}"));
        let client = config.into_client();
        assert_eq!(client.client_id, CLIENT_ID, "l'ID rangé est nettoyé");
        assert_eq!(ios_redirect(&client.client_id).unwrap().1, REDIRECT);
    }
    for bad in [
        "",
        "   ",
        "\n",
        "123 -abc.apps.googleusercontent.com",
        "123-abc .apps.googleusercontent.com",
        "123-abc.apps.googleusercontent.com 123-abc.apps.googleusercontent.com",
        "12 3-abc.apps.googleusercontent.com",
        "123-ab c.apps.googleusercontent.com",
        "123-abc.apps.googleusercontent.com\u{a0}x",
        "123-ábc.apps.googleusercontent.com",
        "123-abc.apps.googleusercontent.com.",
        ".apps.googleusercontent.com",
        "-.apps.googleusercontent.com",
        "123--abc.apps.googleusercontent.com",
        "123-abc.APPS.googleusercontent.com",
        "http://123-abc.apps.googleusercontent.com",
        "com.googleusercontent.apps.123-abc",
    ] {
        assert!(IosClientConfig::from_value(Some(bad)).is_none(), "{bad:?}");
        assert_eq!(ios_redirect(bad), None, "{bad:?}");
    }
    assert!(IosClientConfig::from_value(None).is_none());
}

#[tokio::test]
async fn k_tech_01_qa_1_an_empty_or_malformed_client_never_opens_the_sheet_nor_writes() {
    for id in ["", " ", "123-abc.apps.googleusercontent.com ", "pas un id", "123-ABC.apps.googleusercontent.com"] {
        let vault = MemoryVault::default();
        let endpoints = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
        let fake = FakeWebAuth::new(|_, _| Err("failed".to_owned()));
        let calls = fake.calls();
        let client = google::ClientConfig { client_id: id.to_owned(), client_secret: None };
        let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&client) };
        let error = authorize_ios(&env, REF, runner(fake), &WebAuthSession::new()).await.unwrap_err();
        assert_eq!(error, "config-missing", "{id:?}");
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(vault.get(REF).unwrap(), None);
    }
}

// ---- URL de retour : cas limites -----------------------------------------------------------------------------------------------

#[test]
fn k_tech_01_qa_2_return_url_edge_cases() {
    let ok = |q: &str| parse_redirect(&format!("{REDIRECT}{q}"), REDIRECT, "s");
    let failed = Err("web-auth-failed".to_owned());
    let mismatch = Err("state-mismatch".to_owned());
    // state différent / absent / vide / en double, avec ou sans code, avec ou sans erreur.
    assert_eq!(ok("?code=c&state=autre"), mismatch);
    assert_eq!(ok("?code=c&state="), mismatch);
    assert_eq!(ok("?code=c"), mismatch);
    assert_eq!(ok("?state=S&code=c"), mismatch, "casse du state respectée");
    assert_eq!(ok("?code=c&state=s&state=s"), mismatch);
    assert_eq!(ok("?error=access_denied"), mismatch);
    assert_eq!(ok(""), mismatch);
    assert_eq!(ok("?"), mismatch);
    // Sans code (bon state).
    assert_eq!(ok("?state=s"), failed);
    assert_eq!(ok("?state=s&code="), failed);
    // access_denied = annulation, même avec un code ; autres erreurs = échec, même avec un code.
    assert_eq!(ok("?error=access_denied&state=s"), Err("cancelled".to_owned()));
    assert_eq!(ok("?error=access_denied&code=c&state=s"), Err("cancelled".to_owned()));
    assert_eq!(ok("?error=access_denied&error_description=Refus&state=s"), Err("cancelled".to_owned()));
    assert_eq!(ok("?error=server_error&code=c&state=s"), failed);
    assert_eq!(ok("?error=&code=c&state=s"), failed);
    assert_eq!(ok("?error=ACCESS_DENIED&state=s"), failed);
    // Schéma inattendu (autre schéma, majuscules, http, schéma de l'app PC, fragment, préfixe commun).
    for callback in [
        "COM.GOOGLEUSERCONTENT.APPS.123-ABC:/oauth2redirect?code=c&state=s",
        "com.googleusercontent.apps.123-abc:oauth2redirect?code=c&state=s",
        "com.googleusercontent.apps.123-abc:/oauth2redirect#code=c&state=s",
        "com.googleusercontent.apps.123-abcd:/oauth2redirect?code=c&state=s",
        "com.googleusercontent.apps.999-zzz:/oauth2redirect?code=c&state=s",
        "http://127.0.0.1:5000/?code=c&state=s",
        "javascript:alert(1)",
        "circletasks://oauth2redirect?code=c&state=s",
        " com.googleusercontent.apps.123-abc:/oauth2redirect?code=c&state=s",
        "?code=c&state=s",
    ] {
        assert_eq!(parse_redirect(callback, REDIRECT, "s"), failed, "{callback}");
    }
    // Code non ASCII ou très long : rendu tel quel, sans panique.
    assert_eq!(ok("?code=%C3%A9&state=s"), Ok("é".to_owned()));
    assert!(ok(&format!("?code={}&state=s", "a".repeat(20000))).is_ok());
}

// ---- Annulation par l'utilisateur ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn k_tech_01_qa_3_user_cancellation_writes_nothing_calls_nobody_and_frees_the_session() {
    let google_mock = start_mock(|_| reply(500, ""));
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base(&google_mock.base);
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let session = WebAuthSession::new();
    for _ in 0..2 {
        let result = authorize_ios(&env, REF, runner(FakeWebAuth::new(|_, _| Err("cancelled".to_owned()))), &session).await;
        assert_eq!(result, Err("cancelled".to_owned()));
        assert_eq!(vault.get(REF).unwrap(), None);
    }
    assert!(google_mock.requests().is_empty(), "aucun appel réseau après annulation");
}

#[tokio::test]
async fn k_tech_01_qa_3_a_panicking_sheet_is_a_failure_not_a_stuck_session() {
    struct Panics;
    impl WebAuthRunner for Panics {
        fn authenticate(&self, _: &str, _: &str) -> Result<String, WebAuthError> {
            panic!("plantage de la feuille");
        }
    }
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base("http://127.0.0.1:9");
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let session = WebAuthSession::new();
    let result = authorize_ios(&env, REF, Arc::new(Panics), &session).await;
    assert_eq!(result, Err("web-auth-failed".to_owned()));
    // La garde est libérée : une nouvelle tentative atteint la feuille.
    let again = authorize_ios(&env, REF, runner(FakeWebAuth::new(|_, _| Err("cancelled".to_owned()))), &session).await;
    assert_eq!(again, Err("cancelled".to_owned()));
}

// ---- Rafraîchissement et révocation avec le client iOS -------------------------------------------------------------------------

fn token_server(revoked: bool) -> (Mock, Arc<Mutex<Vec<String>>>) {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let shared = bodies.clone();
    let mock = start_mock(move |request| {
        shared.lock().unwrap().push(request.body.clone());
        let form = |key: &str| url::form_urlencoded::parse(request.body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
        let path = request.target.split('?').next().unwrap_or("");
        if path == "/revoke" {
            return reply(200, "{}");
        }
        if form("client_secret").is_some() || form("client_id").as_deref() != Some(CLIENT_ID) {
            return reply(401, "{\"error\":\"invalid_client\"}");
        }
        if revoked || form("refresh_token").as_deref() != Some("ref-1") {
            return reply(400, "{\"error\":\"invalid_grant\"}");
        }
        reply(200, "{\"access_token\":\"acc-2\",\"expires_in\":3599}")
    });
    (mock, bodies)
}

fn stored(vault: &MemoryVault) {
    google::store_tokens(vault, REF, &GoogleTokens { refresh: "ref-1".to_owned(), access: "acc-1".to_owned(), expires_at: 1 }).unwrap();
}

#[tokio::test]
async fn k_tech_01_qa_4_refresh_uses_the_ios_client_without_a_secret_and_keeps_the_refresh_token() {
    let (mock, bodies) = token_server(false);
    let vault = MemoryVault::default();
    stored(&vault);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let current = google::load_tokens(&vault, REF).unwrap();
    let fresh = google::refresh_tokens(&env, &config, &current).await.unwrap();
    assert_eq!((fresh.access.as_str(), fresh.refresh.as_str()), ("acc-2", "ref-1"));
    let body = bodies.lock().unwrap()[0].clone();
    assert!(body.contains("grant_type=refresh_token") && body.contains("client_id=123-abc.apps.googleusercontent.com"));
    assert!(!body.contains("client_secret"));
}

#[tokio::test]
async fn k_tech_01_qa_4_a_revoked_token_asks_for_reauth_and_a_foreign_client_is_refused() {
    let (mock, _) = token_server(true);
    let vault = MemoryVault::default();
    stored(&vault);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let current = google::load_tokens(&vault, REF).unwrap();
    assert_eq!(google::refresh_tokens(&env, &config, &current).await.err(), Some("reauth-required".to_owned()));
    // Jeton obtenu par un autre client (PC, avec secret) : Google refuse le client, la reconnexion est demandée.
    let desktop = google::ClientConfig { client_id: "autre.apps.googleusercontent.com".to_owned(), client_secret: Some("secret".to_owned()) };
    assert_eq!(google::refresh_tokens(&env, &desktop, &current).await.err(), Some("reauth-required".to_owned()));
}

#[tokio::test]
async fn k_tech_01_qa_4_revoke_posts_the_refresh_token_and_clears_the_vault() {
    let (mock, bodies) = token_server(false);
    let vault = MemoryVault::default();
    stored(&vault);
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    google::revoke(&env, REF).await.unwrap();
    assert_eq!(vault.get(REF).unwrap(), None);
    assert_eq!(bodies.lock().unwrap().as_slice(), ["token=ref-1"]);
    // Révoquer deux fois ne plante pas.
    google::revoke(&env, REF).await.unwrap();
}

// ---- Aucune fuite : toutes les sorties --------------------------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn k_tech_01_qa_5_no_output_of_any_path_contains_the_code_the_url_the_client_id_or_a_token() {
    const CODE: &str = "code-qa-ultra-secret-424242";
    let capture = log::capture();
    let mock = start_mock(|request| {
        let path = request.target.split('?').next().unwrap_or("");
        match path {
            "/token" if request.body.contains("grant_type=authorization_code") => reply(200, "{\"access_token\":\"acc-qa-secret\",\"refresh_token\":\"ref-qa-secret\",\"expires_in\":3599}"),
            "/token" => reply(400, "{\"error\":\"invalid_grant\",\"error_description\":\"ref-qa-secret revoked\"}"),
            _ => reply(200, "{}"),
        }
    });
    let vault = MemoryVault::default();
    let endpoints = GoogleEndpoints::from_sim_base(&mock.base);
    let config = ios_client();
    let env = HttpEnv { vault: &vault, google: &endpoints, client: Some(&config) };
    let mut outputs: Vec<String> = Vec::new();
    let callbacks = [
        format!("{REDIRECT}?code={CODE}&state=faux"),
        format!("{REDIRECT}?code={CODE}"),
        format!("{REDIRECT}?error=access_denied&code={CODE}&state=faux"),
        format!("evil:/x?code={CODE}&state=s"),
        format!("{REDIRECT}?state=%STATE%"),
    ];
    for callback in callbacks {
        let fake = FakeWebAuth::new(move |url, _| {
            let state = url::Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.into_owned()).unwrap();
            Ok(callback.replace("%STATE%", &state))
        });
        outputs.push(format!("{:?}", authorize_ios(&env, REF, runner(fake), &WebAuthSession::new()).await));
    }
    // Réussite puis rafraîchissement révoqué.
    let fake = FakeWebAuth::new(|url, _| {
        let state = url::Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.into_owned()).unwrap();
        Ok(format!("{REDIRECT}?code={CODE}&state={state}"))
    });
    outputs.push(format!("{:?}", authorize_ios(&env, REF, runner(fake), &WebAuthSession::new()).await));
    let current = google::load_tokens(&vault, REF).unwrap();
    outputs.push(format!("{:?}", google::refresh_tokens(&env, &config, &current).await.err()));
    outputs.push(format!("{:?}", google::revoke(&env, REF).await));
    outputs.extend(capture.lines());
    for text in &outputs {
        for secret in [CODE, CLIENT_ID, "123-abc", "oauth2redirect", "accounts.google.com", "acc-qa-secret", "ref-qa-secret", "faux", "code_challenge", "127.0.0.1"] {
            assert!(!text.contains(secret), "« {secret} » dans « {text} »");
        }
    }
}
