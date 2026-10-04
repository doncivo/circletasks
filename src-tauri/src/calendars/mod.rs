//! Agendas externes (M8, K-01 à K-03, ADR 0008) : PC et iPhone, même code.
//!
//! Rust détient les secrets : coffre système, flux OAuth Google (PKCE), ajout de l'en-tête
//! `Authorization` et rafraîchissement du jeton. La WebView ne voit que `token_ref` ; l'analyse des
//! réponses (JSON Google, XML CalDAV, ICS) est faite en TypeScript (src/features/calendars).
//!
//! Commandes (noms figés, déclarés dans build.rs et capabilities/calendars.json ; rejets = code
//! `CalendarPlatformErrorCode` en chaîne, jamais de secret dans le message) :
//!
//! ```text
//! calendar_secret_set(token_ref: String, secret: String) -> Result<(), String>
//! calendar_secret_exists(token_ref: String) -> Result<bool, String>
//! calendar_secret_delete(token_ref: String) -> Result<(), String>
//! calendar_oauth_google_authorize(token_ref: String) -> Result<(), String>   // async
//!     PC : PKCE S256 + state, écoute 127.0.0.1:<port libre>, navigateur système (opener),
//!          délai 5 min, échange du code, jetons JSON { refresh, access, expires_at } au coffre.
//!     iOS : contrat seulement (ordre 5) : rejet `unsupported` ; le plugin Swift `web-auth`
//!          (ASWebAuthenticationSession, redirection com.googleusercontent.apps.<id>:/oauth2redirect)
//!          appellera ensuite le même échange (`google::exchange_code`).
//! calendar_oauth_google_revoke(token_ref: String) -> Result<(), String>      // async, au mieux
//! calendar_http(request: HttpRequest) -> Result<HttpResponse, String>        // async, reqwest rustls
//! ```

pub mod google;
pub mod hosts;
pub mod http;
pub mod vault;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Service du coffre système (identique sur PC et iPhone).
pub const VAULT_SERVICE: &str = "fr.circletasks.planner";

/// Portée unique demandée à Google (K-01 critère 9).
pub const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";

/// Authentification ajoutée par Rust à partir du coffre (miroir de `CalendarAuth`, TypeScript).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum HttpAuth {
    GoogleOauth { token_ref: String },
    Basic { token_ref: String, username: String },
}

/// Miroir de `CalendarHttpRequest` ; un en-tête `Authorization` fourni est refusé.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub auth: HttpAuth,
    pub timeout_ms: Option<u64>,
}

/// Miroir de `CalendarHttpResponse` : un 4xx / 5xx est une réponse, pas une erreur.
#[derive(Debug, Clone, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn system_vault() -> vault::SystemVault {
    vault::SystemVault
}

#[tauri::command]
pub fn calendar_secret_set(token_ref: String, secret: String) -> Result<(), String> {
    vault::SecretVault::set(&system_vault(), &token_ref, &secret).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub fn calendar_secret_exists(token_ref: String) -> Result<bool, String> {
    vault::SecretVault::get(&system_vault(), &token_ref).map(|secret| secret.is_some()).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub fn calendar_secret_delete(token_ref: String) -> Result<(), String> {
    vault::SecretVault::delete(&system_vault(), &token_ref).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub async fn calendar_http(request: HttpRequest) -> Result<HttpResponse, String> {
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    http::execute(&http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() }, request).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn calendar_oauth_google_authorize(app: tauri::AppHandle, token_ref: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    let env = http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() };
    google::authorize(&env, &token_ref, |url| app.opener().open_url(url, None::<&str>).map_err(|_| "network".to_owned()), google::CONSENT_TIMEOUT).await
}

/// iPhone : contrat seulement (ordre 5, plugin Swift `web-auth`).
#[cfg(mobile)]
#[tauri::command]
pub async fn calendar_oauth_google_authorize(_token_ref: String) -> Result<(), String> {
    Err("unsupported".to_owned())
}

#[tauri::command]
pub async fn calendar_oauth_google_revoke(token_ref: String) -> Result<(), String> {
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    google::revoke(&http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() }, &token_ref).await
}
