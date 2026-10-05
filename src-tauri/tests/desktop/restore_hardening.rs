//! P-04 (corrections de revue et d'audit) : récupération d'une restauration interrompue, base piégée, liens, taille, purge, constantes.

use circletasks_lib::backup::{
    check_backup_file, check_named_backup, create_daily_backup, is_plain_file, is_valid_day, is_valid_stamp, list_backups_in, neutral_directory_label,
    iso_instant, normalize_sql, open_read_only_with, write_restore_marker, outcome_for_webview, parse_backup_name, prune_family, recover_interrupted_restore, reset_triggers,
    restore_backup_file, BackupOutcome, Family, Recovery, RestoreStep, APP_SCHEMA_VERSION, BACKUP_DIR, DB_FILE, MAX_BACKUP_BYTES,
};
use circletasks_lib::backup_triggers::REFERENCE_TRIGGERS;
use circletasks_lib::sync::folder::{CONFIG_SUBDIR, FOLDER_FILE};
use circletasks_lib::sync::marker::{self, MARKER_FILE};
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

fn recover(dir: &Path) -> Result<Recovery, circletasks_lib::backup::BackupError> {
    recover_interrupted_restore(&dir.join(DB_FILE), &dir.join(BACKUP_DIR))
}

fn write(dir: &Path, name: &str, content: &[u8]) {
    fs::write(dir.join(name), content).unwrap();
}

#[test]
fn p04_recovery_puts_the_old_database_back_when_the_main_file_is_missing() {
    let dir = scratch();
    // État d'un arrêt brutal pendant l'échange : tout est en `.restore-old`, un fichier préparé traîne.
    write(dir.path(), "circletasks.db.restore-old", b"main");
    write(dir.path(), "circletasks.db-wal.restore-old", b"wal");
    write(dir.path(), "circletasks.db-shm.restore-old", b"shm");
    write(dir.path(), "circletasks.db.restoring", b"nouvelle");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::PutBack);
    assert_eq!(fs::read(dir.path().join(DB_FILE)).unwrap(), b"main");
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal");
    assert_eq!(fs::read(dir.path().join("circletasks.db-shm")).unwrap(), b"shm");
    assert_eq!(names(dir.path()), ["circletasks.db", "circletasks.db-shm", "circletasks.db-wal"]);
    // Idempotent.
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Nothing);
}

#[test]
fn p04_recovery_base_back_but_wal_still_in_restore_old() {
    // « base remise, -wal resté en .restore-old » : un retour arrière interrompu après la base.
    let dir = scratch();
    write(dir.path(), "circletasks.db", b"main");
    write(dir.path(), "circletasks.db-wal.restore-old", b"wal");
    write(dir.path(), "circletasks.db-shm", b"shm");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::PutBack);
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal");
    assert_eq!(fs::read(dir.path().join(DB_FILE)).unwrap(), b"main");
    assert_eq!(names(dir.path()), ["circletasks.db", "circletasks.db-shm", "circletasks.db-wal"]);
}

#[test]
fn p04_recovery_database_present_with_only_a_wal_restore_old() {
    // « base présente + -wal.restore-old seul » : l'échange s'est arrêté avant la base ; rien n'est supprimé, tout revient.
    let dir = scratch();
    write(dir.path(), "circletasks.db", b"main");
    write(dir.path(), "circletasks.db-wal.restore-old", b"wal");
    write(dir.path(), "circletasks.db-shm.restore-old", b"shm");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::PutBack);
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal");
    assert_eq!(fs::read(dir.path().join("circletasks.db-shm")).unwrap(), b"shm");
    assert!(!dir.path().join(BACKUP_DIR).exists(), "rien n'est archivé : l'échange n'a pas eu lieu");
}

#[test]
fn p04_recovery_after_a_finished_swap_moves_the_leftovers_instead_of_deleting_them() {
    let dir = scratch();
    write(dir.path(), "circletasks.db", b"nouvelle");
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    write(dir.path(), "circletasks.db-wal.restore-old", b"ancien wal");
    write(dir.path(), "circletasks.db.restoring", b"copie preparee");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Archived);
    assert_eq!(fs::read(dir.path().join(DB_FILE)).unwrap(), b"nouvelle", "la base en place n'est pas touchée");
    assert_eq!(names(dir.path()), ["backups", "circletasks.db"], "plus de .restore-old ni de .restoring à côté de la base");
    let kept = names(&dir.path().join(BACKUP_DIR));
    let main = kept.iter().find(|n| n.starts_with("circletasks-pre-restore-") && n.ends_with(".db")).expect("ancienne base archivée");
    assert_eq!(fs::read(dir.path().join(BACKUP_DIR).join(main)).unwrap(), b"ancienne");
    assert_eq!(fs::read(dir.path().join(BACKUP_DIR).join(format!("{main}-wal"))).unwrap(), b"ancien wal");
    assert!(parse_backup_name(main).is_some_and(|(family, _)| family == Family::PreRestore), "nom de la famille pre-restore : {main}");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Nothing);
}

#[test]
fn p04_recovery_refuses_a_restore_old_that_is_a_link_and_touches_nothing() {
    let dir = scratch();
    let real = dir.path().join("ailleurs.bin");
    fs::write(&real, b"ailleurs").unwrap();
    let link = dir.path().join("circletasks.db.restore-old");
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&real, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &link);
    if made.is_ok() {
        write(dir.path(), "circletasks.db-wal.restore-old", b"wal");
        let before = names(dir.path());
        let error = recover(dir.path()).unwrap_err();
        assert_eq!(error.code, "unsafe-restore-file");
        assert!(!error.message.contains(dir.path().to_string_lossy().as_ref()));
        assert_eq!(names(dir.path()), before, "aucun fichier déplacé ni supprimé");
        assert!(!dir.path().join(DB_FILE).exists(), "aucune base créée");
    }
}

#[test]
fn p04_recovery_failure_leaves_everything_in_place_and_creates_no_database() {
    // Cible occupée : le .restore-old n'est jamais écrasé et la récupération signale l'échec (l'app ne démarre alors pas, voir desktop.rs).
    let dir = scratch();
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    write(dir.path(), "circletasks.db-wal", b"wal occupe");
    write(dir.path(), "circletasks.db-wal.restore-old", b"ancien wal");
    let before = names(dir.path());
    let error = recover(dir.path()).unwrap_err();
    assert_eq!(error.code, "recovery-conflict");
    assert_eq!(names(dir.path()), before, "les cibles sont vérifiées avant tout déplacement : rien n'a bougé");
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), b"wal occupe");
    assert_eq!(fs::read(dir.path().join("circletasks.db-wal.restore-old")).unwrap(), b"ancien wal");
    assert!(!dir.path().join(DB_FILE).exists(), "la récupération ne crée jamais de base");
}

#[test]
fn p04_recovery_without_any_restore_file_does_nothing() {
    let dir = scratch();
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Nothing);
    write(dir.path(), "circletasks.db", b"main");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::Nothing);
    assert_eq!(recover(&dir.path().join("dossier-absent")).unwrap(), Recovery::Nothing);
}

#[test]
fn p04_the_archive_timestamp_is_a_valid_utc_stamp_in_the_pre_restore_family() {
    let dir = scratch();
    write(dir.path(), "circletasks.db", b"nouvelle");
    write(dir.path(), "circletasks.db.restore-old", b"ancienne");
    recover(dir.path()).unwrap();
    let kept = names(&dir.path().join(BACKUP_DIR));
    let (family, stamp) = parse_backup_name(&kept[0]).unwrap();
    assert_eq!(family, Family::PreRestore);
    assert!(is_valid_stamp(&stamp) && stamp.starts_with("20"), "{stamp}");
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
    // Un déclencheur HOMONYME d'un déclencheur de l'app mais au corps modifié est refusé (le nom ne suffit plus).
    let namesake = dir.path().join("namesake.db");
    make_db(&namesake, 4, 1);
    Connection::open(&namesake).unwrap().execute_batch("CREATE TABLE search_index_doc (x); CREATE TRIGGER search_task_ai AFTER INSERT ON task BEGIN SELECT 1; END;").unwrap();
    assert_eq!(check_backup_file(&namesake, 9).unwrap_err().code, "corrupt");
    // Le déclencheur de référence (nom, table, SQL aux espaces près) est accepté.
    let known = dir.path().join("known.db");
    make_db(&known, 4, 1);
    let (_, _, reference_sql) = REFERENCE_TRIGGERS.iter().find(|(name, _, _)| *name == "search_task_ai").unwrap();
    Connection::open(&known).unwrap().execute_batch(&format!("CREATE TABLE search_index_doc (x); {reference_sql}")).unwrap();
    assert_eq!(check_backup_file(&known, 9).unwrap(), 4);
    assert_eq!(normalize_sql("a  b\n c"), "a b c");
    // 18 déclencheurs de recherche (0011) + 32 de capture de la synchro (0015, deux par table publiée).
    assert_eq!(REFERENCE_TRIGGERS.len(), 50);
}

#[test]
fn p04_reset_triggers_removes_foreign_triggers_and_recreates_the_reference_ones() {
    let dir = scratch();
    let path = dir.path().join("restauree.db");
    make_db(&path, 14, 1);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE search_index_doc (x); CREATE TABLE journal (x); CREATE TRIGGER evil AFTER INSERT ON task BEGIN INSERT INTO journal VALUES (1); END; CREATE TRIGGER search_task_ai AFTER INSERT ON task BEGIN SELECT 1; END;").unwrap();
    drop(conn);
    reset_triggers(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    let mut statement = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").unwrap();
    let found: Vec<(String, String)> = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    // Seules les tables présentes (task) ont leurs déclencheurs ; `evil` a disparu et `search_task_ai` est celui de la référence.
    assert_eq!(found.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["search_task_ad", "search_task_ai", "search_task_au"]);
    let (_, _, reference) = REFERENCE_TRIGGERS.iter().find(|(name, _, _)| *name == "search_task_ai").unwrap();
    assert_eq!(found.iter().find(|(name, _)| name == "search_task_ai").map(|(_, sql)| normalize_sql(sql)), Some(normalize_sql(reference)));
    drop(statement);
    drop(conn);
    // Une base ancienne (sans index de recherche) ne reçoit aucun déclencheur.
    let old = dir.path().join("ancienne.db");
    make_db(&old, 10, 1);
    Connection::open(&old).unwrap().execute_batch("CREATE TABLE journal (x); CREATE TRIGGER evil AFTER INSERT ON task BEGIN INSERT INTO journal VALUES (1); END;").unwrap();
    reset_triggers(&old).unwrap();
    let count: u64 = Connection::open(&old).unwrap().query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    // Base postérieure à la migration 0015 : les déclencheurs de capture de la synchro sont recréés aussi.
    let synced = dir.path().join("synchro.db");
    make_db(&synced, 15, 1);
    Connection::open(&synced).unwrap().execute_batch("CREATE TABLE search_index_doc (x); CREATE TABLE sync_guard (id INTEGER PRIMARY KEY);").unwrap();
    reset_triggers(&synced).unwrap();
    let names: Vec<String> = {
        let conn = Connection::open(&synced).unwrap();
        let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").unwrap();
        let rows = statement.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        rows
    };
    assert_eq!(names, ["search_task_ad", "search_task_ai", "search_task_au", "sync_task_ai", "sync_task_au"]);
}

#[test]
fn y02_restore_marker_written_by_the_y1_marker_only_when_a_sync_folder_is_configured() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("circletasks-daily-20261004.db"), b"x").unwrap();
    // Sans dossier de synchro : aucun marqueur (ADR 0010 règle 2).
    assert!(!write_restore_marker(dir.path(), &backups, "circletasks-daily-20261004.db", 1_791_187_200, 17).unwrap());
    assert!(!dir.path().join(MARKER_FILE).exists());
    // Dossier configuré (`sync/folder.json` du lot Y1) : marqueur de Y1 écrit, lu par `sync_restore_marker_get`, aucun .tmp laissé.
    fs::create_dir_all(dir.path().join(CONFIG_SUBDIR)).unwrap();
    fs::write(dir.path().join(CONFIG_SUBDIR).join(FOLDER_FILE), b"{}").unwrap();
    assert!(write_restore_marker(dir.path(), &backups, "circletasks-daily-20261004.db", 1_791_187_200, 17).unwrap());
    assert!(!dir.path().join(format!("{MARKER_FILE}.tmp")).exists());
    let read = marker::read(dir.path()).unwrap().unwrap();
    assert_eq!(read.backup, "circletasks-daily-20261004.db");
    assert_eq!(read.restored_at, "2026-10-05T08:00:00.000Z");
    assert_eq!(read.schema_version, 17);
    assert!(read.backup_taken_at.ends_with(".000Z"));
    let raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.path().join(MARKER_FILE)).unwrap()).unwrap();
    assert_eq!(raw.as_object().unwrap().len(), 5);
    assert_eq!(iso_instant(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_instant(1_791_187_200), "2026-10-05T08:00:00.000Z");
}

#[test]
fn y01_restore_recovered_at_startup_writes_no_marker() {
    // Restauration interrompue pendant l'échange puis récupérée au démarrage : la
    // récupération ne pose aucun marqueur, même avec un dossier de synchro configuré (Y-01 critère 16).
    let dir = scratch();
    fs::create_dir_all(dir.path().join(CONFIG_SUBDIR)).unwrap();
    fs::write(dir.path().join(CONFIG_SUBDIR).join(FOLDER_FILE), b"{}").unwrap();
    // État d'un arrêt brutal pendant l'échange (même état que p04_recovery_puts_the_old_database_back_when_the_main_file_is_missing).
    write(dir.path(), "circletasks.db.restore-old", b"main");
    write(dir.path(), "circletasks.db.restoring", b"nouvelle");
    assert_eq!(recover(dir.path()).unwrap(), Recovery::PutBack);
    assert!(!dir.path().join(MARKER_FILE).exists());
    assert_eq!(marker::read(dir.path()).unwrap(), None);
}

#[test]
fn p04_a_restore_resets_the_triggers_of_the_restored_database() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    let db = dir.path().join(DB_FILE);
    make_db(&db, 14, 2);
    Connection::open(&db).unwrap().execute_batch("CREATE TABLE search_index_doc (x);").unwrap();
    create_daily_backup(&db, &backups, "20261003", false, 14).unwrap();
    restore_backup_file(&db, &backups, "circletasks-daily-20261003.db", 14, "20261005T101500Z", NO_FAIL).unwrap();
    let count: u64 = Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 3, "les trois déclencheurs de task, recréés depuis la référence");
}

#[test]
fn p04_backup_files_are_opened_with_trusted_schema_off() {
    let dir = scratch();
    let path = dir.path().join("b.db");
    make_db(&path, 4, 1);
    let conn = open_read_only_with(&path, 100).unwrap();
    let trusted: i64 = conn.query_row("PRAGMA trusted_schema", [], |r| r.get(0)).unwrap();
    assert_eq!(trusted, 0);
}

#[test]
fn p04_a_view_named_schema_migrations_or_task_is_not_read_by_the_listing() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let conn = Connection::open(backups.join("circletasks-daily-20261003.db")).unwrap();
    conn.execute_batch("CREATE TABLE base (version INTEGER, deleted_at TEXT); INSERT INTO base VALUES (9, NULL); CREATE VIEW schema_migrations AS SELECT * FROM base; CREATE VIEW task AS SELECT * FROM base;").unwrap();
    drop(conn);
    let entries = list_backups_in(&backups).unwrap();
    assert_eq!((entries[0].tasks, entries[0].schema_version), (None, None));
}

#[test]
fn p04_a_backups_folder_that_is_a_link_is_refused() {
    let dir = scratch();
    let real = dir.path().join("vrai");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("circletasks-daily-20261003.db"), b"x").unwrap();
    let link = dir.path().join(BACKUP_DIR);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&real, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &link);
    if made.is_ok() {
        assert_eq!(list_backups_in(&link).unwrap_err().code, "not-found");
        assert_eq!(check_named_backup(&link, "circletasks-daily-20261003.db").unwrap_err().code, "not-found");
    }
    // Un dossier ordinaire absent : liste vide, sauvegarde introuvable.
    assert!(list_backups_in(&dir.path().join("absent")).unwrap().is_empty());
    assert_eq!(check_named_backup(&dir.path().join("absent"), "circletasks-daily-20261003.db").unwrap_err().code, "not-found");
}

#[test]
fn p04_the_migration_backup_command_returns_only_a_file_name() {
    let outcome = BackupOutcome { path: Some("C:\\Users\\Ali\\AppData\\Roaming\\fr.circletasks.planner\\backups\\circletasks-pre-migration-v0013-to-v0014-20261002T101500Z.db".into()), removed: 2 };
    let sent = outcome_for_webview(outcome);
    assert_eq!(sent.path.as_deref(), Some("circletasks-pre-migration-v0013-to-v0014-20261002T101500Z.db"));
    assert_eq!(sent.removed, 2);
    assert_eq!(outcome_for_webview(BackupOutcome { path: None, removed: 0 }).path, None);
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
