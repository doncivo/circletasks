//! P-04 (quatrième série) : archivage sûr, restes de récupération, casse du type dans sqlite_master, dossier lié, recherche après restauration.

use circletasks_lib::backup::{
    check_backup_file, create_daily_backup, create_migration_backup, normalize_sql, parse_backup_name, recover_interrupted_restore, reset_triggers,
    restore_backup_file, utc_stamp, Family, Recovery, RestoreStep, BACKUP_DIR, DB_FILE,
};
use circletasks_lib::backup_triggers::REFERENCE_TRIGGERS;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut all: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    all.sort();
    all
}

fn write(dir: &Path, name: &str, content: &[u8]) {
    fs::write(dir.join(name), content).unwrap();
}

fn recover(dir: &Path) -> Result<Recovery, circletasks_lib::backup::BackupError> {
    recover_interrupted_restore(&dir.join(DB_FILE), &dir.join(BACKUP_DIR))
}

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

#[test]
fn p04_utc_stamp_on_known_dates() {
    assert_eq!(utc_stamp(0), "19700101T000000Z");
    assert_eq!(utc_stamp(951_782_400), "20000229T000000Z");
    assert_eq!(utc_stamp(1_709_210_096), "20240229T123456Z");
    assert_eq!(utc_stamp(1_704_067_199), "20231231T235959Z");
    assert_eq!(utc_stamp(1_704_067_200), "20240101T000000Z");
    assert_eq!(utc_stamp(1_767_225_600), "20260101T000000Z");
}

#[test]
fn p04_archiving_never_mixes_with_an_orphan_wal_or_shm_at_the_target_name() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    // Orphelins d'une archive précédente sur les noms que la récupération va essayer (-wal puis -shm, base absente).
    let start = now_secs();
    for n in 0..8 {
        let stamp = utc_stamp(start + n);
        fs::write(backups.join(format!("circletasks-pre-restore-{stamp}.db-wal")), b"orphelin wal").unwrap();
    }
    write(dir.path(), "circletasks.db", b"nouvelle");
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    write(dir.path(), "circletasks.db-wal.restore-old", b"ancien wal");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Archived);
    let kept = names(&backups);
    let main = kept.iter().find(|n| n.ends_with(".db")).expect("base archivée");
    assert_eq!(fs::read(backups.join(main)).unwrap(), b"ancienne");
    assert_eq!(fs::read(backups.join(format!("{main}-wal"))).unwrap(), b"ancien wal", "le -wal archivé est celui de l'ancienne base");
    let orphan_names: Vec<String> = (0..8).map(|n| format!("circletasks-pre-restore-{}.db", utc_stamp(start + n))).collect();
    assert!(!orphan_names.contains(main), "le nom choisi n'est pas celui d'un orphelin : {main}");
    // La rotation a supprimé les -wal orphelins (leur base est absente) : il ne reste que l'archive complète.
    assert_eq!(kept, [main.clone(), format!("{main}-wal")]);
}

#[test]
fn p04_a_resumed_archive_targets_the_same_name_as_the_interrupted_one() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    write(dir.path(), "circletasks.db", b"nouvelle");
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    write(dir.path(), "circletasks.db-wal.restore-old", b"ancien wal");
    write(dir.path(), "circletasks.db-shm.restore-old", b"ancien shm");
    // Nom dérivé de la date de modification de la base restore-old.
    let modified = fs::metadata(dir.path().join("circletasks.db.restore-old")).unwrap().modified().unwrap();
    let stem = format!("circletasks-pre-restore-{}.db", utc_stamp(modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));
    // Première tentative interrompue : seul le -shm a été déplacé, sous ce nom.
    fs::rename(dir.path().join("circletasks.db-shm.restore-old"), backups.join(format!("{stem}-shm"))).unwrap();
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Archived);
    assert_eq!(names(&backups), [stem.clone(), format!("{stem}-shm"), format!("{stem}-wal")], "la reprise complète le MÊME nom");
    assert_eq!(fs::read(backups.join(&stem)).unwrap(), b"ancienne");
    assert_eq!(fs::read(backups.join(format!("{stem}-shm"))).unwrap(), b"ancien shm");
    assert_eq!(fs::read(backups.join(format!("{stem}-wal"))).unwrap(), b"ancien wal");
}

#[test]
fn p04_rotation_removes_the_wal_and_shm_of_a_pre_restore_name_whose_base_is_absent() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("circletasks-pre-restore-20260101T000000Z.db-wal"), b"orphelin").unwrap();
    fs::write(backups.join("circletasks-pre-restore-20260101T000000Z.db-shm"), b"orphelin").unwrap();
    fs::write(backups.join("circletasks-pre-restore-20260202T000000Z.db"), b"base").unwrap();
    fs::write(backups.join("circletasks-pre-restore-20260202T000000Z.db-wal"), b"wal vivant").unwrap();
    fs::write(backups.join("circletasks-daily-20260301.db-wal"), b"autre famille").unwrap();
    circletasks_lib::backup::prune_family(&backups, Family::PreRestore, 3).unwrap();
    assert_eq!(
        names(&backups),
        ["circletasks-daily-20260301.db-wal", "circletasks-pre-restore-20260202T000000Z.db", "circletasks-pre-restore-20260202T000000Z.db-wal"],
        "seuls les -wal / -shm sans base de la famille pre-restore disparaissent"
    );
}

#[test]
fn p04_a_partial_archive_is_finished_at_the_next_startup_without_losing_anything() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    // Premier démarrage interrompu : le -shm est déjà dans backups/, la base et le -wal sont encore en .restore-old.
    fs::write(backups.join("circletasks-pre-restore-20261005T100000Z.db-shm"), b"ancien shm").unwrap();
    write(dir.path(), "circletasks.db", b"nouvelle");
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    write(dir.path(), "circletasks.db-wal.restore-old", b"ancien wal");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Archived);
    assert_eq!(names(dir.path()), ["backups", "circletasks.db"]);
    let kept = names(&backups);
    // Un -shm orphelin d'un AUTRE nom (base absente) n'est pas celui de cette base : l'archive va sous un nom propre et la rotation le supprime.
    assert!(!kept.contains(&"circletasks-pre-restore-20261005T100000Z.db-shm".to_owned()));
    let main = kept.iter().find(|n| n.ends_with(".db")).expect("base archivée au second passage");
    assert_eq!(fs::read(backups.join(main)).unwrap(), b"ancienne");
    assert_eq!(fs::read(backups.join(format!("{main}-wal"))).unwrap(), b"ancien wal");
}

#[test]
fn p04_a_staged_leftover_that_is_not_a_plain_file_is_refused_and_nothing_moves() {
    for leftover in ["circletasks.db.restoring", "circletasks.db.restoring.tmp"] {
        let dir = scratch();
        write(dir.path(), "circletasks.db", b"nouvelle");
        write(dir.path(), "circletasks.db.restore-old", b"ancienne");
        fs::create_dir(dir.path().join(leftover)).unwrap();
        let before = names(dir.path());
        let error = recover(dir.path()).unwrap_err();
        assert_eq!(error.code, "unsafe-restore-file", "{leftover}");
        assert_eq!(names(dir.path()), before, "{leftover} : aucun déplacement");
        assert!(!dir.path().join(BACKUP_DIR).exists());
    }
}

#[test]
fn p04_the_staged_wal_shm_and_journal_leftovers_are_removed() {
    let dir = scratch();
    write(dir.path(), "circletasks.db", b"main");
    for name in ["circletasks.db.restoring", "circletasks.db.restoring.tmp", "circletasks.db.restoring-wal", "circletasks.db.restoring-shm", "circletasks.db.restoring-journal"] {
        write(dir.path(), name, b"reste");
    }
    assert_eq!(recover(dir.path()).unwrap(), Recovery::StagedRemoved);
    assert_eq!(names(dir.path()), ["circletasks.db"]);
}

fn trap(path: &Path, kind: &str, type_in_master: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT); CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (14); CREATE TABLE journal (x);").unwrap();
    if kind == "trigger" {
        conn.execute_batch("CREATE TRIGGER evil AFTER INSERT ON task BEGIN INSERT INTO journal VALUES (1); END;").unwrap();
    } else {
        conn.execute_batch("CREATE VIEW evil AS SELECT * FROM task;").unwrap();
    }
    conn.execute_batch("PRAGMA writable_schema = ON;").unwrap();
    conn.execute("UPDATE sqlite_master SET type = ?1 WHERE name = 'evil'", [type_in_master]).unwrap();
    conn.execute_batch("PRAGMA writable_schema = OFF;").unwrap();
}

#[test]
fn p04_a_type_with_a_modified_case_in_sqlite_master_is_refused() {
    let dir = scratch();
    for (index, (kind, forged)) in [("trigger", "trigger"), ("trigger", "Trigger"), ("trigger", "TRIGGER"), ("view", "view"), ("view", "View"), ("view", "VIEW")].into_iter().enumerate() {
        let path = dir.path().join(format!("{index}-{kind}.db"));
        trap(&path, kind, forged);
        let error = check_backup_file(&path, 99).unwrap_err();
        assert_eq!(error.code, "corrupt", "{kind} déclaré {forged}");
    }
}

#[test]
fn p04_reset_triggers_also_removes_a_trigger_whose_type_has_another_case() {
    let dir = scratch();
    let path = dir.path().join("casse.db");
    trap(&path, "trigger", "Trigger");
    // DROP TRIGGER ne supprime pas une ligne dont le type est « Trigger » : la préparation échoue au lieu de laisser un déclencheur étranger.
    assert_eq!(reset_triggers(&path).unwrap_err().code, "corrupt");
    // Transaction annulée : le fichier n'a pas été modifié à moitié (aucun déclencheur de référence n'a été créé).
    let count: u64 = Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'search_%'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn p04_normalize_sql_only_collapses_ascii_whitespace() {
    assert_eq!(normalize_sql("  a \t b\r\n c  "), "a b c");
    assert_eq!(normalize_sql("a\u{a0}b"), "a\u{a0}b", "l'espace insécable est une différence");
    assert_eq!(normalize_sql("a\u{2003}b"), "a\u{2003}b");
}

#[test]
fn p04_reset_triggers_leaves_a_single_file_without_wal_or_journal() {
    let dir = scratch();
    let path = dir.path().join("prepare.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT); CREATE TABLE search_index_doc (x);").unwrap();
    drop(conn);
    reset_triggers(&path).unwrap();
    assert_eq!(names(dir.path()), ["prepare.db"], "ni -wal ni -journal ni -shm");
    let mode: String = Connection::open(&path).unwrap().query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "delete");
}

#[test]
fn p04_a_backups_folder_that_is_a_link_refuses_daily_and_migration_backups() {
    let dir = scratch();
    let db = dir.path().join(DB_FILE);
    Connection::open(&db).unwrap().execute_batch("CREATE TABLE t (x);").unwrap();
    let real = dir.path().join("vrai");
    fs::create_dir_all(&real).unwrap();
    let link = dir.path().join(BACKUP_DIR);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&real, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &link);
    if made.is_ok() {
        assert_eq!(create_daily_backup(&db, &link, "20261005", false, 14).unwrap_err().code, "unsafe-folder");
        assert_eq!(create_migration_backup(&db, &link, 3, 4, "20261005T101500Z", 5).unwrap_err().code, "unsafe-folder");
        assert!(names(&real).is_empty(), "rien n'est écrit à travers le lien");
    }
}

/// Base minimale avec le VRAI schéma de recherche de la migration 0011 (table virtuelle FTS5 et ses déclencheurs de référence pour `task`).
fn make_search_db(path: &Path, tasks: &[&str]) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations VALUES (14);
         CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', deleted_at TEXT);
         CREATE VIRTUAL TABLE search_index USING fts5(type UNINDEXED, ref_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
         CREATE TABLE search_index_doc (id INTEGER PRIMARY KEY, type TEXT NOT NULL, ref_id TEXT NOT NULL, UNIQUE (type, ref_id));",
    )
    .unwrap();
    // Déclencheurs de recherche seulement : ceux de la synchro (`sync_*`, migration 0015) supposent ses tables.
    for (name, table, sql) in REFERENCE_TRIGGERS {
        if table == "task" && name.starts_with("search_") {
            conn.execute_batch(sql).unwrap();
        }
    }
    for (index, title) in tasks.iter().enumerate() {
        conn.execute("INSERT INTO task (id, title) VALUES (?1, ?2)", [format!("t{index}"), (*title).to_owned()]).unwrap();
    }
}

fn search(path: &Path, word: &str) -> Vec<String> {
    let conn = Connection::open(path).unwrap();
    let mut statement = conn.prepare("SELECT ref_id FROM search_index WHERE search_index MATCH ?1 ORDER BY ref_id").unwrap();
    let rows = statement.query_map([word], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect();
    rows
}

#[test]
fn p04_after_a_restore_the_search_index_still_follows_new_tasks() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    let db = dir.path().join(DB_FILE);
    make_search_db(&db, &["Appeler Paul", "Réserver restaurant"]);
    create_daily_backup(&db, &backups, "20261003", false, 14).unwrap();
    // L'état courant diffère : une tâche de plus.
    Connection::open(&db).unwrap().execute("INSERT INTO task (id, title) VALUES ('t9', 'Tâche récente')", []).unwrap();
    restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 14, "20261005T101500Z", NO_FAIL).unwrap();
    assert_eq!(search(&db, "restaurant"), ["t1"], "l'index restauré retrouve les tâches de la version");
    assert!(search(&db, "récente").is_empty());
    // Une insertion après la restauration passe par le déclencheur recréé : elle est trouvée dans search_index.
    Connection::open(&db).unwrap().execute("INSERT INTO task (id, title) VALUES ('t5', 'Planifier vacances')", []).unwrap();
    assert_eq!(search(&db, "vacances"), ["t5"]);
    let conn = Connection::open(&db).unwrap();
    let triggers: u64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'", [], |r| r.get(0)).unwrap();
    assert_eq!(triggers, 3);
    assert!(parse_backup_name("circletasks-daily-20261003.db").is_some_and(|(family, _)| family == Family::Daily));
}
