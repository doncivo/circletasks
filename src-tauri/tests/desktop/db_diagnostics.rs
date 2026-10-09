//! 0.2.1 : diagnostic d'ouverture de la base (commande `db_diagnostics`).

use circletasks_lib::backup::{diagnose_db_dir, DB_FILE};
use std::fs;

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

#[test]
fn dossier_absent() {
    let dir = scratch();
    let missing = dir.path().join("absent");
    let report = diagnose_db_dir(Ok(missing.clone()));
    assert!(!report.dir_exists);
    assert!(!report.file_exists);
    assert_eq!(report.db_path.as_deref(), Some(missing.join(DB_FILE).to_string_lossy().as_ref()));
}

#[test]
fn fichier_present_avec_taille_et_wal() {
    let dir = scratch();
    fs::write(dir.path().join(DB_FILE), b"1234").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"").unwrap();
    let report = diagnose_db_dir(Ok(dir.path().to_path_buf()));
    assert!(report.dir_exists && report.file_exists && report.wal_exists);
    assert_eq!(report.file_bytes, Some(4));
}

#[test]
fn dossier_introuvable() {
    let report = diagnose_db_dir(Err("aucun dossier".into()));
    assert_eq!(report.config_dir_error.as_deref(), Some("aucun dossier"));
    assert!(report.config_dir.is_none() && report.db_path.is_none());
}
