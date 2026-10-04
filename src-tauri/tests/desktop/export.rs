//! Export de fichiers (H-03) : règles de `export_save_file` / `reveal_exported_file` (écriture atomique, taille, chemins, noms).

use circletasks_lib::export::{allowed_extension, body_bytes, decode_name, is_local_disk_path, reveal_target, sanitize_file_name, write_atomically, write_atomically_with, MAX_EXPORT_BYTES, MAX_HEADER_LEN};
use std::io::Write;
use std::path::Path;

// --- écriture atomique (critère 9 : aucun fichier partiel) ---

#[test]
fn atomic_write_creates_the_file_and_leaves_no_temporary() {
    let dir = tempfile::tempdir().expect("dossier");
    let target = dir.path().join("rapport.csv");
    write_atomically(&target, b"titre;date\r\n").expect("écriture");
    assert_eq!(std::fs::read(&target).expect("lecture"), b"titre;date\r\n");
    let names: Vec<_> = std::fs::read_dir(dir.path()).expect("dossier").map(|e| e.expect("entrée").file_name()).collect();
    assert_eq!(names, [std::ffi::OsString::from("rapport.csv")]);
}

#[test]
fn atomic_write_replaces_an_existing_file_only_at_the_end() {
    let dir = tempfile::tempdir().expect("dossier");
    let target = dir.path().join("rapport.csv");
    std::fs::write(&target, b"ancien contenu").expect("fichier existant");
    write_atomically(&target, b"nouveau").expect("écriture");
    assert_eq!(std::fs::read(&target).expect("lecture"), b"nouveau");
}

#[test]
fn failure_in_the_middle_leaves_no_partial_file_and_keeps_the_existing_one_intact() {
    let dir = tempfile::tempdir().expect("dossier");
    let target = dir.path().join("rapport.csv");
    std::fs::write(&target, b"ancien contenu").expect("fichier existant");
    let failing = |file: &mut std::fs::File, data: &[u8]| -> std::io::Result<()> {
        file.write_all(&data[..data.len() / 2])?; // la moitié est écrite, puis le disque est plein
        Err(std::io::Error::new(std::io::ErrorKind::Other, "disque plein"))
    };
    assert!(write_atomically_with(&target, b"nouveau contenu complet", &failing).is_err());
    assert_eq!(std::fs::read(&target).expect("lecture"), b"ancien contenu", "le fichier existant n'est pas touché");
    let names: Vec<_> = std::fs::read_dir(dir.path()).expect("dossier").map(|e| e.expect("entrée").file_name()).collect();
    assert_eq!(names, [std::ffi::OsString::from("rapport.csv")], "aucun temporaire ne reste");
}

#[test]
fn failure_on_a_new_target_leaves_nothing_at_all() {
    let dir = tempfile::tempdir().expect("dossier");
    let target = dir.path().join("nouveau.pdf");
    let failing = |_: &mut std::fs::File, _: &[u8]| -> std::io::Result<()> { Err(std::io::Error::new(std::io::ErrorKind::Other, "droits")) };
    assert!(write_atomically_with(&target, b"x", &failing).is_err());
    assert_eq!(std::fs::read_dir(dir.path()).expect("dossier").count(), 0);
}

#[test]
fn a_stale_temporary_from_an_interrupted_export_does_not_block_the_next_one() {
    let dir = tempfile::tempdir().expect("dossier");
    let target = dir.path().join("rapport.csv");
    std::fs::write(dir.path().join(".rapport.csv.ct-partial"), b"reste").expect("reste");
    write_atomically(&target, b"ok").expect("écriture");
    assert_eq!(std::fs::read(&target).expect("lecture"), b"ok");
    assert_eq!(std::fs::read_dir(dir.path()).expect("dossier").count(), 1);
}

// --- taille ---

#[test]
fn bodies_above_the_cap_are_refused_before_any_copy() {
    let big = tauri::ipc::InvokeBody::Raw(vec![0u8; MAX_EXPORT_BYTES + 1]);
    assert!(body_bytes(&big).is_err());
    let at_cap = tauri::ipc::InvokeBody::Raw(vec![1u8; 16]);
    assert_eq!(body_bytes(&at_cap).expect("corps").len(), 16);
}

#[test]
fn json_array_bodies_are_accepted_as_bytes() {
    let body = tauri::ipc::InvokeBody::Json(serde_json::json!([239, 187, 191, 97]));
    assert_eq!(body_bytes(&body).expect("octets"), vec![239, 187, 191, 97]);
    assert!(body_bytes(&tauri::ipc::InvokeBody::Json(serde_json::json!([256]))).is_err());
    assert!(body_bytes(&tauri::ipc::InvokeBody::Json(serde_json::json!("texte"))).is_err());
    assert!(body_bytes(&tauri::ipc::InvokeBody::Json(serde_json::json!([-1]))).is_err());
}

// --- chemins (Windows : l'analyse des préfixes est celle de Windows) ---

#[cfg(windows)]
#[test]
fn only_local_disk_paths_are_accepted() {
    for ok in ["C:\\Users\\Ali\\Documents\\x.csv", "\\\\?\\C:\\Users\\Ali\\x.csv", "d:\\x.pdf"] {
        assert!(is_local_disk_path(Path::new(ok)), "{ok}");
        assert!(reveal_target(Some(Path::new(ok))).is_ok(), "{ok}");
    }
    for refused in [
        "\\srv\\partage\\x.csv",
        "/srv/partage/x.csv",
        "\\/srv/x.csv",
        "\\\\srv\\partage\\x.csv",
        "\\\\?\\UNC\\srv\\partage\\x.csv",
        "\\\\.\\COM1",
        "\\\\.\\C:\\x.csv",
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x.csv",
        "relatif\\x.csv",
    ] {
        assert!(!is_local_disk_path(Path::new(refused)), "{refused}");
        assert!(reveal_target(Some(Path::new(refused))).is_err(), "{refused}");
    }
}

#[test]
fn nothing_to_reveal_before_the_first_export() {
    assert!(reveal_target(None).is_err());
}

// --- nom proposé ---

#[test]
fn suggested_names_are_reduced_to_a_plain_file_name() {
    assert_eq!(sanitize_file_name("circletasks-rapport-2026-09.pdf"), "circletasks-rapport-2026-09.pdf");
    assert_eq!(sanitize_file_name("..\\..\\Windows\\evil.exe"), "evil.exe");
    assert_eq!(sanitize_file_name("a/b/c.csv"), "c.csv");
    assert_eq!(sanitize_file_name("x:y*z?.csv"), "xyz.csv");
    assert_eq!(sanitize_file_name("..."), "export");
}

#[test]
fn trailing_spaces_and_dots_are_removed() {
    assert_eq!(sanitize_file_name("rapport.csv. . "), "rapport.csv");
    assert_eq!(sanitize_file_name("rapport "), "rapport");
}

#[test]
fn reserved_device_names_are_prefixed_case_insensitively_before_the_first_dot() {
    for raw in ["CON", "con.csv", "Nul.json", "PRN.txt", "aux.png", "COM1.csv", "com9", "LPT1.pdf", "lpt9.x.csv"] {
        assert!(sanitize_file_name(raw).starts_with('_'), "{raw}");
    }
    assert_eq!(sanitize_file_name("CON.csv"), "_CON.csv");
    assert_eq!(sanitize_file_name("console.csv"), "console.csv");
    assert_eq!(sanitize_file_name("COM10.csv"), "COM10.csv");
}

#[test]
fn long_names_are_cut_to_200_characters_keeping_the_extension() {
    let long = format!("{}.csv", "a".repeat(500));
    let cut = sanitize_file_name(&long);
    assert_eq!(cut.chars().count(), 200);
    assert!(cut.ends_with(".csv"));
}

#[test]
fn only_the_export_formats_are_offered_as_a_filter() {
    assert_eq!(allowed_extension("x.CSV").as_deref(), Some("csv"));
    for ok in ["a.json", "a.pdf", "a.png"] {
        assert!(allowed_extension(ok).is_some());
    }
    for refused in ["a.exe", "a.bat", "a", "a.csv.exe"] {
        assert!(allowed_extension(refused).is_none(), "{refused}");
    }
}

#[test]
fn the_name_header_is_base64_of_utf8_and_bounded() {
    // « Réunion.csv »
    assert_eq!(decode_name("UsOpdW5pb24uY3N2").as_deref(), Some("Réunion.csv"));
    assert_eq!(decode_name("***"), None);
    assert_eq!(decode_name(&"A".repeat(MAX_HEADER_LEN + 1)), None);
}
