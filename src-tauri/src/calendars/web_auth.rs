//! Connexion Google sur iPhone (K-TECH-01, ADR 0008 §9) : session d'authentification web du système (plugin Swift `web-auth`, appelé par
//! Rust seul), PKCE S256 et `state` vérifiés comme sur PC, échange du code **sans secret** (client « iOS »).
//!
//! Compilé sur toutes les plateformes (les tests tournent sous Windows) ; seuls `PluginTransport` et la commande sont propres à iOS. Le
//! plugin ne rend que l'URL de retour. Rien de ce qui touche à l'autorisation n'est journalisé ni repris dans une erreur : ni l'URL
//! d'autorisation, ni l'URL de retour, ni le code, ni l'ID client ; les erreurs sont des codes fixes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use url::Url;

use super::google::{self, ClientConfig};
use super::hosts;
use super::http::HttpEnv;
use crate::sync::log;

/// Raisons d'échec de la session, telles que le plugin les rejette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebAuthError {
    /// L'utilisateur a fermé la feuille (`cancelled`).
    Cancelled,
    /// Aucune fenêtre, session impossible à démarrer, ancre refusée (`unavailable`).
    Unavailable,
    /// Toute autre erreur, entrée refusée ou URL de retour d'un autre schéma (`failed`).
    Failed,
}

impl WebAuthError {
    /// Code rendu à la WebView (`CalendarPlatformErrorCode`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Unavailable => "web-auth-unavailable",
            Self::Failed => "web-auth-failed",
        }
    }

    /// Code de rejet du plugin vers erreur ; un code inconnu (plugin plus récent, rejet de Tauri sans code) donne `Failed`.
    pub fn from_plugin_code(code: &str) -> Self {
        match code {
            "cancelled" => Self::Cancelled,
            "unavailable" => Self::Unavailable,
            _ => Self::Failed,
        }
    }
}

/// Ouvre l'URL d'autorisation dans une session web et rend l'URL de retour. Bloquant (la feuille système reste ouverte tant que
/// l'utilisateur ne l'a pas fermée) : appelé depuis `spawn_blocking`.
pub trait WebAuthRunner: Send + Sync {
    fn authenticate(&self, url: &str, callback_scheme: &str) -> Result<String, WebAuthError>;
}

/// Transport des commandes du plugin : nom exact de la méthode Swift, arguments JSON ; erreur = code rejeté.
pub trait WebAuthTransport: Send + Sync {
    fn call(&self, command: &str, args: Value) -> Result<Value, String>;
}

/// Commande unique du contrat (`tests/fixtures/calendars/web-auth-contract.json`).
pub const PLUGIN_COMMAND: &str = "authenticate";

/// Exécuteur de production et des tests : parle le JSON du contrat à un transport (le plugin sur iOS, un faux ailleurs).
pub struct TransportWebAuth<T: WebAuthTransport>(pub T);

impl<T: WebAuthTransport> WebAuthRunner for TransportWebAuth<T> {
    fn authenticate(&self, url: &str, callback_scheme: &str) -> Result<String, WebAuthError> {
        let outcome = self.0.call(PLUGIN_COMMAND, json!({ "url": url, "callbackScheme": callback_scheme }));
        match outcome {
            Ok(value) => match value.get("callbackUrl").and_then(Value::as_str) {
                Some(callback) if !callback.is_empty() => Ok(callback.to_owned()),
                _ => Err(WebAuthError::Failed),
            },
            Err(code) => Err(WebAuthError::from_plugin_code(&code)),
        }
    }
}

/// Transport de production : le plugin Swift (`tauri-plugin-web-auth`), appelé par `run_mobile_plugin` (bloquant).
#[cfg(target_os = "ios")]
pub struct PluginTransport<R: tauri::Runtime>(pub tauri_plugin_web_auth::WebAuth<R>);

#[cfg(target_os = "ios")]
impl<R: tauri::Runtime> WebAuthTransport for PluginTransport<R> {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.0.call(command, args)
    }
}

/// Garde de session : une seule feuille d'authentification à la fois (un second appel pendant une session est refusé).
pub struct WebAuthSession(AtomicBool);

impl WebAuthSession {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    fn acquire(&self) -> Option<SessionGuard<'_>> {
        self.0.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| SessionGuard(&self.0))
    }
}

impl Default for WebAuthSession {
    fn default() -> Self {
        Self::new()
    }
}

struct SessionGuard<'a>(&'a AtomicBool);

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

const CLIENT_ID_SUFFIX: &str = ".apps.googleusercontent.com";
/// Chemin de la redirection (RFC 8252 section 7.1 : schéma privé inversé, un seul `/`).
const REDIRECT_PATH: &str = "/oauth2redirect";

/// Forme exigée de l'ID client iOS : `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`.
pub fn is_valid_ios_client_id(client_id: &str) -> bool {
    let Some(prefix) = client_id.strip_suffix(CLIENT_ID_SUFFIX) else { return false };
    let Some((number, hash)) = prefix.split_once('-') else { return false };
    !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) && !hash.is_empty() && hash.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Schéma et URI de redirection dérivés de l'ID client : `<n>-<h>.apps.googleusercontent.com` donne
/// `com.googleusercontent.apps.<n>-<h>` et `com.googleusercontent.apps.<n>-<h>:/oauth2redirect`. `None` si l'ID est mal formé.
pub fn ios_redirect(client_id: &str) -> Option<(String, String)> {
    if !is_valid_ios_client_id(client_id) {
        return None;
    }
    let prefix = client_id.strip_suffix(CLIENT_ID_SUFFIX)?;
    let scheme = format!("com.googleusercontent.apps.{prefix}");
    let redirect_uri = format!("{scheme}:{REDIRECT_PATH}");
    Some((scheme, redirect_uri))
}

/// ID client OAuth de type « iOS » (sans secret), fourni au build (`CT_GOOGLE_IOS_CLIENT_ID`, jamais dans le dépôt).
#[derive(Clone)]
pub struct IosClientConfig {
    client_id: String,
}

impl std::fmt::Debug for IosClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IosClientConfig").field("client_id", &"…").finish()
    }
}

impl IosClientConfig {
    /// Valeur compilée ; en debug, la variable d'environnement d'exécution l'emporte (essai contre le simulateur). Absent ou mal formé :
    /// `None` (code `config-missing`).
    pub fn from_environment() -> Option<Self> {
        let compiled = option_env!("CT_GOOGLE_IOS_CLIENT_ID");
        #[cfg(debug_assertions)]
        let runtime = std::env::var("CT_GOOGLE_IOS_CLIENT_ID").ok();
        #[cfg(not(debug_assertions))]
        let runtime: Option<String> = None;
        Self::from_value(runtime.as_deref().or(compiled))
    }

    pub fn from_value(value: Option<&str>) -> Option<Self> {
        let id = value?.trim();
        is_valid_ios_client_id(id).then(|| Self { client_id: id.to_owned() })
    }

    /// Configuration d'échange : l'ID iOS, **jamais de secret** (un client « iOS » n'en a pas).
    pub fn into_client(self) -> ClientConfig {
        ClientConfig { client_id: self.client_id, client_secret: None }
    }
}

/// Analyse l'URL de retour. Le préfixe exact `<schéma>:/oauth2redirect` est exigé, puis le `state` est comparé **avant toute autre
/// lecture** (différent, absent ou répété : `state-mismatch`) ; `error=access_denied` donne `cancelled`, tout autre `error` ou un
/// `code` absent donne `web-auth-failed`.
pub fn parse_redirect(callback_url: &str, redirect_uri: &str, expected_state: &str) -> Result<String, String> {
    let rest = callback_url.strip_prefix(redirect_uri).ok_or_else(|| "web-auth-failed".to_owned())?;
    if !(rest.is_empty() || rest.starts_with('?')) {
        return Err("web-auth-failed".to_owned());
    }
    let url = Url::parse(callback_url).map_err(|_| "web-auth-failed".to_owned())?;
    let mut states = url.query_pairs().filter(|(key, _)| key == "state");
    let state = states.next();
    if states.next().is_some() || state.as_ref().map(|(_, value)| value.as_ref()) != Some(expected_state) {
        return Err("state-mismatch".to_owned());
    }
    let mut code = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    match (error.as_deref(), code) {
        (Some("access_denied"), _) => Err("cancelled".to_owned()),
        (Some(_), _) => Err("web-auth-failed".to_owned()),
        (None, Some(code)) if !code.is_empty() => Ok(code),
        _ => Err("web-auth-failed".to_owned()),
    }
}

/// Consigne le seul code d'un échec (jamais l'URL, le code ni l'ID client) puis le rend.
fn failed(code: &str) -> String {
    log::event("web-auth", code);
    code.to_owned()
}

/// Flux complet sur iPhone : `verifier` et `state` aléatoires, URL d'autorisation (portée `calendar.readonly` seule, S256), session web
/// par `runner`, vérification de l'URL de retour, échange du code sans secret, jetons au coffre. Un échec n'écrit rien (ni coffre, ni
/// base). `env.client` doit porter l'ID client iOS (`IosClientConfig::into_client`) ; un autre ID donne `config-missing`.
pub async fn authorize_ios(env: &HttpEnv<'_>, token_ref: &str, runner: Arc<dyn WebAuthRunner>, session: &WebAuthSession) -> Result<(), String> {
    let config = env.client.ok_or_else(|| failed("config-missing"))?;
    let (scheme, redirect_uri) = ios_redirect(&config.client_id).ok_or_else(|| failed("config-missing"))?;
    let Some(_guard) = session.acquire() else { return Err(failed("web-auth-unavailable")) };
    let verifier = google::random_verifier();
    let state = google::random_state();
    let auth_url = google::build_auth_url(env.google, &config.client_id, &redirect_uri, &state, &google::pkce_challenge(&verifier)).map_err(|code| failed(&code))?;
    let parsed = Url::parse(&auth_url).map_err(|_| failed("web-auth-failed"))?;
    if !hosts::url_allowed(&parsed) {
        return Err(failed("host-not-allowed"));
    }
    let callback = tauri::async_runtime::spawn_blocking(move || runner.authenticate(&auth_url, &scheme))
        .await
        .map_err(|_| failed("web-auth-failed"))?
        .map_err(|error| failed(error.code()))?;
    let code = parse_redirect(&callback, &redirect_uri, &state).map_err(|code| failed(&code))?;
    let exchange_config = ClientConfig { client_id: config.client_id.clone(), client_secret: None };
    let tokens = google::exchange_code(env, &exchange_config, &code, &verifier, &redirect_uri).await.map_err(|code| failed(&code))?;
    google::store_tokens(env.vault, token_ref, &tokens).map_err(|code| failed(&code))
}
