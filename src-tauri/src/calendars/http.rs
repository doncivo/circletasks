//! Commande `calendar_http` (ADR 0008 section 4) : reqwest (rustls) limité aux hôtes autorisés, y compris à chaque redirection.
//! Rust ajoute `Authorization` à partir du coffre (Bearer Google rafraîchi si expiré ou sur 401, une seule fois ; Basic iCloud) ;
//! la WebView ne fournit jamais cet en-tête (refusé) et ne reçoit jamais un secret. Un 4xx / 5xx est une réponse, pas une erreur.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Method};
use url::Url;

use super::google::{self, ClientConfig, GoogleEndpoints};
use super::hosts::url_allowed;
use super::vault::{SecretVault, VaultError};
use super::{HttpAuth, HttpRequest, HttpResponse};

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MAX_REDIRECTS: usize = 5;

/// Dépendances d'une requête : coffre, points d'accès OAuth, identifiants client.
pub struct HttpEnv<'a> {
    pub vault: &'a dyn SecretVault,
    pub google: &'a GoogleEndpoints,
    pub client: Option<&'a ClientConfig>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().redirect(Policy::none()).user_agent("CircleTasks").build().expect("client HTTP"))
}

fn map_transport(error: &reqwest::Error) -> String {
    if error.is_timeout() { "timeout" } else { "network" }.to_owned()
}

/// Une requête avec suivi manuel des redirections (la méthode et le corps sont conservés : `PROPFIND` sur `/.well-known/caldav`
/// serait sinon transformé en `GET`), chaque cible étant contrôlée.
async fn send(method: &Method, url: &Url, headers: &BTreeMap<String, String>, body: &Option<String>, authorization: &str, timeout: Duration) -> Result<HttpResponse, String> {
    let mut current = url.clone();
    for _ in 0..=MAX_REDIRECTS {
        if !url_allowed(&current) {
            return Err("host-not-allowed".to_owned());
        }
        let mut builder = client().request(method.clone(), current.clone()).timeout(timeout).header("Authorization", authorization);
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(|error| map_transport(&error))?;
        let status = response.status().as_u16();
        let location = response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_owned);
        if matches!(status, 301 | 302 | 307 | 308) {
            if let Some(location) = location {
                current = current.join(&location).map_err(|_| "network".to_owned())?;
                continue;
            }
        }
        let mut out_headers = BTreeMap::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                out_headers.insert(name.as_str().to_ascii_lowercase(), value.to_owned());
            }
        }
        let body = response.text().await.map_err(|error| map_transport(&error))?;
        return Ok(HttpResponse { status, headers: out_headers, body });
    }
    Err("network".to_owned())
}

/// POST `application/x-www-form-urlencoded` sans `Authorization` (jeton, révocation OAuth).
pub async fn post_form(_env: &HttpEnv<'_>, url: &str, pairs: &[(&str, &str)]) -> Result<HttpResponse, String> {
    let parsed = Url::parse(url).map_err(|_| "host-not-allowed".to_owned())?;
    if !url_allowed(&parsed) {
        return Err("host-not-allowed".to_owned());
    }
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish();
    let response = client()
        .post(parsed)
        .timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| map_transport(&error))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| map_transport(&error))?;
    Ok(HttpResponse { status, headers: BTreeMap::new(), body })
}

fn vault_error(_: VaultError) -> String {
    "vault-unavailable".to_owned()
}

/// Exécute une requête d'agenda. Codes de rejet : `host-not-allowed`, `secret-missing`, `reauth-required`, `config-missing`,
/// `vault-unavailable`, `network`, `timeout`, `unsupported` (méthode ou en-tête `Authorization` refusés).
pub async fn execute(env: &HttpEnv<'_>, request: HttpRequest) -> Result<HttpResponse, String> {
    let method = match request.method.as_str() {
        "GET" | "POST" | "PROPFIND" | "REPORT" => Method::from_bytes(request.method.as_bytes()).map_err(|_| "unsupported".to_owned())?,
        _ => return Err("unsupported".to_owned()),
    };
    if request.headers.keys().any(|name| name.eq_ignore_ascii_case("authorization")) {
        return Err("unsupported".to_owned());
    }
    let url = Url::parse(&request.url).map_err(|_| "host-not-allowed".to_owned())?;
    if !url_allowed(&url) {
        return Err("host-not-allowed".to_owned());
    }
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    match &request.auth {
        HttpAuth::Basic { token_ref, username } => {
            let password = env.vault.get(token_ref).map_err(vault_error)?.ok_or_else(|| "secret-missing".to_owned())?;
            let authorization = format!("Basic {}", STANDARD.encode(format!("{username}:{password}")));
            send(&method, &url, &request.headers, &request.body, &authorization, timeout).await
        }
        HttpAuth::GoogleOauth { token_ref } => {
            let mut tokens = google::load_tokens(env.vault, token_ref)?;
            if tokens.expires_at <= google::now_secs() + google::EXPIRY_MARGIN_SECS {
                tokens = refresh_and_store(env, token_ref, &tokens).await?;
            }
            let response = send(&method, &url, &request.headers, &request.body, &format!("Bearer {}", tokens.access), timeout).await?;
            if response.status != 401 {
                return Ok(response);
            }
            // Jeton refusé malgré une échéance non atteinte : un seul rafraîchissement, puis une seule nouvelle tentative.
            tokens = refresh_and_store(env, token_ref, &tokens).await?;
            let retried = send(&method, &url, &request.headers, &request.body, &format!("Bearer {}", tokens.access), timeout).await?;
            if retried.status == 401 {
                return Err("reauth-required".to_owned());
            }
            Ok(retried)
        }
    }
}

async fn refresh_and_store(env: &HttpEnv<'_>, token_ref: &str, current: &google::GoogleTokens) -> Result<google::GoogleTokens, String> {
    let config = env.client.ok_or_else(|| "config-missing".to_owned())?;
    let fresh = google::refresh_tokens(env, config, current).await?;
    google::store_tokens(env.vault, token_ref, &fresh)?;
    Ok(fresh)
}
