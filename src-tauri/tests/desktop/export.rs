//! Export de fichiers (H-03) : règles de la commande Rust `export_save_file` / `reveal_exported_file`.

use circletasks_lib::export::{check_reveal, decode_name, is_unc, sanitize_file_name};
use std::path::Path;

#[test]
fn only_the_last_exported_path_can_be_revealed() {
    let last = Path::new("C:\\Users\\Ali\\Documents\\circletasks-taches-2026-10-04.csv");
    assert!(check_reveal(Some(last), "C:\\Users\\Ali\\Documents\\circletasks-taches-2026-10-04.csv").is_ok());
    assert!(check_reveal(Some(last), "C:\\Windows\\System32\\cmd.exe").is_err());
    assert!(check_reveal(None, "C:\\Users\\Ali\\Documents\\circletasks-taches-2026-10-04.csv").is_err(), "rien exporté : rien à afficher");
}

#[test]
fn network_paths_are_refused_even_if_they_match() {
    let unc = "\\\\serveur\\partage\\rapport.pdf";
    assert!(is_unc(unc) && is_unc("//serveur/partage/x") && is_unc("\\\\?\\UNC\\serveur\\x"));
    assert!(!is_unc("C:\\Docs\\x.csv"));
    assert!(check_reveal(Some(Path::new(unc)), unc).is_err());
}

#[test]
fn suggested_names_are_reduced_to_a_plain_file_name() {
    assert_eq!(sanitize_file_name("circletasks-rapport-2026-09.pdf"), "circletasks-rapport-2026-09.pdf");
    assert_eq!(sanitize_file_name("..\\..\\Windows\\evil.exe"), "evil.exe");
    assert_eq!(sanitize_file_name("a/b/c.csv"), "c.csv");
    assert_eq!(sanitize_file_name("x:y*z?.csv"), "xyz.csv");
    assert_eq!(sanitize_file_name("..."), "export");
}

#[test]
fn the_name_header_is_base64_of_utf8() {
    // « Réunion.csv »
    assert_eq!(decode_name("UsOpdW5pb24uY3N2").as_deref(), Some("Réunion.csv"));
    assert_eq!(decode_name("***"), None);
}
