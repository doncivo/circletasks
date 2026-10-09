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
//!     iOS (K-TECH-01, ADR 0008 §9) : plugin Swift `web-auth` (ASWebAuthenticationSession, appelé par Rust seul), redirection
//!          com.googleusercontent.apps.<id>:/oauth2redirect, ID client « iOS » sans secret, même échange du code ; rejets
//!          supplémentaires `web-auth-unavailable` et `web-auth-failed`.
//! calendar_oauth_google_revoke(token_ref: String) -> Result<(), String>      // async, au mieux
//! calendar_http(request: HttpRequest) -> Result<HttpResponse, String>        // async, reqwest rustls
//! ```

pub mod google;
pub mod hosts;
pub mod http;
pub mod web_auth;
/// Coffre système, déplacé à la racine de la crate au lot Y1 (partagé avec la synchro, ADR 0011 section 2.2).
pub use crate::vault;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use crate::vault::VAULT_SERVICE;

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

/// Contrôle d'une référence venue de la WebView : format exact et espace de noms attendu (`vault-unavailable` sinon, sans écho).
pub fn checked_ref(token_ref: &str, expected: Option<vault::RefNamespace>) -> Result<(), String> {
    match (vault::parse_token_ref(token_ref), expected) {
        (None, _) => Err("vault-unavailable".to_owned()),
        (Some(found), Some(wanted)) if found != wanted => Err("vault-unavailable".to_owned()),
        _ => Ok(()),
    }
}

/// Contrôle des références d'une requête : l'authentification Google lit un jeton Google, Basic un mot de passe iCloud.
pub fn checked_auth(auth: &HttpAuth) -> Result<(), String> {
    match auth {
        HttpAuth::GoogleOauth { token_ref } => checked_ref(token_ref, Some(vault::RefNamespace::Google)),
        HttpAuth::Basic { token_ref, .. } => checked_ref(token_ref, Some(vault::RefNamespace::Icloud)),
    }
}

#[tauri::command]
/// La WebView n'écrit que des mots de passe iCloud : une référence Google (jeton OAuth) est refusée, seul le flux de Rust l'écrit.
pub fn calendar_secret_set(token_ref: String, secret: String) -> Result<(), String> {
    checked_ref(&token_ref, Some(vault::RefNamespace::Icloud))?;
    vault::SecretVault::set(&system_vault(), &token_ref, &secret).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub fn calendar_secret_exists(token_ref: String) -> Result<bool, String> {
    checked_ref(&token_ref, None)?;
    vault::SecretVault::get(&system_vault(), &token_ref).map(|secret| secret.is_some()).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub fn calendar_secret_delete(token_ref: String) -> Result<(), String> {
    checked_ref(&token_ref, None)?;
    vault::SecretVault::delete(&system_vault(), &token_ref).map_err(|_| "vault-unavailable".to_owned())
}

#[tauri::command]
pub async fn calendar_http(request: HttpRequest) -> Result<HttpResponse, String> {
    checked_auth(&request.auth)?;
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    http::execute(&http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() }, request).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn calendar_oauth_google_authorize(app: tauri::AppHandle, token_ref: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    checked_ref(&token_ref, Some(vault::RefNamespace::Google))?;
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    let env = http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() };
    google::authorize(&env, &token_ref, |url| app.opener().open_url(url, None::<&str>).map_err(|_| "network".to_owned()), google::CONSENT_TIMEOUT).await
}

/// Une seule feuille d'authentification à la fois sur iPhone (un second appel rend `web-auth-unavailable`).
#[cfg(target_os = "ios")]
static WEB_AUTH_SESSION: web_auth::WebAuthSession = web_auth::WebAuthSession::new();

/// iPhone (K-TECH-01) : session d'authentification web du système par le plugin Swift `web-auth`, puis le même échange que sur PC.
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn calendar_oauth_google_authorize(app: tauri::AppHandle, token_ref: String) -> Result<(), String> {
    use tauri::Manager;
    checked_ref(&token_ref, Some(vault::RefNamespace::Google))?;
    let Some(plugin) = app.try_state::<tauri_plugin_web_auth::WebAuth<tauri::Wry>>() else { return Err("web-auth-unavailable".to_owned()) };
    let runner: std::sync::Arc<dyn web_auth::WebAuthRunner> = std::sync::Arc::new(web_auth::TransportWebAuth(web_auth::PluginTransport((*plugin).clone())));
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    let env = http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() };
    web_auth::authorize_ios(&env, &token_ref, runner, &WEB_AUTH_SESSION).await
}

/// Autre mobile (Android n'est pas livré) : pas de plugin, rejet explicite.
#[cfg(all(mobile, not(target_os = "ios")))]
#[tauri::command]
pub async fn calendar_oauth_google_authorize(_token_ref: String) -> Result<(), String> {
    Err("unsupported".to_owned())
}

#[tauri::command]
pub async fn calendar_oauth_google_revoke(token_ref: String) -> Result<(), String> {
    checked_ref(&token_ref, Some(vault::RefNamespace::Google))?;
    let vault = system_vault();
    let endpoints = google::GoogleEndpoints::from_environment();
    let client = google::ClientConfig::from_environment();
    google::revoke(&http::HttpEnv { vault: &vault, google: &endpoints, client: client.as_ref() }, &token_ref).await
}
