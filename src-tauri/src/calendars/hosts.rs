//! Liste des hôtes autorisés pour les agendas externes (ADR 0008). Toute requête de `calendar_http`
//! et toute redirection suivie passent par `is_allowed`. Seul HTTPS est accepté, sauf `127.0.0.1`
//! en build de debug (simulateurs de tests/sim).

/// Hôtes exacts autorisés (Google OAuth et API, découverte iCloud CalDAV).
pub const ALLOWED_HOSTS: [&str; 4] = ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "caldav.icloud.com"];

/// Serveurs CalDAV iCloud attribués après découverte : `pNN-caldav.icloud.com` (NN : 1 à 3 chiffres).
fn is_icloud_partition(host: &str) -> bool {
    let Some(prefix) = host.strip_suffix("-caldav.icloud.com") else { return false };
    let Some(digits) = prefix.strip_prefix('p') else { return false };
    !digits.is_empty() && digits.len() <= 3 && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `scheme` et `host` viennent d'une URL déjà analysée (crate `url`), hôte en minuscules.
pub fn is_allowed(scheme: &str, host: &str, allow_loopback: bool) -> bool {
    match scheme {
        "https" => ALLOWED_HOSTS.contains(&host) || is_icloud_partition(host),
        "http" => allow_loopback && host == "127.0.0.1",
        _ => false,
    }
}

/// Autorisation d'une URL complète (requête initiale et chaque redirection). Le build de debug accepte `127.0.0.1` (simulateurs).
pub fn url_allowed(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| is_allowed(url.scheme(), host, cfg!(debug_assertions)))
}

/// Fournisseur auquel une authentification est liée (le secret ne part que vers SES hôtes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScope {
    /// `Authorization: Bearer` Google : seulement `www.googleapis.com`.
    Google,
    /// `Authorization: Basic` iCloud : seulement `caldav.icloud.com` et `pNN-caldav.icloud.com`.
    Basic,
}

/// L'authentification `scope` peut-elle être envoyée à cette URL ? (HTTPS, hôte du fournisseur ; le build de debug accepte
/// `127.0.0.1` pour les simulateurs.)
pub fn auth_allowed(scope: AuthScope, url: &url::Url) -> bool {
    if !url_allowed(url) {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if cfg!(debug_assertions) && url.scheme() == "http" && host == "127.0.0.1" {
        return true;
    }
    match scope {
        AuthScope::Google => host == "www.googleapis.com",
        AuthScope::Basic => host == "caldav.icloud.com" || is_icloud_partition(host),
    }
}

#[cfg(test)]
mod tests {
    use super::is_allowed;

    #[test]
    fn accepte_les_hotes_google_et_icloud_en_https() {
        assert!(is_allowed("https", "www.googleapis.com", false));
        assert!(is_allowed("https", "caldav.icloud.com", false));
        assert!(is_allowed("https", "p42-caldav.icloud.com", false));
        assert!(is_allowed("https", "p123-caldav.icloud.com", false));
    }

    #[test]
    fn refuse_le_reste() {
        assert!(!is_allowed("http", "www.googleapis.com", false));
        assert!(!is_allowed("https", "p-caldav.icloud.com", false));
        assert!(!is_allowed("https", "p1234-caldav.icloud.com", false));
        assert!(!is_allowed("https", "evil-caldav.icloud.com", false));
        assert!(!is_allowed("https", "caldav.icloud.com.evil.example", false));
        assert!(!is_allowed("http", "127.0.0.1", false));
        assert!(!is_allowed("http", "localhost", true));
        assert!(is_allowed("http", "127.0.0.1", true));
    }
}
