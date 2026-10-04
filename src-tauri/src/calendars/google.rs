//! OAuth 2.0 Google, PKCE S256 avec redirection boucle locale (K-01, ADR 0008 section 5). Portée `calendar.readonly` seule.
//! Les jetons restent en Rust : ils sont écrits au coffre sous `token_ref` au format JSON `{ refresh, access, expires_at }` et ne
//! sont jamais renvoyés à la WebView, ni journalisés, ni repris dans un message d'erreur (les erreurs sont des codes fixes).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use super::http::{post_form, HttpEnv};
use super::vault::{SecretVault, VaultError};
use super::GOOGLE_SCOPE;

/// Délai d'attente du consentement dans le navigateur (ADR 0008).
pub const CONSENT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Marge avant l'expiration réelle : le jeton est rafraîchi quand il lui reste moins que cela.
pub const EXPIRY_MARGIN_SECS: i64 = 60;

/// Points d'accès OAuth de Google (ou du simulateur en debug).
#[derive(Debug, Clone)]
pub struct GoogleEndpoints {
    pub auth_url: String,
    pub token_url: String,
    pub revoke_url: String,
}

impl GoogleEndpoints {
    pub fn production() -> Self {
        Self {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
            token_url: "https://oauth2.googleapis.com/token".to_owned(),
            revoke_url: "https://oauth2.googleapis.com/revoke".to_owned(),
        }
    }

    /// Mêmes chemins que `simulatorEndpoints` (src/platform/calendars/types.ts).
    pub fn from_sim_base(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self { auth_url: format!("{base}/o/oauth2/v2/auth"), token_url: format!("{base}/token"), revoke_url: format!("{base}/revoke") }
    }

    /// Production, sauf en debug avec `CT_CALENDAR_SIM_GOOGLE` (URL du simulateur, tests/sim) : jamais dans un build livré.
    pub fn from_environment() -> Self {
        #[cfg(debug_assertions)]
        if let Ok(base) = std::env::var("CT_CALENDAR_SIM_GOOGLE") {
            return Self::from_sim_base(&base);
        }
        Self::production()
    }
}

/// Identifiants client OAuth, fournis au build (jamais dans le dépôt) : voir docs/stories/K-01.md.
#[derive(Clone)]
pub struct ClientConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
}

impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConfig").field("client_id", &"…").field("client_secret", &self.client_secret.as_ref().map(|_| "…")).finish()
    }
}

impl ClientConfig {
    /// `CT_GOOGLE_CLIENT_ID` (et `CT_GOOGLE_CLIENT_SECRET` si Google l'exige) lus au build ; en debug, la variable d'environnement
    /// d'exécution l'emporte (essai contre le simulateur). Absent : `None` (code `config-missing`, « non configuré »).
    pub fn from_environment() -> Option<Self> {
        let compiled_id = option_env!("CT_GOOGLE_CLIENT_ID");
        let compiled_secret = option_env!("CT_GOOGLE_CLIENT_SECRET");
        #[cfg(debug_assertions)]
        let (runtime_id, runtime_secret) = (std::env::var("CT_GOOGLE_CLIENT_ID").ok(), std::env::var("CT_GOOGLE_CLIENT_SECRET").ok());
        #[cfg(not(debug_assertions))]
        let (runtime_id, runtime_secret): (Option<String>, Option<String>) = (None, None);
        let id = runtime_id.or_else(|| compiled_id.map(str::to_owned)).filter(|value| !value.trim().is_empty())?;
        let secret = runtime_secret.or_else(|| compiled_secret.map(str::to_owned)).filter(|value| !value.trim().is_empty());
        Some(Self { client_id: id, client_secret: secret })
    }
}

/// Jetons Google tels que rangés au coffre.
#[derive(Clone, Serialize, Deserialize)]
pub struct GoogleTokens {
    pub refresh: String,
    pub access: String,
    /// Secondes Unix.
    pub expires_at: i64,
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

pub fn load_tokens(vault: &dyn SecretVault, token_ref: &str) -> Result<GoogleTokens, String> {
    match vault.get(token_ref) {
        Ok(Some(raw)) => serde_json::from_str(&raw).map_err(|_| "reauth-required".to_owned()),
        Ok(None) => Err("secret-missing".to_owned()),
        Err(VaultError::Unavailable) => Err("vault-unavailable".to_owned()),
    }
}

pub fn store_tokens(vault: &dyn SecretVault, token_ref: &str, tokens: &GoogleTokens) -> Result<(), String> {
    let raw = serde_json::to_string(tokens).map_err(|_| "vault-unavailable".to_owned())?;
    vault.set(token_ref, &raw).map_err(|_| "vault-unavailable".to_owned())
}

/// Défi PKCE S256 (RFC 7636 section 4.2).
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Vérificateur PKCE : 64 caractères parmi les non réservés de la RFC 7636 (43 à 128 exigés).
pub fn random_verifier() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    (0..64).map(|_| CHARS[rng.random_range(0..CHARS.len())] as char).collect()
}

/// Paramètre `state` : 32 octets aléatoires.
pub fn random_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn build_auth_url(endpoints: &GoogleEndpoints, client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> Result<String, String> {
    let mut url = Url::parse(&endpoints.auth_url).map_err(|_| "network".to_owned())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", GOOGLE_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

/// Résultat de l'analyse de la ligne de requête reçue sur la boucle locale.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    /// Pas la redirection OAuth (ex. `/favicon.ico`) : ignorée.
    Ignore,
    Code(String),
    Failure(&'static str),
}

/// Analyse `GET /?code=…&state=… HTTP/1.1`. Le `state` doit correspondre avant toute autre décision.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Callback::Ignore;
    }
    let Some(target) = parts.next() else { return Callback::Ignore };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Ignore };
    let mut code = None;
    let mut state = None;
    let mut error = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = true,
            _ => {}
        }
    }
    if url.path() != "/" || (code.is_none() && !error && state.is_none()) {
        return Callback::Ignore;
    }
    if state.as_deref() != Some(expected_state) {
        return Callback::Failure("state-mismatch");
    }
    if error {
        return Callback::Failure("cancelled");
    }
    match code {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Failure("cancelled"),
    }
}

const PAGE_OK: &str = "<!doctype html><meta charset=\"utf-8\"><title>CircleTasks</title><body style=\"font-family:sans-serif;margin:3em\"><h1>Connexion terminée</h1><p>Vous pouvez fermer cet onglet et revenir à CircleTasks.</p></body>";
const PAGE_KO: &str = "<!doctype html><meta charset=\"utf-8\"><title>CircleTasks</title><body style=\"font-family:sans-serif;margin:3em\"><h1>Connexion annulée</h1><p>Vous pouvez fermer cet onglet et revenir à CircleTasks.</p></body>";

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(2).any(|pair| pair == b"\r\n") || buffer.len() > 8192 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    text.lines().next().map(str::to_owned)
}

/// Attend la redirection sur `listener` (délai `timeout`) et rend le code d'autorisation.
pub async fn wait_for_callback(listener: &TcpListener, expected_state: &str, timeout: Duration) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let (mut stream, _) = tokio::time::timeout_at(deadline, listener.accept()).await.map_err(|_| "timeout".to_owned())?.map_err(|_| "network".to_owned())?;
        let Some(line) = read_request_line(&mut stream).await else { continue };
        match parse_callback(&line, expected_state) {
            Callback::Ignore => respond(&mut stream, "404 Not Found", "").await,
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", PAGE_OK).await;
                return Ok(code);
            }
            Callback::Failure(reason) => {
                respond(&mut stream, "200 OK", PAGE_KO).await;
                return Err(reason.to_owned());
            }
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
}

fn client_pairs<'a>(config: &'a ClientConfig, pairs: &mut Vec<(&'a str, &'a str)>) {
    pairs.push(("client_id", &config.client_id));
    if let Some(secret) = &config.client_secret {
        pairs.push(("client_secret", secret));
    }
}

/// Échange du code contre les jetons (Rust seul : le code et les jetons ne passent pas par la WebView).
pub async fn exchange_code(env: &HttpEnv<'_>, config: &ClientConfig, code: &str, verifier: &str, redirect_uri: &str) -> Result<GoogleTokens, String> {
    let mut pairs = vec![("grant_type", "authorization_code"), ("code", code), ("code_verifier", verifier), ("redirect_uri", redirect_uri)];
    client_pairs(config, &mut pairs);
    let response = post_form(env, &env.google.token_url, &pairs).await?;
    let parsed: TokenResponse = serde_json::from_str(&response.body).map_err(|_| "network".to_owned())?;
    if response.status != 200 {
        return Err(if parsed.error.as_deref() == Some("invalid_grant") { "cancelled" } else { "network" }.to_owned());
    }
    match (parsed.access_token, parsed.refresh_token) {
        (Some(access), Some(refresh)) => Ok(GoogleTokens { refresh, access, expires_at: now_secs() + parsed.expires_in.unwrap_or(3600) }),
        _ => Err("network".to_owned()),
    }
}

/// Rafraîchit le jeton d'accès. `invalid_grant` (jeton révoqué ou expiré) : `reauth-required`.
pub async fn refresh_tokens(env: &HttpEnv<'_>, config: &ClientConfig, current: &GoogleTokens) -> Result<GoogleTokens, String> {
    let mut pairs = vec![("grant_type", "refresh_token"), ("refresh_token", current.refresh.as_str())];
    client_pairs(config, &mut pairs);
    let response = post_form(env, &env.google.token_url, &pairs).await?;
    let parsed: TokenResponse = serde_json::from_str(&response.body).unwrap_or(TokenResponse { access_token: None, refresh_token: None, expires_in: None, error: None });
    if response.status == 400 || response.status == 401 {
        return Err("reauth-required".to_owned());
    }
    if response.status != 200 {
        return Err("network".to_owned());
    }
    let Some(access) = parsed.access_token else { return Err("network".to_owned()) };
    Ok(GoogleTokens { refresh: parsed.refresh_token.unwrap_or_else(|| current.refresh.clone()), access, expires_at: now_secs() + parsed.expires_in.unwrap_or(3600) })
}

/// Flux complet (PC) : écoute sur 127.0.0.1:<port libre>, ouvre le navigateur par `open`, attend la redirection, échange le code,
/// range les jetons. Un échec n'enregistre rien.
pub async fn authorize<F>(env: &HttpEnv<'_>, token_ref: &str, open: F, timeout: Duration) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let config = env.client.ok_or_else(|| "config-missing".to_owned())?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| "network".to_owned())?;
    let port = listener.local_addr().map_err(|_| "network".to_owned())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/");
    let verifier = random_verifier();
    let state = random_state();
    let url = build_auth_url(env.google, &config.client_id, &redirect_uri, &state, &pkce_challenge(&verifier))?;
    open(&url)?;
    let code = wait_for_callback(&listener, &state, timeout).await?;
    drop(listener);
    let tokens = exchange_code(env, config, &code, &verifier, &redirect_uri).await?;
    store_tokens(env.vault, token_ref, &tokens)
}

/// Révocation au mieux puis effacement du coffre (K-01 critère 8). Seul un coffre indisponible fait échouer.
pub async fn revoke(env: &HttpEnv<'_>, token_ref: &str) -> Result<(), String> {
    if let Ok(Some(raw)) = env.vault.get(token_ref) {
        if let Ok(tokens) = serde_json::from_str::<GoogleTokens>(&raw) {
            let _ = post_form(env, &env.google.revoke_url, &[("token", tokens.refresh.as_str())]).await;
        }
    }
    env.vault.delete(token_ref).map_err(|_| "vault-unavailable".to_owned())
}
