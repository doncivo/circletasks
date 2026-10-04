//! P-04 (corrections de revue et d'audit) : récupération d'une restauration interrompue, base piégée, liens, taille, purge, constantes.

use circletasks_lib::backup::{
    check_backup_file, create_daily_backup, is_plain_file, is_valid_day, list_backups_in, neutral_directory_label, prune_family,
    recover_interrupted_restore, restore_backup_file, Family, RestoreStep, APP_SCHEMA_VERSION, BACKUP_DIR, DB_FILE, EXPECTED_TRIGGERS, MAX_BACKUP_BYTES,
};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn make_db(path: &Path, version: u32, tasks: u32) {
    let conn = Connection::open(path).unwrap();
    conn.execute("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)", []).unwrap();
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)", []).unwrap();
    for v in 1..=version {
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?1)", [v]).unwrap();
    }
    for i in 0..tasks {
        conn.execute("INSERT INTO task (title) VALUES (?1)", [format!("tâche {i}")]).unwrap();
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut all: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    all.sort();
    all
}

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

#[test]
fn p04_recovery_puts_the_old_database_back_when_the_main_file_is_missing() {
    let dir = scratch();
    let db = dir.path().join(DB_FILE);
    // État d'un arrêt brutal pendant l'échange : tout est en `.restore-old`, un fichier préparé traîne.
    fs::write(dir.path().join("circletasks.db.restore-old"), b"main").unwrap();
    fs::write(dir.path().join("circletasks.db-wal.restore-old"), b"wal").unwrap();
    fs::write(dir.path().join("circletasks.db-shm.restore-old"), b"shm").unwrap();
    fs::write(dir.path().join("circletasks.db.restoring"), b"nouvelle").unwrap();
    assert!(recover_interrupted_restore(&db));
    assert_eq!(fs::read(&db).unwrap(), b"main");
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal");
    assert_eq!(fs::read(dir.path().join("circletasks.db-shm")).unwrap(), b"shm");
    assert_eq!(names(dir.path()), ["circletasks.db", "circletasks.db-shm", "circletasks.db-wal"]);
    // Idempotent.
    assert!(!recover_interrupted_restore(&db));
}

#[test]
fn p04_recovery_covers_a_rollback_failed_state_with_only_some_files_moved_back() {
    let dir = scratch();
    let db = dir.path().join(DB_FILE);
    // Le retour arrière a remis le -shm mais pas la base ni le -wal.
    fs::write(dir.path().join("circletasks.db.restore-old"), b"main").unwrap();
    fs::write(dir.path().join("circletasks.db-wal.restore-old"), b"wal").unwrap();
    fs::write(dir.path().join("circletasks.db-shm"), b"shm").unwrap();
    assert!(recover_interrupted_restore(&db));
    assert_eq!(fs::read(&db).unwrap(), b"main");
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal");
}

#[test]
fn p04_recovery_removes_leftovers_when_the_new_database_is_in_place_and_touches_nothing_otherwise() {
    let dir = scratch();
    let db = dir.path().join(DB_FILE);
    fs::write(&db, b"nouvelle").unwrap();
    fs::write(dir.path().join("circletasks.db.restore-old"), b"ancienne").unwrap();
    fs::write(dir.path().join("circletasks.db.restoring"), b"orphelin").unwrap();
    assert!(!recover_interrupted_restore(&db));
    assert_eq!(names(dir.path()), ["circletasks.db"]);
    assert_eq!(fs::read(&db).unwrap(), b"nouvelle");
    // Démarrage normal : rien à faire.
    assert!(!recover_interrupted_restore(&dir.path().join("absente.db")));
}

#[test]
fn p04_a_pending_restore_blocks_a_new_one_and_never_deletes_the_old_files() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    make_db(&dir.path().join(DB_FILE), 4, 2);
    create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261003", false, 14).unwrap();
    fs::write(dir.path().join("circletasks.db.restore-old"), b"seule copie").unwrap();
    let error = restore_backup_file(&dir.path().join(DB_FILE), &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", NO_FAIL).unwrap_err();
    assert_eq!(error.code, "restore-pending");
    assert_eq!(fs::read(dir.path().join("circletasks.db.restore-old")).unwrap(), b"seule copie");
}

#[test]
fn p04_the_swap_moves_wal_and_shm_before_the_main_file() {
    // Échec simulé après le déplacement : tout revient. Avec un -wal et un -shm présents, l'état final est identique à l'état initial.
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    let db = dir.path().join(DB_FILE);
    make_db(&db, 4, 2);
    create_daily_backup(&db, &backups, "20261003", false, 14).unwrap();
    let before = fs::read(&db).unwrap();
    let wal = dir.path().join("circletasks.db-wal");
    let shm = dir.path().join("circletasks.db-shm");
    // Les fichiers de journal apparaissent après la copie de sécurité, juste avant l'échange.
    let fail = |step: RestoreStep| match step {
        RestoreStep::Staged => {
            fs::write(&wal, b"wal")?;
            fs::write(&shm, b"shm")
        }
        RestoreStep::OldMoved => Err(std::io::Error::other("échec simulé")),
    };
    assert!(restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", &fail).is_err());
    assert_eq!(fs::read(&db).unwrap(), before);
    assert_eq!(fs::read(&wal).unwrap(), b"wal");
    assert_eq!(fs::read(&shm).unwrap(), b"shm");
    assert!(!names(dir.path()).iter().any(|n| n.ends_with(".restore-old") || n.ends_with(".restoring")));
}

#[test]
fn p04_a_trapped_database_is_refused() {
    let dir = scratch();
    let with_trigger = dir.path().join("trigger.db");
    make_db(&with_trigger, 4, 1);
    Connection::open(&with_trigger)
        .unwrap()
        .execute_batch("CREATE TABLE journal (x); CREATE TRIGGER evil AFTER INSERT ON task BEGIN INSERT INTO journal VALUES (NEW.title); END;")
        .unwrap();
    assert_eq!(check_backup_file(&with_trigger, 9).unwrap_err().code, "corrupt");
    let with_view = dir.path().join("view.db");
    make_db(&with_view, 4, 1);
    Connection::open(&with_view).unwrap().execute("CREATE VIEW v AS SELECT * FROM task", []).unwrap();
    assert_eq!(check_backup_file(&with_view, 9).unwrap_err().code, "corrupt");
    // Un déclencheur de l'app (nom attendu) reste accepté.
    let known = dir.path().join("known.db");
    make_db(&known, 4, 1);
    Connection::open(&known).unwrap().execute_batch("CREATE TABLE search_index_doc (x); CREATE TRIGGER search_task_ai AFTER INSERT ON task BEGIN SELECT 1; END;").unwrap();
    assert_eq!(check_backup_file(&known, 9).unwrap(), 4);
    assert_eq!(EXPECTED_TRIGGERS.len(), 18);
}

#[test]
fn p04_the_listing_does_not_count_tasks_through_a_view() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let path = backups.join("circletasks-daily-20261003.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations VALUES (3); CREATE TABLE base (deleted_at TEXT); CREATE VIEW task AS SELECT * FROM base;").unwrap();
    drop(conn);
    let entries = list_backups_in(&backups).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].tasks, None, "task n'est pas une table : aucun COUNT");
    assert_eq!(entries[0].schema_version, Some(3));
}

#[test]
fn p04_links_and_non_regular_files_are_not_plain_files() {
    let dir = scratch();
    let real = dir.path().join("reel.db");
    fs::write(&real, b"x").unwrap();
    assert!(is_plain_file(&real));
    assert!(!is_plain_file(&dir.path().join("absent.db")));
    assert!(!is_plain_file(dir.path()), "un dossier n'est pas un fichier");
    let link = dir.path().join("lien.db");
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&real, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &link);
    // Créer un lien symbolique demande un privilège sous Windows : sans lui, on ne vérifie que le reste.
    if made.is_ok() {
        assert!(!is_plain_file(&link));
        let backups = dir.path().join(BACKUP_DIR);
        fs::create_dir_all(&backups).unwrap();
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_file(&real, backups.join("circletasks-daily-20261003.db"));
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&real, backups.join("circletasks-daily-20261003.db"));
        assert!(list_backups_in(&backups).unwrap().is_empty(), "un lien du dossier n'est pas listé");
        let error = restore_backup_file(&dir.path().join(DB_FILE), &backups, "circletasks-daily-20261003.db", 9, "20261005T101500Z", NO_FAIL).unwrap_err();
        assert_eq!(error.code, "not-found");
    }
}

#[test]
fn p04_a_database_over_512_mib_is_refused_without_being_read() {
    let dir = scratch();
    let big = dir.path().join("grosse.db");
    let file = fs::File::create(&big).unwrap();
    file.set_len(MAX_BACKUP_BYTES + 1).unwrap();
    drop(file);
    let error = check_backup_file(&big, 9).unwrap_err();
    assert_eq!(error.code, "corrupt");
    assert!(error.message.contains("512"));
    fs::remove_file(&big).unwrap();
}

#[test]
fn p04_pruning_also_removes_the_shm_and_wal_of_a_purged_backup() {
    let dir = scratch();
    for day in ["20260901", "20260902", "20260903"] {
        fs::write(dir.path().join(format!("circletasks-daily-{day}.db")), b"x").unwrap();
    }
    fs::write(dir.path().join("circletasks-daily-20260901.db-shm"), b"x").unwrap();
    fs::write(dir.path().join("circletasks-daily-20260901.db-wal"), b"x").unwrap();
    assert_eq!(prune_family(dir.path(), Family::Daily, 2).unwrap(), 1);
    assert_eq!(names(dir.path()), ["circletasks-daily-20260902.db", "circletasks-daily-20260903.db"]);
}

#[test]
fn p04_days_use_the_real_number_of_days_of_the_month() {
    for ok in ["20240229", "20260228", "20261231", "20260430", "20000229"] {
        assert!(is_valid_day(ok), "{ok}");
    }
    for bad in ["20260229", "20260431", "20261131", "21000229", "20260230", "20260100", "20261301"] {
        assert!(!is_valid_day(bad), "{bad}");
    }
}

#[test]
fn p04_messages_and_labels_do_not_leak_absolute_paths() {
    assert_eq!(neutral_directory_label("fr.circletasks.planner"), "%APPDATA%\\fr.circletasks.planner\\backups");
    let dir = scratch();
    let error = create_daily_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), "20261005", false, 14).unwrap_err();
    assert_eq!(error.code, "no-database");
    assert!(!error.message.contains(dir.path().to_string_lossy().as_ref()));
}

#[test]
fn p04_the_app_schema_version_is_the_highest_migration_file() {
    let migrations = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("db").join("migrations");
    let highest = fs::read_dir(migrations)
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().into_string().ok())
        .filter(|n| n.ends_with(".ts") && !n.ends_with(".test.ts") && n != "index.ts")
        .filter_map(|n| n.get(..4).and_then(|v| v.parse::<u32>().ok()))
        .max()
        .unwrap();
    assert_eq!(APP_SCHEMA_VERSION, highest, "mettre à jour APP_SCHEMA_VERSION de backup.rs avec la nouvelle migration");
}
