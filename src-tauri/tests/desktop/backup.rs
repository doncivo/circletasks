//! Sauvegarde avant migration (D-03 critères 8 et 9) : copie réelle d'une base SQLite en mode WAL.

use circletasks_lib::backup::{
    create_migration_backup, is_valid_stamp, migration_backup_name, prune_migration_backups, BACKUP_DIR, DB_FILE,
    KEEP_MIGRATION_BACKUPS,
};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn make_db(dir: &Path, rows: u32) -> Connection {
    let conn = Connection::open(dir.join(DB_FILE)).expect("open");
    conn.pragma_update(None, "journal_mode", "WAL").expect("wal");
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", []).expect("create");
    for i in 0..rows {
        conn.execute("INSERT INTO t (v) VALUES (?1)", [format!("ligne {i}")]).expect("insert");
    }
    conn
}

fn count(path: &Path) -> u32 {
    let conn = Connection::open(path).expect("open backup");
    conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).expect("count")
}

#[test]
fn stamp_and_name_format() {
    assert!(is_valid_stamp("20261002T101500Z"));
    assert!(!is_valid_stamp("../../etc/passwd"));
    assert!(!is_valid_stamp("2026-10-02"));
    assert_eq!(
        migration_backup_name(2, 4, "20261002T101500Z"),
        "circletasks-pre-migration-v0002-to-v0004-20261002T101500Z.db"
    );
}

#[test]
fn copies_a_wal_database_with_all_rows_even_without_checkpoint() {
    let dir = tempfile::tempdir().expect("tmp");
    // Connexion gardée ouverte : les lignes sont encore dans le -wal (pas de checkpoint).
    let conn = make_db(dir.path(), 50);
    let backups = dir.path().join(BACKUP_DIR);
    let out = create_migration_backup(&dir.path().join(DB_FILE), &backups, 2, 4, "20261002T101500Z", 5).expect("backup");
    let copy = out.path.expect("fichier créé");
    assert!(Path::new(&copy).starts_with(dir.path()), "dans le dossier de données, sous backups/");
    assert_eq!(count(Path::new(&copy)), 50);
    // La base source est intacte.
    assert_eq!(count(&dir.path().join(DB_FILE)), 50);
    drop(conn);
    assert!(!fs::read_dir(&backups).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
}

#[test]
fn copies_after_truncate_checkpoint() {
    let dir = tempfile::tempdir().expect("tmp");
    let conn = make_db(dir.path(), 10);
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).expect("checkpoint");
    let out = create_migration_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), 1, 4, "20261002T101501Z", 5).expect("backup");
    assert_eq!(count(Path::new(&out.path.unwrap())), 10);
}

#[test]
fn missing_database_is_not_an_error_and_creates_nothing() {
    let dir = tempfile::tempdir().expect("tmp");
    let out = create_migration_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), 0, 4, "20261002T101500Z", 5).expect("ok");
    assert_eq!(out.path, None);
    assert!(!dir.path().join(BACKUP_DIR).exists());
}

#[test]
fn failure_is_reported_and_leaves_no_partial_file() {
    let dir = tempfile::tempdir().expect("tmp");
    let _conn = make_db(dir.path(), 1);
    // `backups` est un fichier : la création du dossier échoue.
    let blocker = dir.path().join(BACKUP_DIR);
    fs::write(&blocker, b"x").unwrap();
    let err = create_migration_backup(&dir.path().join(DB_FILE), &blocker, 1, 4, "20261002T101500Z", 5).unwrap_err();
    assert_eq!(err.code, "io");
    let bad = create_migration_backup(&dir.path().join(DB_FILE), &dir.path().join("b"), 1, 4, "nimporte", 5).unwrap_err();
    assert_eq!(bad.code, "bad-stamp");
}

#[test]
fn keeps_only_the_five_latest_migration_backups_and_spares_daily_ones() {
    let dir = tempfile::tempdir().expect("tmp");
    let _conn = make_db(dir.path(), 3);
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("circletasks-daily-20261001.db"), b"daily").unwrap(); // P-04 : intouchable
    for i in 0..8 {
        let stamp = format!("20261002T10150{i}Z");
        create_migration_backup(&dir.path().join(DB_FILE), &backups, 1, 4, &stamp, KEEP_MIGRATION_BACKUPS).unwrap();
    }
    let mut names: Vec<String> = fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let migration: Vec<_> = names.iter().filter(|n| n.starts_with("circletasks-pre-migration-") && n.ends_with(".db")).collect();
    assert_eq!(migration.len(), 5);
    assert!(migration[0].contains("20261002T101503Z"), "les plus anciennes sont supprimées : {migration:?}");
    assert!(!names.iter().any(|n| n.ends_with("-wal") || n.ends_with(".tmp")), "VACUUM INTO : ni -wal ni .tmp : {names:?}");
    assert!(names.contains(&"circletasks-daily-20261001.db".to_owned()));
    assert_eq!(prune_migration_backups(&backups, 5).unwrap(), 0);
}

#[test]
fn missing_database_with_existing_version_is_an_error() {
    let dir = tempfile::tempdir().expect("tmp");
    let err = create_migration_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), 2, 4, "20261002T101500Z", 5).unwrap_err();
    assert_eq!(err.code, "no-database");
}

#[test]
fn orphan_tmp_files_are_removed_at_the_start_of_a_backup() {
    let dir = tempfile::tempdir().expect("tmp");
    let _conn = make_db(dir.path(), 2);
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let orphan = backups.join("circletasks-pre-migration-v0001-to-v0002-20250101T000000Z.db.tmp");
    fs::write(&orphan, b"partiel").unwrap();
    create_migration_backup(&dir.path().join(DB_FILE), &backups, 1, 4, "20261002T101500Z", 5).unwrap();
    assert!(!orphan.exists());
}

#[test]
fn rerunning_with_the_same_stamp_replaces_the_backup() {
    let dir = tempfile::tempdir().expect("tmp");
    let _conn = make_db(dir.path(), 2);
    let backups = dir.path().join(BACKUP_DIR);
    for _ in 0..2 {
        let out = create_migration_backup(&dir.path().join(DB_FILE), &backups, 1, 4, "20261002T101500Z", 5).unwrap();
        assert_eq!(count(Path::new(&out.path.unwrap())), 2);
    }
}
