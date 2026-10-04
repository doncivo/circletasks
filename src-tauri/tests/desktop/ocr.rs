//! OCR Windows (Q-04) : contrôle des entrées, nettoyage des lignes, et lecture réelle d'images de test
//! (tests/fixtures/ocr) avec Windows.Media.Ocr si le pack de langue français est installé.

use circletasks_lib::ocr::{check_dimensions, clean_lines, pick_french, recognize_bytes, sniff_image, status, validate_image, ImageKind, OcrError, MAX_IMAGE_BYTES, MAX_LINES};

const PRINTED: &[u8] = include_bytes!("../../../tests/fixtures/ocr/liste-imprimee.png");
const PHOTO: &[u8] = include_bytes!("../../../tests/fixtures/ocr/photo-liste.jpg");
const BULLETS: &[u8] = include_bytes!("../../../tests/fixtures/ocr/liste-puces.png");
const BLANK: &[u8] = include_bytes!("../../../tests/fixtures/ocr/page-vide.png");

fn texts(bytes: &[u8]) -> Vec<String> {
    recognize_bytes(bytes).expect("lecture").lines.into_iter().map(|line| line.text).collect()
}

/// Sans pack français (poste neuf), les tests de lecture réelle sont ignorés : la marche à suivre est dans l'app (Q-04 critère 11).
fn french_pack_installed() -> bool {
    let installed = status().available;
    if !installed {
        eprintln!("pack de langue français absent : lecture réelle ignorée (Paramètres › Heure et langue › Langue et région › Français › Options de langue › Reconnaissance de texte)");
    }
    installed
}

#[test]
fn sniffs_formats_from_magic_bytes_only() {
    assert_eq!(sniff_image(PRINTED), Some(ImageKind::Png));
    assert_eq!(sniff_image(PHOTO), Some(ImageKind::Jpeg));
    assert_eq!(sniff_image(b"BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"), Some(ImageKind::Bmp));
    assert_eq!(sniff_image(b"RIFF....WEBP"), None);
    assert_eq!(sniff_image(b"GIF89a......"), None);
    assert_eq!(sniff_image(b"%PDF-1.7"), None);
    assert_eq!(sniff_image(b"BM"), None);
}

#[test]
fn rejects_empty_oversized_and_unknown_inputs() {
    assert_eq!(validate_image(&[]), Err(OcrError::EmptyImage));
    let mut huge = vec![0xFF, 0xD8, 0xFF];
    huge.resize(MAX_IMAGE_BYTES + 1, 0);
    assert_eq!(validate_image(&huge), Err(OcrError::TooLarge));
    assert_eq!(validate_image(b"just some text"), Err(OcrError::UnsupportedFormat));
    assert_eq!(validate_image(PRINTED), Ok(ImageKind::Png));
    // À la limite exacte, l'image passe.
    let mut limit = vec![0xFF, 0xD8, 0xFF];
    limit.resize(MAX_IMAGE_BYTES, 0);
    assert_eq!(validate_image(&limit), Ok(ImageKind::Jpeg));
}

#[test]
fn error_codes_are_stable_for_the_front() {
    let codes: Vec<&str> =
        [OcrError::EmptyImage, OcrError::TooLarge, OcrError::UnsupportedFormat, OcrError::DimensionsTooLarge, OcrError::LanguageMissing, OcrError::Unavailable, OcrError::Engine("x".into())]
            .iter()
            .map(OcrError::code)
            .collect();
    assert_eq!(
        codes,
        ["ocr-empty-image", "ocr-too-large", "ocr-unsupported-format", "ocr-dimensions-too-large", "ocr-language-missing", "ocr-unavailable", "ocr-engine"]
    );
}

#[test]
fn cleans_blank_lines_control_characters_and_spacing() {
    let cleaned: Vec<String> = clean_lines(["  Appeler   le plombier ", "", "   ", "Acheter\u{0}des\tampoules", "\r\n", "Payer"]).into_iter().map(|l| l.text).collect();
    assert_eq!(cleaned, ["Appeler le plombier", "Acheter des ampoules", "Payer"]);
}

#[test]
fn keeps_accents_and_caps_the_number_of_lines() {
    let many: Vec<String> = (0..MAX_LINES + 50).map(|i| format!("Ligne {i} é")).collect();
    let cleaned = clean_lines(&many);
    assert_eq!(cleaned.len(), MAX_LINES);
    assert_eq!(cleaned[0].text, "Ligne 0 é");
}

#[test]
fn picks_french_preferring_fr_fr() {
    let list = |tags: &[&str]| tags.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>();
    assert_eq!(pick_french(&list(&["en-US", "fr-CA", "fr-FR"])), Some(&"fr-FR".to_owned()));
    assert_eq!(pick_french(&list(&["en-US", "fr-CA"])), Some(&"fr-CA".to_owned()));
    assert_eq!(pick_french(&list(&["fr"])), Some(&"fr".to_owned()));
    assert_eq!(pick_french(&list(&["en-US", "de-DE", "fra-X"])), None);
    assert_eq!(pick_french(&[]), None);
}

#[test]
fn status_never_fails_and_reports_consistently() {
    let state = status();
    assert_eq!(state.available, pick_french(&state.languages).is_some());
}

#[cfg(windows)]
#[test]
fn reads_a_printed_french_list_with_windows_media_ocr() {
    if !french_pack_installed() {
        return;
    }
    let lines = texts(PRINTED);
    let joined = lines.join(" | ").to_lowercase();
    for expected in ["plombier", "ampoules", "restaurant", "cantine", "garage"] {
        assert!(joined.contains(expected), "« {expected} » absent de la lecture : {joined}");
    }
    // Les accents du français passent : « Réserver ».
    assert!(joined.contains("réserver"), "{joined}");
    assert!(lines.len() >= 5, "une ligne par tâche : {lines:?}");
}

#[cfg(windows)]
#[test]
fn reads_a_jpeg_photo_and_keeps_bullets_for_the_front_to_strip() {
    if !french_pack_installed() {
        return;
    }
    let photo = texts(PHOTO).join(" | ").to_lowercase();
    assert!(photo.contains("plombier") && photo.contains("cantine"), "{photo}");
    let bullets = texts(BULLETS).join(" | ").to_lowercase();
    assert!(bullets.contains("notaire") && bullets.contains("facture"), "{bullets}");
}

#[cfg(windows)]
#[test]
fn a_blank_page_gives_no_line() {
    if !french_pack_installed() {
        return;
    }
    assert!(texts(BLANK).is_empty());
}

#[cfg(windows)]
#[test]
fn garbage_that_looks_like_a_png_is_an_engine_error_not_a_crash() {
    if !french_pack_installed() {
        return;
    }
    let mut fake = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    fake.extend_from_slice(&[0; 64]);
    assert!(matches!(recognize_bytes(&fake), Err(OcrError::UnsupportedFormat | OcrError::Engine(_))));
}

/// Q-04 : l'image n'est jamais conservée. Aucun fichier ne doit apparaître dans le dossier temporaire
/// pendant une lecture, qu'elle réussisse ou échoue.
fn temp_entries() -> std::collections::BTreeSet<std::ffi::OsString> {
    std::fs::read_dir(std::env::temp_dir())
        .map(|dir| dir.filter_map(Result::ok).map(|e| e.file_name()).collect())
        .unwrap_or_default()
}

#[test]
fn q04_no_temporary_file_is_left_after_success_or_error() {
    let before = temp_entries();
    // Erreurs de validation (sans moteur) et, si le pack est là, lectures réelles.
    let _ = recognize_bytes(&[]);
    let _ = recognize_bytes(b"not an image");
    let _ = recognize_bytes(&vec![0u8; MAX_IMAGE_BYTES + 1]);
    let mut fake = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    fake.extend_from_slice(&[0; 64]);
    let _ = recognize_bytes(&fake);
    let _ = recognize_bytes(BLANK);
    let _ = recognize_bytes(PRINTED);
    let _ = recognize_bytes(PHOTO);
    let after = temp_entries();
    let created: Vec<_> = after.difference(&before).filter(|n| !n.to_string_lossy().starts_with("cargo") && !n.to_string_lossy().starts_with("rust")).collect();
    assert!(created.is_empty(), "fichiers temporaires restants : {created:?}");
}

#[test]
fn q04_ocr_sources_never_write_to_disk() {
    for source in [include_str!("../../src/ocr/mod.rs"), include_str!("../../src/ocr/win.rs")] {
        for forbidden in ["fs::write", "File::create", "OpenOptions", "temp_dir", "tempfile", "create_dir"] {
            let code: String = source.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            assert!(!code.contains(forbidden), "{forbidden} trouvé dans le code OCR");
        }
    }
}

#[test]
fn q04_missing_french_pack_is_reported_not_crashed() {
    // Avec ou sans pack, l'état ne plante jamais ; sans pack, la lecture échoue avec un code stable.
    let s = status();
    if !s.available {
        let err = recognize_bytes(PRINTED).unwrap_err();
        assert!(matches!(err, OcrError::LanguageMissing | OcrError::Unavailable));
    }
}

#[test]
fn declared_dimensions_are_checked_before_any_allocation() {
    assert_eq!(check_dimensions(2000, 1500, 4096), Ok(()));
    assert_eq!(check_dimensions(4096, 4096, 4096), Ok(()));
    assert_eq!(check_dimensions(4097, 10, 4096), Err(OcrError::DimensionsTooLarge));
    assert_eq!(check_dimensions(100_000, 100_000, 200_000), Err(OcrError::DimensionsTooLarge));
    assert_eq!(check_dimensions(0, 10, 4096), Err(OcrError::DimensionsTooLarge));
}

/// BMP de 54 octets qui déclare 30 000 x 30 000 pixels : refusé sans allouer les 3,6 Go d'un bitmap.
#[cfg(windows)]
#[test]
fn a_tiny_image_declaring_huge_dimensions_is_refused() {
    if !french_pack_installed() {
        return;
    }
    // PNG valide de quelques dizaines d'octets dont l'en-tête IHDR déclare 30 000 × 30 000 pixels :
    // le décodeur Windows le lit, le contrôle des dimensions doit le refuser avant toute conversion.
    // (Un BMP tronqué serait rejeté plus tôt comme format non pris en charge, sans exercer ce contrôle.)
    let png = png_declaring(30_000, 30_000);
    let started = std::time::Instant::now();
    let result = recognize_bytes(&png);
    assert!(matches!(result, Err(OcrError::DimensionsTooLarge)), "{result:?}");
    assert!(started.elapsed().as_secs() < 5);
}

/// PNG minimal (signature, IHDR, IDAT d'un zlib vide, IEND) aux CRC corrects, déclarant `width` × `height`.
fn png_declaring(width: u32, height: u32) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        let len = u32::try_from(data.len()).expect("bloc PNG trop grand");
        out.extend_from_slice(&len.to_be_bytes());
        let mut typed = kind.to_vec();
        typed.extend_from_slice(data);
        out.extend_from_slice(&typed);
        out.extend_from_slice(&crc32(&typed).to_be_bytes());
    }
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 bits, RGBA, compression, filtre, sans entrelacement
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &[0x78, 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
    chunk(&mut out, b"IEND", &[]);
    out
}
