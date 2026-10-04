//! Commande `calendar_http` (ADR 0008 section 4) : reqwest (rustls) limité aux hôtes autorisés, y compris à chaque redirection.
//! Rust ajoute `Authorization` à partir du coffre (Bearer Google rafraîchi si expiré ou sur 401, une seule fois ; Basic iCloud) ;
//! la WebView ne fournit jamais cet en-tête (refusé) et ne reçoit jamais un secret. Un 4xx / 5xx est une réponse, pas une erreur.
//!
//! Durcissement : le TYPE d'authentification est lié à l'hôte (Bearer seulement vers `www.googleapis.com`, Basic seulement vers
//! `*.icloud.com`), contrôle refait à chaque redirection, en-tête retiré si la redirection change de fournisseur ; seuls quelques
//! en-têtes de la WebView passent ; délai et taille de réponse plafonnés.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Method};
use url::Url;

use super::google::{self, ClientConfig, GoogleEndpoints};
use super::hosts::{auth_allowed, url_allowed, AuthScope};
use super::vault::{SecretVault, VaultError};
use super::{HttpAuth, HttpRequest, HttpResponse};

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
/// Plafond du délai demandé par la WebView.
pub const MAX_TIMEOUT_MS: u64 = 30_000;
/// Plafond de la taille d'une réponse (un mois d'agenda tient dans quelques centaines de Ko).
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

/// En-têtes que la WebView peut poser (noms en minuscules) : le reste est refusé.
pub const ALLOWED_REQUEST_HEADERS: [&str; 6] = ["depth", "content-type", "accept", "prefer", "if-none-match", "if-match"];

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

/// Corps d'une réponse, lu par morceaux et refusé au-delà de `MAX_RESPONSE_BYTES` (rien n'est gardé en mémoire au-delà).
async fn read_capped(mut response: reqwest::Response) -> Result<String, String> {
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err("network".to_owned());
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| map_transport(&error))? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("network".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Une requête avec suivi manuel des redirections (la méthode et le corps sont conservés : `PROPFIND` sur `/.well-known/caldav`
/// serait sinon transformé en `GET`). Chaque cible doit être un hôte autorisé ; l'en-tête d'authentification n'est envoyé qu'aux hôtes
/// de SON fournisseur : une redirection vers un autre fournisseur est suivie SANS lui.
async fn send(method: &Method, url: &Url, headers: &BTreeMap<String, String>, body: &Option<String>, scope: AuthScope, authorization: &str, timeout: Duration) -> Result<HttpResponse, String> {
    let mut current = url.clone();
    for hop in 0..=MAX_REDIRECTS {
        if !url_allowed(&current) {
            return Err("host-not-allowed".to_owned());
        }
        let attach = auth_allowed(scope, &current);
        if hop == 0 && !attach {
            return Err("host-not-allowed".to_owned());
        }
        let mut builder = client().request(method.clone(), current.clone()).timeout(timeout);
        if attach {
            builder = builder.header("Authorization", authorization);
        }
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
        let body = read_capped(response).await?;
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
    let body = read_capped(response).await?;
    Ok(HttpResponse { status, headers: BTreeMap::new(), body })
}

fn vault_error(_: VaultError) -> String {
    "vault-unavailable".to_owned()
}

/// Exécute une requête d'agenda. Codes de rejet : `host-not-allowed` (hôte hors liste ou authentification non liée à cet hôte),
/// `secret-missing`, `reauth-required`, `config-missing`, `vault-unavailable`, `network`, `timeout`, `unsupported` (méthode ou
/// en-tête refusés, dont `Authorization`).
pub async fn execute(env: &HttpEnv<'_>, request: HttpRequest) -> Result<HttpResponse, String> {
    let method = match request.method.as_str() {
        "GET" | "POST" | "PROPFIND" | "REPORT" => Method::from_bytes(request.method.as_bytes()).map_err(|_| "unsupported".to_owned())?,
        _ => return Err("unsupported".to_owned()),
    };
    if request.headers.keys().any(|name| !ALLOWED_REQUEST_HEADERS.contains(&name.to_ascii_lowercase().as_str())) {
        return Err("unsupported".to_owned());
    }
    let url = Url::parse(&request.url).map_err(|_| "host-not-allowed".to_owned())?;
    if !url_allowed(&url) {
        return Err("host-not-allowed".to_owned());
    }
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
    match &request.auth {
        HttpAuth::Basic { token_ref, username } => {
            if !auth_allowed(AuthScope::Basic, &url) {
                return Err("host-not-allowed".to_owned());
            }
            let password = env.vault.get(token_ref).map_err(vault_error)?.ok_or_else(|| "secret-missing".to_owned())?;
            let authorization = format!("Basic {}", STANDARD.encode(format!("{username}:{password}")));
            send(&method, &url, &request.headers, &request.body, AuthScope::Basic, &authorization, timeout).await
        }
        HttpAuth::GoogleOauth { token_ref } => {
            if !auth_allowed(AuthScope::Google, &url) {
                return Err("host-not-allowed".to_owned());
            }
            let mut tokens = google::load_tokens(env.vault, token_ref)?;
            if tokens.expires_at <= google::now_secs() + google::EXPIRY_MARGIN_SECS {
                tokens = refresh_and_store(env, token_ref, &tokens).await?;
            }
            let response = send(&method, &url, &request.headers, &request.body, AuthScope::Google, &format!("Bearer {}", tokens.access), timeout).await?;
            if response.status != 401 {
                return Ok(response);
            }
            // Jeton refusé malgré une échéance non atteinte : un seul rafraîchissement, puis une seule nouvelle tentative.
            tokens = refresh_and_store(env, token_ref, &tokens).await?;
            let retried = send(&method, &url, &request.headers, &request.body, AuthScope::Google, &format!("Bearer {}", tokens.access), timeout).await?;
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
