//! I-02 (ADR 0013 §3.1, fiche I-02 critère 2) : lecture bornée de `embedded.mobileprovision`. Profil factice (plist XML entouré d'octets
//! binaires), sans `ExpirationDate`, clé dupliquée, date invalide, vide, tronqué, trop gros, sans `CreationDate`, absent, lien, dossier.
//! La sortie ne contient jamais l'identifiant d'équipe ni les appareils présents dans le profil factice.

use circletasks_lib::signing::{parse_provision, read_profile, SigningError, SigningInfo, MAX_PROFILE_BYTES, PROFILE_FILE};

const EXPIRES: &str = "2026-10-15T09:12:34Z";
const ISSUED: &str = "2026-10-08T09:12:34Z";

/// Plist d'un profil gratuit SideStore, avec des champs sensibles qui ne doivent jamais ressortir.
fn plist(body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\t<key>AppIDName</key>\n\t<string>CircleTasks</string>\n\t<key>TeamIdentifier</key>\n\t<array>\n\t\t<string>ABCDE12345</string>\n\t</array>\n\t<key>ProvisionedDevices</key>\n\t<array>\n\t\t<string>00008140-001234567890001C</string>\n\t</array>\n{body}\n\t<key>Name</key>\n\t<string>iOS Team Provisioning Profile</string>\n</dict>\n</plist>"
    )
}

fn dates(created: Option<&str>, expires: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(created) = created {
        out.push_str(&format!("\t<key>CreationDate</key>\n\t<date>{created}</date>\n"));
    }
    if let Some(expires) = expires {
        out.push_str(&format!("\t<key>ExpirationDate</key>\n\t<date>{expires}</date>\n"));
    }
    out
}

/// Fichier CMS factice : octets binaires, plist, octets binaires (signature).
fn cms(plist: &str) -> Vec<u8> {
    let mut bytes = vec![0x30, 0x82, 0x0b, 0xc2, 0x06, 0x09, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28];
    bytes.extend_from_slice(plist.as_bytes());
    bytes.extend_from_slice(&[0xa0, 0x82, 0x03, 0x00, 0x00, 0xff, 0x01, 0x02]);
    bytes
}

fn parse(body: &str) -> Result<SigningInfo, SigningError> {
    parse_provision(&cms(&plist(body)))
}

#[test]
fn reads_both_dates_from_a_plist_surrounded_by_binary_bytes() {
    let info = parse(&dates(Some(ISSUED), Some(EXPIRES))).unwrap();
    assert_eq!(info, SigningInfo { expires_at: EXPIRES.into(), issued_at: Some(ISSUED.into()) });
}

#[test]
fn creation_date_is_optional() {
    let info = parse(&dates(None, Some(EXPIRES))).unwrap();
    assert_eq!(info, SigningInfo { expires_at: EXPIRES.into(), issued_at: None });
}

#[test]
fn whitespace_between_key_and_date_is_tolerated() {
    let info = parse(&format!("<key>ExpirationDate</key>\r\n\t  <date>{EXPIRES}</date>")).unwrap();
    assert_eq!(info.expires_at, EXPIRES);
}

#[test]
fn output_never_carries_team_identifier_devices_or_name() {
    let info = parse(&dates(Some(ISSUED), Some(EXPIRES))).unwrap();
    let json = serde_json::to_string(&info).unwrap();
    assert_eq!(json, format!("{{\"expiresAt\":\"{EXPIRES}\",\"issuedAt\":\"{ISSUED}\"}}"));
    for secret in ["ABCDE12345", "00008140", "TeamIdentifier", "ProvisionedDevices", "Provisioning Profile", "CircleTasks"] {
        assert!(!json.contains(secret), "{secret}");
    }
    let without_issue = serde_json::to_string(&parse(&dates(None, Some(EXPIRES))).unwrap()).unwrap();
    assert_eq!(without_issue, format!("{{\"expiresAt\":\"{EXPIRES}\",\"issuedAt\":null}}"));
}

#[test]
fn missing_expiration_date_is_unreadable() {
    assert_eq!(parse(&dates(Some(ISSUED), None)), Err(SigningError::ProfileUnreadable));
}

#[test]
fn duplicated_keys_are_unreadable() {
    let twice = format!("{}{}", dates(Some(ISSUED), Some(EXPIRES)), dates(None, Some("2026-10-16T09:12:34Z")));
    assert_eq!(parse(&twice), Err(SigningError::ProfileUnreadable));
    let twice_issue = format!("{}{}", dates(Some(ISSUED), Some(EXPIRES)), dates(Some(ISSUED), None));
    assert_eq!(parse(&twice_issue), Err(SigningError::ProfileUnreadable));
}

#[test]
fn malformed_or_impossible_dates_are_unreadable() {
    for bad in [
        "2026-10-15 09:12:34Z",
        "2026-10-15T09:12:34",
        "2026-10-15T09:12:34+02:00",
        "2026-10-15T09:12Z",
        "2026-13-15T09:12:34Z",
        "2026-02-30T09:12:34Z",
        "2027-02-29T09:12:34Z",
        "2026-10-15T24:00:00Z",
        "2026-10-15T09:60:00Z",
        "2026-10-15T09:12:60Z",
        "2026-10-15T09:12:3\u{0664}Z",
        "+026-10-15T09:12:34Z",
        "2019-12-31T23:59:59Z",
        "2101-01-01T00:00:00Z",
        "",
    ] {
        assert_eq!(parse(&dates(None, Some(bad))), Err(SigningError::ProfileUnreadable), "{bad}");
    }
}

#[test]
fn leap_day_and_year_bounds_are_accepted() {
    assert!(parse(&dates(None, Some("2028-02-29T00:00:00Z"))).is_ok());
    assert!(parse(&dates(None, Some("2020-01-01T00:00:00Z"))).is_ok());
    assert!(parse(&dates(None, Some("2100-12-31T23:59:59Z"))).is_ok());
}

#[test]
fn creation_not_before_expiration_or_longer_than_400_days_is_unreadable() {
    assert_eq!(parse(&dates(Some(EXPIRES), Some(EXPIRES))), Err(SigningError::ProfileUnreadable));
    assert_eq!(parse(&dates(Some("2026-10-16T00:00:00Z"), Some(EXPIRES))), Err(SigningError::ProfileUnreadable));
    // 400 jours exactement : accepté ; un jour de plus : refusé.
    assert!(parse(&dates(Some("2025-09-10T09:12:34Z"), Some("2026-10-15T09:12:34Z"))).is_ok());
    assert_eq!(parse(&dates(Some("2025-09-09T09:12:34Z"), Some("2026-10-15T09:12:34Z"))), Err(SigningError::ProfileUnreadable));
    // Une CreationDate invalide rend aussi le profil illisible (jamais ignorée).
    assert_eq!(parse(&dates(Some("hier"), Some(EXPIRES))), Err(SigningError::ProfileUnreadable));
}

#[test]
fn a_date_that_does_not_follow_its_key_is_unreadable() {
    let detached = format!("<key>ExpirationDate</key>\n<string>x</string>\n<date>{EXPIRES}</date>");
    assert_eq!(parse(&detached), Err(SigningError::ProfileUnreadable));
    assert_eq!(parse("<key>ExpirationDate</key>\n<date>2026-10-15T09:12:34Z"), Err(SigningError::ProfileUnreadable));
}

#[test]
fn empty_truncated_or_non_plist_content_is_unreadable() {
    assert_eq!(parse_provision(b""), Err(SigningError::ProfileUnreadable));
    assert_eq!(parse_provision(&[0x30, 0x82, 0xff, 0x00]), Err(SigningError::ProfileUnreadable));
    let full = cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))));
    // Tronqué avant la fin du plist.
    let cut = full.windows(8).position(|w| w == b"</plist>").unwrap();
    assert_eq!(parse_provision(&full[..cut]), Err(SigningError::ProfileUnreadable));
    // Tronqué avant `<?xml`.
    assert_eq!(parse_provision(&full[..6]), Err(SigningError::ProfileUnreadable));
    // `</plist>` avant `<?xml` seulement.
    assert_eq!(parse_provision(b"</plist><?xml version=\"1.0\"?>"), Err(SigningError::ProfileUnreadable));
}

#[test]
fn invalid_utf8_inside_the_plist_is_unreadable() {
    let mut bytes = b"<?xml version=\"1.0\"?><plist><dict>\xff\xfe".to_vec();
    bytes.extend_from_slice(format!("<key>ExpirationDate</key><date>{EXPIRES}</date></dict></plist>").as_bytes());
    assert_eq!(parse_provision(&bytes), Err(SigningError::ProfileUnreadable));
}

#[test]
fn only_the_first_plist_is_read() {
    let mut bytes = cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))));
    bytes.extend_from_slice(plist(&dates(Some(ISSUED), Some("2027-01-01T00:00:00Z"))).as_bytes());
    assert_eq!(parse_provision(&bytes).unwrap().expires_at, EXPIRES);
}

#[test]
fn error_codes_are_the_two_documented_strings() {
    assert_eq!(SigningError::ProfileMissing.code(), "profile-missing");
    assert_eq!(SigningError::ProfileUnreadable.code(), "profile-unreadable");
}

// --- Lecture du fichier du paquet ---------------------------------------------------------------------------------------------

#[test]
fn reads_the_profile_next_to_the_executable_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(PROFILE_FILE), cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))))).unwrap();
    // Un autre profil du même dossier n'est jamais lu.
    std::fs::write(dir.path().join("other.mobileprovision"), cms(&plist(&dates(None, Some("2027-01-01T00:00:00Z"))))).unwrap();
    assert_eq!(read_profile(dir.path()).unwrap().expires_at, EXPIRES);
}

#[test]
fn missing_file_is_profile_missing() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileMissing));
    assert_eq!(read_profile(&dir.path().join("absent")), Err(SigningError::ProfileMissing));
}

#[test]
fn empty_file_directory_and_oversized_file_are_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(PROFILE_FILE);
    std::fs::write(&path, b"").unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileUnreadable));
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileUnreadable));
    std::fs::remove_dir(&path).unwrap();

    // Plus de 256 Kio, même avec un plist valide au début : refusé sans lecture.
    let mut big = cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))));
    big.resize(MAX_PROFILE_BYTES as usize + 1, 0);
    std::fs::write(&path, &big).unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileUnreadable));
    // Exactement 256 Kio : lu.
    big.truncate(MAX_PROFILE_BYTES as usize);
    std::fs::write(&path, &big).unwrap();
    assert_eq!(read_profile(dir.path()).unwrap().expires_at, EXPIRES);
}

#[test]
fn truncated_file_is_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let full = cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))));
    std::fs::write(dir.path().join(PROFILE_FILE), &full[..full.len() / 2]).unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileUnreadable));
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_never_followed() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("real");
    std::fs::write(&target, cms(&plist(&dates(Some(ISSUED), Some(EXPIRES))))).unwrap();
    std::os::unix::fs::symlink(&target, dir.path().join(PROFILE_FILE)).unwrap();
    assert_eq!(read_profile(dir.path()), Err(SigningError::ProfileUnreadable));
}

#[test]
fn source_reads_only_the_two_documented_keys() {
    const SOURCE: &str = include_str!("../../src/signing.rs");
    let code: String = SOURCE.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    assert_eq!(code.matches("date_of(plist, \"").count(), 2);
    for forbidden in ["TeamIdentifier", "ProvisionedDevices", "DeveloperCertificates", "Entitlements", "UUID", "ApplicationIdentifierPrefix"] {
        assert!(!code.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn source_opens_without_following_links_and_checks_the_descriptor() {
    const SOURCE: &str = include_str!("../../src/signing.rs");
    let code: String = SOURCE.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    assert!(code.contains("libc::O_NOFOLLOW"));
    assert!(code.contains("file.metadata()"));
    // Le contrôle de taille et de type ne passe plus par le chemin (hors garde de lien des cibles non unix).
    assert_eq!(code.matches("symlink_metadata").count(), 1);
}
