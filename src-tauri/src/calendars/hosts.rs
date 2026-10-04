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
