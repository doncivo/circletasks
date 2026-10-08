//! Expiration de la signature de l'app iPhone (I-02, ADR 0013 section 3.1).
//!
//! SideStore signe l'app avec un Apple ID gratuit : le profil de provisionnement (7 jours) est écrit dans le paquet sous le nom
//! `embedded.mobileprovision`, à l'installation et à chaque actualisation. La commande `app_signing_info` (iOS seulement, asynchrone)
//! lit ce fichier et n'en rend que deux dates, `ExpirationDate` et `CreationDate`, en UTC.
//!
//! - Le fichier est un CMS (PKCS #7) dont le contenu est un plist XML en clair : on prend les octets entre le premier `<?xml` et le premier
//!   `</plist>` qui le suit (UTF-8 strict), puis seulement `<key>ExpirationDate</key>` et `<key>CreationDate</key>` suivies de leur
//!   `<date>AAAA-MM-JJTHH:MM:SSZ</date>`. Aucune vérification de signature CMS (le fichier est couvert par la signature du paquet).
//! - Rien d'autre n'est lu ni rendu : ni identifiant d'équipe, ni appareils, ni certificats, ni droits, ni nom du profil. Le fichier lu est
//!   toujours `embedded.mobileprovision` à côté de l'exécutable, jamais un autre chemin.
//! - Rejets : `profile-missing` (fichier absent), `profile-unreadable` (tout autre cas : pas un fichier ordinaire, vide, plus de 256 Kio,
//!   plist absent ou tronqué, clé dupliquée ou absente, date hors format ou invalide, année hors [2020 ; 2100], durée supérieure à 400 jours).
//!
//! Pas de crate `plist` : l'analyse est bornée et écrite à la main. Le module est compilé sur toutes les cibles (testé sous Windows) ;
//! seule la commande est sous `cfg(target_os = "ios")`.

use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// Nom du fichier lu dans le dossier de l'exécutable.
pub const PROFILE_FILE: &str = "embedded.mobileprovision";
/// Taille maximale acceptée (256 Kio).
pub const MAX_PROFILE_BYTES: u64 = 256 * 1024;
/// Durée maximale entre création et expiration (un profil gratuit dure 7 jours).
pub const MAX_VALIDITY_SECONDS: i64 = 400 * 86_400;
/// Plage d'années acceptée.
pub const YEAR_RANGE: (i64, i64) = (2020, 2100);

/// Dates du profil en UTC, au format `AAAA-MM-JJTHH:MM:SSZ` (celui du fichier, déjà validé).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    pub expires_at: String,
    pub issued_at: Option<String>,
}

/// Échec de lecture ; le code seul est rendu au JavaScript et au journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningError {
    ProfileMissing,
    ProfileUnreadable,
}

impl SigningError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ProfileMissing => "profile-missing",
            Self::ProfileUnreadable => "profile-unreadable",
        }
    }
}

/// Octets du premier `needle` dans `haystack` à partir de `from`.
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || from > haystack.len() - needle.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|window| window == needle).map(|offset| offset + from)
}

/// Le plist XML du profil : de `<?xml` à `</plist>` compris, UTF-8 strict.
fn extract_plist(bytes: &[u8]) -> Result<&str, SigningError> {
    const END: &[u8] = b"</plist>";
    let start = find(bytes, b"<?xml", 0).ok_or(SigningError::ProfileUnreadable)?;
    let end = find(bytes, END, start).ok_or(SigningError::ProfileUnreadable)? + END.len();
    std::str::from_utf8(&bytes[start..end]).map_err(|_| SigningError::ProfileUnreadable)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(year) => 29,
        _ => 28,
    }
}

/// Jours depuis 1970-01-01 (calendrier grégorien proleptique, algorithme de H. Hinnant).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `AAAA-MM-JJTHH:MM:SSZ` strict : 20 caractères, chiffres ASCII, date et heure valides, année dans la plage. Rend les secondes depuis l'époque.
fn parse_utc(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let digits = &b[from..to];
        if digits.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(digits).ok()?.parse().ok()
        } else {
            None
        }
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < YEAR_RANGE.0 || year > YEAR_RANGE.1 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Valeur `<date>…</date>` de la clé `name` ; `Ok(None)` si la clé est absente ; clé dupliquée, ou valeur qui ne suit pas la clé : illisible.
fn date_of<'a>(plist: &'a str, name: &str) -> Result<Option<&'a str>, SigningError> {
    let key = format!("<key>{name}</key>");
    let Some(first) = plist.find(&key) else { return Ok(None) };
    if plist[first + key.len()..].contains(&key) {
        return Err(SigningError::ProfileUnreadable);
    }
    let after = plist[first + key.len()..].trim_start_matches([' ', '\t', '\r', '\n']);
    let value = after.strip_prefix("<date>").ok_or(SigningError::ProfileUnreadable)?;
    let end = value.find("</date>").ok_or(SigningError::ProfileUnreadable)?;
    Ok(Some(&value[..end]))
}

/// Lit `ExpirationDate` (obligatoire) et `CreationDate` (facultative) dans le contenu d'un fichier `embedded.mobileprovision`.
pub fn parse_provision(bytes: &[u8]) -> Result<SigningInfo, SigningError> {
    let plist = extract_plist(bytes)?;
    let expires_text = date_of(plist, "ExpirationDate")?.ok_or(SigningError::ProfileUnreadable)?;
    let expires = parse_utc(expires_text).ok_or(SigningError::ProfileUnreadable)?;
    let issued_text = date_of(plist, "CreationDate")?;
    if let Some(text) = issued_text {
        let issued = parse_utc(text).ok_or(SigningError::ProfileUnreadable)?;
        if issued >= expires || expires - issued > MAX_VALIDITY_SECONDS {
            return Err(SigningError::ProfileUnreadable);
        }
    }
    Ok(SigningInfo { expires_at: expires_text.to_owned(), issued_at: issued_text.map(str::to_owned) })
}

/// Ouvre le profil sans suivre de lien : `O_NOFOLLOW` sur unix (un lien symbolique est refusé à l'ouverture, sans fenêtre entre un contrôle
/// et l'ouverture) ; hors unix (tests Windows), le contrôle par `symlink_metadata` précède l'ouverture.
fn open_profile(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "lien symbolique"));
        }
    }
    options.open(path)
}

/// Lit le profil du dossier `dir` (celui de l'exécutable) : fichier ordinaire (jamais un lien), de 1 octet à 256 Kio. Le type et la taille
/// sont contrôlés sur le descripteur déjà ouvert, pas sur le chemin.
pub fn read_profile(dir: &Path) -> Result<SigningInfo, SigningError> {
    let path = dir.join(PROFILE_FILE);
    let file = open_profile(&path).map_err(|error| if error.kind() == std::io::ErrorKind::NotFound { SigningError::ProfileMissing } else { SigningError::ProfileUnreadable })?;
    let meta = file.metadata().map_err(|_| SigningError::ProfileUnreadable)?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_PROFILE_BYTES {
        return Err(SigningError::ProfileUnreadable);
    }
    // Borne aussi la lecture : un fichier qui grossit après le contrôle n'est pas lu en entier.
    let mut bytes = Vec::new();
    file.take(MAX_PROFILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| SigningError::ProfileUnreadable)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROFILE_BYTES {
        return Err(SigningError::ProfileUnreadable);
    }
    parse_provision(&bytes)
}

/// Commande iOS : dates d'expiration et de création du profil de signature de l'app. Rejet : le code seul (`profile-missing`,
/// `profile-unreadable`). Asynchrone, lecture sur un fil dédié : jamais sur le fil principal.
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn app_signing_info() -> Result<SigningInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).ok_or(SigningError::ProfileUnreadable)?;
        read_profile(&dir)
    })
    .await
    .map_err(|_| SigningError::ProfileUnreadable.code().to_owned())?
    .map_err(|error| error.code().to_owned())
}
