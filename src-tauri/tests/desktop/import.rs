//! P-07 : lecture du seul fichier choisi (plafond de taille, type, disque local, fichier ordinaire).

use circletasks_lib::import::{display_name, has_import_extension, read_import_file, IMPORT_EXTENSIONS, MAX_IMPORT_BYTES};
use std::fs;
use std::path::Path;

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

#[test]
fn p07_limit_is_two_megabytes_like_the_typescript_side() {
    assert_eq!(MAX_IMPORT_BYTES, 2 * 1024 * 1024);
    assert_eq!(IMPORT_EXTENSIONS, ["csv", "txt", "tsv"]);
}

#[test]
fn p07_extensions_are_case_insensitive_and_limited_to_text_tables() {
    for ok in ["C:\\a\\taches.csv", "C:\\a\\TACHES.CSV", "C:\\a\\x.txt", "C:\\a\\x.tsv"] {
        assert!(has_import_extension(Path::new(ok)), "{ok}");
    }
    for bad in ["C:\\a\\x.exe", "C:\\a\\x.csv.exe", "C:\\a\\x", "C:\\a\\x.db", "C:\\a\\x.xlsx"] {
        assert!(!has_import_extension(Path::new(bad)), "{bad}");
    }
    assert_eq!(display_name(Path::new("C:\\Users\\Ali\\Documents\\taches.csv")), "taches.csv");
}

#[test]
fn p07_reads_the_chosen_file_exactly() {
    let dir = scratch();
    let path = dir.path().join("taches.csv");
    let content = "titre;date\r\nÉcole;2026-10-05\r\n".as_bytes();
    fs::write(&path, content).unwrap();
    assert_eq!(read_import_file(&path, MAX_IMPORT_BYTES).unwrap(), content);
}

#[test]
fn p07_a_file_over_the_limit_is_refused_without_being_read() {
    let dir = scratch();
    let path = dir.path().join("gros.csv");
    fs::write(&path, vec![b'a'; 1025]).unwrap();
    assert_eq!(read_import_file(&path, 1024).unwrap_err().code, "too-large");
    fs::write(&path, vec![b'a'; 1024]).unwrap();
    assert_eq!(read_import_file(&path, 1024).unwrap().len(), 1024, "la limite est incluse");
}

#[test]
fn p07_other_types_directories_and_missing_files_are_refused() {
    let dir = scratch();
    let exe = dir.path().join("x.exe");
    fs::write(&exe, b"MZ").unwrap();
    assert_eq!(read_import_file(&exe, 1024).unwrap_err().code, "bad-type");
    let folder = dir.path().join("dossier.csv");
    fs::create_dir(&folder).unwrap();
    let error = read_import_file(&folder, 1024).unwrap_err();
    assert!(["not-a-file", "unreadable"].contains(&error.code), "un dossier n'est jamais lu : {}", error.code);
    assert_eq!(read_import_file(&dir.path().join("absent.csv"), 1024).unwrap_err().code, "unreadable");
}

#[test]
fn p07_network_and_relative_paths_are_refused_before_any_access() {
    for path in ["\\\\serveur\\partage\\x.csv", "\\\\?\\UNC\\serveur\\partage\\x.csv", "\\\\.\\C:\\x.csv", "x.csv", "/srv/x.csv"] {
        assert_eq!(read_import_file(Path::new(path), 1024).unwrap_err().code, "not-local", "{path}");
    }
}
