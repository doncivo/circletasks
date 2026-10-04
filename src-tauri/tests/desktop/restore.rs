//! P-04 : sauvegarde quotidienne, liste, vérification et restauration (bases SQLite réelles en WAL, dossiers temporaires).

use circletasks_lib::backup::{
    check_backup_file, create_daily_backup, create_migration_backup, daily_backup_name, is_valid_day, list_backups_in, parse_backup_name,
    pre_restore_backup_name, restore_backup_file, Family, RestoreStep, BACKUP_DIR, DB_FILE, KEEP_DAILY_BACKUPS, KEEP_MIGRATION_BACKUPS,
    KEEP_PRE_RESTORE_BACKUPS,
};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

/// Dossier de travail sous `target/tmp` (et non dans le dossier temporaire du système, que le test OCR Q-04 surveille pendant que les
/// autres tests tournent en parallèle).
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// Base de l'app : table de tâches et `schema_migrations` à la version donnée.
fn make_app_db(dir: &Path, version: u32, tasks: u32) -> Connection {
    let conn = Connection::open(dir.join(DB_FILE)).expect("open");
    conn.pragma_update(None, "journal_mode", "WAL").expect("wal");
    conn.execute("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)", []).unwrap();
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)", []).unwrap();
    for v in 1..=version {
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?1)", [v]).unwrap();
    }
    for i in 0..tasks {
        conn.execute("INSERT INTO task (title) VALUES (?1)", [format!("tâche {i}")]).unwrap();
    }
    conn
}

fn titles(path: &Path) -> Vec<String> {
    let conn = Connection::open(path).expect("open");
    let mut statement = conn.prepare("SELECT title FROM task ORDER BY id").unwrap();
    let rows: Vec<String> = statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect();
    rows
}

fn names(dir: &Path) -> Vec<String> {
    let mut all: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    all.sort();
    all
}

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

#[test]
fn p04_daily_names_and_days() {
    assert_eq!(daily_backup_name("20261005"), "circletasks-daily-20261005.db");
    assert!(is_valid_day("20261005"));
    for bad in ["2026-10-05", "20261305", "20261000", "../../x", "2026100", ""] {
        assert!(!is_valid_day(bad), "{bad}");
    }
    assert_eq!(parse_backup_name("circletasks-daily-20261005.db"), Some((Family::Daily, "20261005".to_owned())));
    assert_eq!(parse_backup_name(&pre_restore_backup_name("20261005T101500Z")).unwrap().0, Family::PreRestore);
    assert_eq!(parse_backup_name("circletasks-pre-migration-v0002-to-v0004-20261002T101500Z.db").unwrap().0, Family::Migration);
}

#[test]
fn p04_names_with_paths_or_unknown_shape_are_rejected() {
    for bad in [
        "..\\circletasks.db",
        "../circletasks-daily-20261005.db",
        "circletasks-daily-20261005.db\\..\\x",
        "C:\\x\\circletasks-daily-20261005.db",
        "circletasks-pre-migration-../../x-20261002T101500Z.db",
        "circletasks-pre-migration-vX-to-v2-20261002T101500Z.db",
        "circletasks.db",
        "circletasks-daily-20261005.db-wal",
        "circletasks-daily-20261005.db.tmp",
    ] {
        assert!(parse_backup_name(bad).is_none(), "{bad}");
    }
}

#[test]
fn p04_1_daily_backup_is_created_once_per_day_and_replaced_on_demand() {
    let dir = scratch();
    let conn = make_app_db(dir.path(), 4, 3);
    let backups = dir.path().join(BACKUP_DIR);
    let first = create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261005", false, 14).unwrap();
    assert_eq!((first.name.as_str(), first.created), ("circletasks-daily-20261005.db", true));
    assert_eq!(titles(&backups.join(&first.name)).len(), 3);
    // Une tâche de plus, sans remplacement : la version du jour reste celle d'avant.
    conn.execute("INSERT INTO task (title) VALUES ('nouvelle')", []).unwrap();
    let again = create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261005", false, 14).unwrap();
    assert!(!again.created);
    assert_eq!(titles(&backups.join(&again.name)).len(), 3);
    // « Sauvegarder maintenant » remplace la version du jour.
    let replaced = create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261005", true, 14).unwrap();
    assert!(replaced.created);
    assert_eq!(titles(&backups.join(&replaced.name)).len(), 4);
    assert!(!names(&backups).iter().any(|n| n.ends_with(".tmp") || n.ends_with("-wal")));
}

#[test]
fn p04_1_daily_backup_includes_rows_still_in_the_wal() {
    let dir = scratch();
    let _conn = make_app_db(dir.path(), 4, 20); // connexion gardée ouverte : lignes dans le -wal
    let out = create_daily_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), "20261005", false, 14).unwrap();
    assert_eq!(titles(&dir.path().join(BACKUP_DIR).join(out.name)).len(), 20);
}

#[test]
fn p04_1_daily_backup_errors_are_reported() {
    let dir = scratch();
    assert_eq!(create_daily_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), "20261005", false, 14).unwrap_err().code, "no-database");
    let _conn = make_app_db(dir.path(), 1, 1);
    assert_eq!(create_daily_backup(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), "pas-un-jour", false, 14).unwrap_err().code, "bad-day");
    let blocker = dir.path().join("fichier");
    fs::write(&blocker, b"x").unwrap();
    assert_eq!(create_daily_backup(&dir.path().join(DB_FILE), &blocker, "20261005", false, 14).unwrap_err().code, "io");
}

#[test]
fn p04_2_keeps_the_14_latest_daily_backups_and_spares_the_other_families() {
    let dir = scratch();
    let _conn = make_app_db(dir.path(), 4, 1);
    let backups = dir.path().join(BACKUP_DIR);
    for i in 0..5 {
        let stamp = format!("20261002T10150{i}Z");
        create_migration_backup(&dir.path().join(DB_FILE), &backups, 1, 4, &stamp, KEEP_MIGRATION_BACKUPS).unwrap();
    }
    fs::write(backups.join(pre_restore_backup_name("20260101T000000Z")), b"x").unwrap();
    for day in 1..=20 {
        create_daily_backup(&dir.path().join(DB_FILE), &backups, &format!("202609{day:02}"), false, KEEP_DAILY_BACKUPS).unwrap();
    }
    let all = names(&backups);
    let daily: Vec<_> = all.iter().filter(|n| n.starts_with("circletasks-daily-")).collect();
    assert_eq!(daily.len(), 14);
    assert_eq!(daily[0], "circletasks-daily-20260907.db", "les 6 plus anciennes sont supprimées");
    assert_eq!(daily[13], "circletasks-daily-20260920.db");
    assert_eq!(all.iter().filter(|n| n.starts_with("circletasks-pre-migration-")).count(), 5, "migration : comptées à part");
    assert_eq!(all.iter().filter(|n| n.starts_with("circletasks-pre-restore-")).count(), 1);
}

#[test]
fn p04_4_listing_gives_kind_size_task_count_and_ignores_other_files() {
    let dir = scratch();
    let conn = make_app_db(dir.path(), 4, 5);
    conn.execute("UPDATE task SET deleted_at = '2026-10-01' WHERE id = 1", []).unwrap();
    let backups = dir.path().join(BACKUP_DIR);
    create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261004", false, 14).unwrap();
    create_migration_backup(&dir.path().join(DB_FILE), &backups, 3, 4, "20261001T080000Z", 5).unwrap();
    fs::write(backups.join("notes.txt"), b"x").unwrap();
    fs::write(backups.join("circletasks-daily-20261003.db"), b"pas une base").unwrap();
    let entries = list_backups_in(&backups).unwrap();
    assert_eq!(entries.len(), 3, "notes.txt ignoré");
    let daily = entries.iter().find(|e| e.name == "circletasks-daily-20261004.db").unwrap();
    assert_eq!((daily.kind, daily.tasks, daily.schema_version), ("daily", Some(4), Some(4)));
    assert!(daily.size > 0 && daily.modified_ms > 0);
    let migration = entries.iter().find(|e| e.kind == "pre-migration").unwrap();
    assert_eq!(migration.stamp, "20261001T080000Z");
    let broken = entries.iter().find(|e| e.name == "circletasks-daily-20261003.db").unwrap();
    assert_eq!((broken.tasks, broken.schema_version), (None, None), "illisible : sans compteur, listé quand même");
    assert!(entries.windows(2).all(|w| w[0].modified_ms >= w[1].modified_ms), "plus récentes d'abord");
    assert!(list_backups_in(&dir.path().join("absent")).unwrap().is_empty());
}

#[test]
fn p04_7_check_refuses_corrupt_and_newer_files() {
    let dir = scratch();
    let conn = make_app_db(dir.path(), 5, 1);
    drop(conn);
    let db = dir.path().join(DB_FILE);
    assert_eq!(check_backup_file(&db, 5).unwrap(), 5);
    assert_eq!(check_backup_file(&db, 9).unwrap(), 5, "plus ancienne que l'app : acceptée (migrations rejouées)");
    assert_eq!(check_backup_file(&db, 4).unwrap_err().code, "newer-schema");
    let garbage = dir.path().join("garbage.db");
    fs::write(&garbage, b"ceci n'est pas une base SQLite, du tout, vraiment pas").unwrap();
    assert_eq!(check_backup_file(&garbage, 9).unwrap_err().code, "corrupt");
    // Une base valide sans schema_migrations n'est pas une base CircleTasks.
    let other = dir.path().join("other.db");
    Connection::open(&other).unwrap().execute("CREATE TABLE t (id INTEGER)", []).unwrap();
    assert_eq!(check_backup_file(&other, 9).unwrap_err().code, "corrupt");
}

fn setup_restore(version: u32) -> (tempfile::TempDir, PathBuf) {
    let dir = scratch();
    // Version choisie : 2 tâches, version de schéma donnée.
    let current = make_app_db(dir.path(), version, 2);
    let backups = dir.path().join(BACKUP_DIR);
    create_daily_backup(&dir.path().join(DB_FILE), &backups, "20261003", false, 14).unwrap();
    // État actuel : 6 tâches, dont une encore dans le -wal.
    for i in 0..3 {
        current.execute("INSERT INTO task (title) VALUES (?1)", [format!("récente {i}")]).unwrap();
    }
    current.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(())).unwrap();
    current.execute("INSERT INTO task (title) VALUES ('dans le wal')", []).unwrap();
    drop(current); // la connexion est fermée par le front avant la restauration
    (dir, backups)
}

#[test]
fn p04_6_restore_replaces_the_database_after_a_safety_copy_and_leaves_no_leftover() {
    let (dir, backups) = setup_restore(4);
    let db = dir.path().join(DB_FILE);
    let out = restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", NO_FAIL).unwrap();
    assert_eq!(out.schema_version, 4);
    assert_eq!(out.safety_copy.as_deref(), Some("circletasks-pre-restore-20261005T101500Z.db"));
    // Données restaurées : les 2 tâches de la version choisie.
    assert_eq!(titles(&db), ["tâche 0", "tâche 1"]);
    // Copie de sécurité : l'état d'avant (5 tâches ; la fermeture de la connexion a vidé le -wal dans la base).
    assert_eq!(titles(&backups.join(out.safety_copy.unwrap())).len(), 6);
    // Ni -wal orphelin de l'ancienne base, ni fichier de travail.
    assert_eq!(names(dir.path()), ["backups", "circletasks.db"]);
    // La version choisie reste en place.
    assert!(backups.join("circletasks-daily-20261003.db").is_file());
}

#[test]
fn p04_6_keeps_only_the_three_latest_pre_restore_copies() {
    let (dir, backups) = setup_restore(4);
    let db = dir.path().join(DB_FILE);
    for i in 0..5 {
        restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, &format!("20261005T10150{i}Z"), NO_FAIL).unwrap();
    }
    let copies: Vec<String> = names(&backups).into_iter().filter(|n| n.starts_with("circletasks-pre-restore-")).collect();
    assert_eq!(copies.len(), KEEP_PRE_RESTORE_BACKUPS);
    assert_eq!(copies[0], "circletasks-pre-restore-20261005T101502Z.db");
    assert!(backups.join("circletasks-daily-20261003.db").is_file(), "la purge ne touche pas les autres familles");
}

#[test]
fn p04_7_an_older_schema_is_restored_as_is_for_the_migrations_to_replay() {
    let (dir, backups) = setup_restore(2);
    let db = dir.path().join(DB_FILE);
    let out = restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 6, "20261005T101500Z", NO_FAIL).unwrap();
    assert_eq!(out.schema_version, 2);
    assert_eq!(check_backup_file(&db, 6).unwrap(), 2);
}

#[test]
fn p04_7_newer_corrupt_missing_or_foreign_names_are_refused_and_nothing_changes() {
    let (dir, backups) = setup_restore(5);
    let db = dir.path().join(DB_FILE);
    let before = titles(&db);
    let before_main = fs::read(&db).unwrap();
    let before_files = names(dir.path());
    // Plus récente que l'app.
    assert_eq!(restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", NO_FAIL).unwrap_err().code, "newer-schema");
    // Corrompue.
    fs::write(backups.join("circletasks-daily-20261002.db"), b"corrompu corrompu corrompu corrompu").unwrap();
    let backups_before = names(&backups);
    assert_eq!(restore_backup_file(&db, &backups, "circletasks-daily-20261002.db", 9, "20261005T101500Z", NO_FAIL).unwrap_err().code, "corrupt");
    // Absente, nom hors liste, chemin, horodatage invalide.
    assert_eq!(restore_backup_file(&db, &backups, "circletasks-daily-20250101.db", 9, "20261005T101500Z", NO_FAIL).unwrap_err().code, "not-found");
    for name in ["circletasks.db", "..\\circletasks.db", "../circletasks.db", "C:\\Windows\\x.db"] {
        assert_eq!(restore_backup_file(&db, &backups, name, 9, "20261005T101500Z", NO_FAIL).unwrap_err().code, "bad-name", "{name}");
    }
    assert_eq!(restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 9, "x", NO_FAIL).unwrap_err().code, "bad-stamp");
    assert_eq!(fs::read(&db).unwrap(), before_main);
    assert_eq!(titles(&db), before);
    assert_eq!(names(dir.path()), before_files);
    assert_eq!(names(&backups), backups_before, "aucune copie de sécurité n'est créée pour une restauration refusée");
}

#[test]
fn p04_8_a_simulated_failure_puts_the_old_files_back_including_the_wal() {
    let (dir, backups) = setup_restore(4);
    let db = dir.path().join(DB_FILE);
    // Un -wal à côté de la base fermée (reste d'un arrêt brutal) : il doit revenir avec elle.
    let wal = dir.path().join("circletasks.db-wal");
    fs::write(&wal, b"").unwrap();
    let before = titles(&db);
    let before_main = fs::read(&db).unwrap();
    for step in [RestoreStep::Staged, RestoreStep::OldMoved] {
        let fail = move |s: RestoreStep| if s == step { Err(std::io::Error::other("échec simulé")) } else { Ok(()) };
        let err = restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", &fail).unwrap_err();
        assert_eq!(err.code, "io", "{step:?}");
        assert_eq!(fs::read(&db).unwrap(), before_main, "{step:?} : fichier principal identique");
        assert!(wal.is_file(), "{step:?} : -wal remis en place");
        assert_eq!(titles(&db), before);
        let left = names(dir.path());
        assert!(!left.iter().any(|n| n.ends_with(".restoring") || n.ends_with(".restore-old")), "{step:?} : {left:?}");
    }
}

#[test]
fn p04_8_a_database_held_open_makes_the_swap_fail_without_changing_anything() {
    let (dir, backups) = setup_restore(4);
    let db = dir.path().join(DB_FILE);
    // Connexion restée ouverte (cas où le front n'aurait pas fermé la base) : sous Windows le renommage échoue ; ailleurs il réussit,
    // et on vérifie alors seulement la cohérence du résultat.
    let held = Connection::open(&db).unwrap();
    held.pragma_update(None, "journal_mode", "WAL").unwrap();
    let before = titles(&db);
    let result = restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", NO_FAIL);
    drop(held);
    match result {
        Err(_) => {
            assert_eq!(titles(&db), before, "échec : l'ancienne base est intacte");
            let left = names(dir.path());
            assert!(!left.iter().any(|n| n.ends_with(".restoring") || n.ends_with(".restore-old")), "{left:?}");
        }
        Ok(_) => assert_eq!(titles(&db).len(), 2),
    }
}

#[test]
fn p04_6_restore_works_when_the_database_file_is_missing() {
    let (dir, backups) = setup_restore(4);
    let db = dir.path().join(DB_FILE);
    fs::remove_file(&db).unwrap();
    let _ = fs::remove_file(dir.path().join("circletasks.db-wal"));
    let out = restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 4, "20261005T101500Z", NO_FAIL).unwrap();
    assert_eq!(out.safety_copy, None);
    assert_eq!(titles(&db).len(), 2);
}
