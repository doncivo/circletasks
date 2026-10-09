//! QA du lot F (P-04-iOS) : restauration interrompue à chaque étape puis relance (jamais de base perdue ni à moitié écrite), sauvegarde
//! corrompue / tronquée / d'une autre version de schéma, échec d'écriture (disque plein) sans rien modifier.
//!
//! Un arrêt brutal (balayage de l'app, plantage) est simulé par un `panic!` dans le point d'arrêt des tests : le code d'échange n'exécute
//! alors AUCUN retour arrière (il laisse les fichiers dans l'état exact où un processus tué les aurait laissés), contrairement à un
//! `Err` qui déclenche le retour arrière. La « relance » est `recover_interrupted_restore` puis l'ouverture réelle de la base.

use std::fs;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use circletasks_lib::backup::{
    check_backup_file, create_daily_backup, recover_interrupted_restore, restore_backup_file, Recovery, RestoreStep, BACKUP_DIR, DB_FILE,
};
use rusqlite::Connection;

const APP_VERSION: u32 = 4;
const SAVED: &str = "circletasks-daily-20261003.db";
const STAMP: &str = "20261008T101500Z";
const NO_FAIL: &dyn Fn(RestoreStep) -> io::Result<()> = &|_| Ok(());

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut all: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    all.sort();
    all
}

fn init(conn: &Connection, version: u32, titles: &[String]) {
    conn.execute("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)", []).unwrap();
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)", []).unwrap();
    for v in 1..=version {
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?1)", [v]).unwrap();
    }
    for title in titles {
        conn.execute("INSERT INTO task (title) VALUES (?1)", [title]).unwrap();
    }
}

/// Titres lus par une OUVERTURE RÉELLE de la base (le WAL éventuel est rejoué) ; échoue si la base est absente, vide ou abîmée.
fn open_and_titles(path: &Path) -> Vec<String> {
    assert!(path.is_file(), "la base doit exister : {}", path.display());
    assert!(fs::metadata(path).unwrap().len() > 0, "jamais un fichier vide");
    let conn = Connection::open(path).unwrap();
    let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(check, "ok", "base à moitié écrite");
    let mut stmt = conn.prepare("SELECT title FROM task ORDER BY id").unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

fn old_titles() -> Vec<String> {
    vec!["ancienne 1".into(), "ancienne 2".into(), "dans le wal".into()]
}

fn saved_titles() -> Vec<String> {
    (0..5).map(|i| format!("sauvegarde {i}")).collect()
}

/// Dossier de l'app après un arrêt brutal AVANT la restauration : base de 3 tâches dont la dernière n'existe que dans le `-wal` (copié
/// pendant que la connexion est ouverte, comme le laisse un processus tué), plus une sauvegarde quotidienne de 5 tâches.
fn crashed_app_dir(saved_version: u32) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = scratch();
    let db = dir.path().join(DB_FILE);
    let backups = dir.path().join(BACKUP_DIR);
    let live = Connection::open(&db).unwrap();
    live.pragma_update(None, "journal_mode", "WAL").unwrap();
    live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    init(&live, APP_VERSION, &old_titles()[..2]);
    live.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    live.execute("INSERT INTO task (title) VALUES ('dans le wal')", []).unwrap();
    // Instantané octet pour octet de ce que le disque contient maintenant (base + journal), puis fin de la connexion.
    let snapshot = scratch();
    fs::copy(&db, snapshot.path().join(DB_FILE)).unwrap();
    fs::copy(dir.path().join("circletasks.db-wal"), snapshot.path().join("circletasks.db-wal")).unwrap();
    drop(live);
    for entry in fs::read_dir(dir.path()).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    fs::copy(snapshot.path().join(DB_FILE), &db).unwrap();
    fs::copy(snapshot.path().join("circletasks.db-wal"), dir.path().join("circletasks.db-wal")).unwrap();
    assert!(dir.path().join("circletasks.db-wal").metadata().unwrap().len() > 0, "le -wal doit porter la dernière tâche");
    // Sauvegarde choisie.
    let source = scratch();
    let src_db = source.path().join(DB_FILE);
    let conn = Connection::open(&src_db).unwrap();
    init(&conn, saved_version, &saved_titles());
    drop(conn);
    create_daily_backup(&src_db, &backups, "20261003", false, 14).unwrap();
    (dir, db, backups)
}

fn kill_at(db: &Path, backups: &Path, step: RestoreStep) {
    let hook = move |s: RestoreStep| -> io::Result<()> {
        if s == step {
            panic!("arrêt brutal simulé");
        }
        Ok(())
    };
    let outcome = catch_unwind(AssertUnwindSafe(|| restore_backup_file(db, backups, SAVED, APP_VERSION, STAMP, &hook)));
    assert!(outcome.is_err(), "le processus aurait dû être tué à {step:?}");
}

fn assert_clean(dir: &Path) {
    let left = names(dir);
    assert!(!left.iter().any(|n| n.contains(".restoring") || n.contains(".restore-old")), "restes après récupération : {left:?}");
}

/// La relance : récupération avant toute ouverture, deuxième récupération sans effet, puis une restauration normale réussit.
fn relaunch_then_restore_again(dir: &Path, db: &Path, backups: &Path) {
    assert_eq!(recover_interrupted_restore(db, backups).unwrap(), Recovery::Nothing, "une 2e récupération n'a rien à faire");
    assert_clean(dir);
    restore_backup_file(db, backups, SAVED, APP_VERSION, "20261008T111500Z", NO_FAIL).expect("une restauration normale reste possible après la récupération");
    assert_eq!(open_and_titles(db), saved_titles());
}

// --- tuée avant la copie : seule la copie de sécurité existe ---

#[test]
fn p04_ios_qa_kill_before_the_copy_leaves_the_old_database_untouched() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    // Copie de sécurité déjà écrite (première étape de `restore_backup_file`), rien d'autre.
    fs::copy(&db, backups.join("circletasks-pre-restore-20261008T101500Z.db")).unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::Nothing);
    assert_eq!(open_and_titles(&db), old_titles());
    relaunch_then_restore_again(dir.path(), &db, &backups);
}

// --- tuée pendant la copie : fichier préparé tronqué à côté de la base ---

#[test]
fn p04_ios_qa_kill_during_the_copy_discards_the_partial_staged_file() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    let whole = fs::read(backups.join(SAVED)).unwrap();
    fs::write(dir.path().join("circletasks.db.restoring"), &whole[..whole.len() / 2]).unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::StagedRemoved);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), old_titles());
    assert_eq!(fs::read(backups.join(SAVED)).unwrap(), whole, "la sauvegarde choisie n'est jamais touchée");
    relaunch_then_restore_again(dir.path(), &db, &backups);
}

// --- tuée juste après la préparation : fichier préparé complet, rien échangé ---

#[test]
fn p04_ios_qa_kill_after_staging_keeps_the_old_database_and_drops_the_staged_copy() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    kill_at(&db, &backups, RestoreStep::Staged);
    assert!(dir.path().join("circletasks.db.restoring").is_file());
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::StagedRemoved);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), old_titles(), "le -wal n'a pas bougé : la dernière tâche est là");
    relaunch_then_restore_again(dir.path(), &db, &backups);
}

// --- tuée pendant le remplacement : ancienne base déplacée, nouvelle pas encore en place ---

#[test]
fn p04_ios_qa_kill_between_the_old_files_moved_and_the_new_one_in_place_puts_the_old_back_with_its_wal() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    kill_at(&db, &backups, RestoreStep::OldMoved);
    assert!(!db.exists(), "à ce point, aucune base n'est en place");
    assert!(dir.path().join("circletasks.db.restore-old").is_file());
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::PutBack);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), old_titles());
    relaunch_then_restore_again(dir.path(), &db, &backups);
}

// --- tuée après le remplacement, avant le ménage et le rechargement ---

#[test]
fn p04_ios_qa_kill_after_the_swap_opens_on_the_restored_state_and_archives_the_old_files() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    // État laissé par un échange abouti dont le ménage des `.restore-old` n'a pas eu lieu : nouvelle base en place + anciens fichiers.
    let old_main = fs::read(&db).unwrap();
    let old_wal = fs::read(dir.path().join("circletasks.db-wal")).unwrap();
    restore_backup_file(&db, &backups, SAVED, APP_VERSION, STAMP, NO_FAIL).unwrap();
    fs::write(dir.path().join("circletasks.db.restore-old"), &old_main).unwrap();
    fs::write(dir.path().join("circletasks.db-wal.restore-old"), &old_wal).unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::Archived);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), saved_titles(), "la version restaurée est celle qui s'ouvre");
    // L'ancien état n'est pas perdu : il est archivé dans la famille « Avant restauration » et s'ouvre, WAL compris.
    let archived: Vec<String> = names(&backups).into_iter().filter(|n| n.starts_with("circletasks-pre-restore-") && n.ends_with(".db")).collect();
    assert!(archived.iter().any(|n| open_and_titles(&backups.join(n)) == old_titles()), "{archived:?}");
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::Nothing);
}

// --- tuée pendant la récupération elle-même (base remise, journal pas encore) ---

#[test]
fn p04_ios_qa_kill_in_the_middle_of_the_recovery_is_finished_by_the_next_launch() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    kill_at(&db, &backups, RestoreStep::OldMoved);
    // La récupération a remis la base puis a été tuée avant de remettre le -wal.
    fs::rename(dir.path().join("circletasks.db.restore-old"), &db).unwrap();
    assert!(dir.path().join("circletasks.db-wal.restore-old").is_file());
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::PutBack);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), old_titles());
}

// --- sauvegardes inutilisables : rien ne change ---

fn untouched_after_refusal(dir: &Path, db: &Path, backups: &Path, expected: &str) {
    let before_files = names(dir);
    let before_backups = names(backups);
    let before_main = fs::read(db).unwrap();
    let err = restore_backup_file(db, backups, SAVED, APP_VERSION, STAMP, NO_FAIL).unwrap_err();
    assert_eq!(err.code, expected, "{err:?}");
    assert_eq!(names(dir), before_files, "aucun fichier ajouté ni retiré");
    assert_eq!(names(backups), before_backups, "aucune copie de sécurité pour une restauration refusée");
    assert_eq!(fs::read(db).unwrap(), before_main);
    assert_eq!(open_and_titles(db), old_titles());
    assert!(!err.message.contains(&dir.to_string_lossy().into_owned()), "le message ne contient pas de chemin : {}", err.message);
}

#[test]
fn p04_ios_qa_truncated_backups_are_refused_and_nothing_changes() {
    for keep in [0_usize, 100, 4096, usize::MAX - 1, usize::MAX] {
        let (dir, db, backups) = crashed_app_dir(APP_VERSION);
        let path = backups.join(SAVED);
        let whole = fs::read(&path).unwrap();
        let cut = match keep {
            usize::MAX => whole.len() - 4096, // dernière page entière manquante (un octet de moins dans du remplissage nul reste lisible par SQLite)
            n if n == usize::MAX - 1 => whole.len() / 2,
            n => n,
        };
        assert!(cut < whole.len(), "la base de test doit dépasser {cut} octets ({} octets)", whole.len());
        fs::write(&path, &whole[..cut]).unwrap();
        // Même contrôle direct : le fichier tronqué n'est jamais déclaré valide.
        assert_eq!(check_backup_file(&path, APP_VERSION).map_err(|e| e.code), Err("corrupt"), "tronquée à {cut} octets sur {}", whole.len());
        untouched_after_refusal(dir.path(), &db, &backups, "corrupt");
    }
}

#[test]
fn p04_ios_qa_corrupted_backups_are_refused_and_nothing_changes() {
    for damage in ["octets-zéro-en-tête", "texte", "milieu-écrasé"] {
        let (dir, db, backups) = crashed_app_dir(APP_VERSION);
        let path = backups.join(SAVED);
        let mut bytes = fs::read(&path).unwrap();
        match damage {
            "octets-zéro-en-tête" => bytes[..100].fill(0),
            "texte" => bytes = b"ceci n'est pas une base".to_vec(),
            _ => {
                let mid = bytes.len() / 2;
                bytes[mid..mid + 2048].fill(0xFF);
            }
        }
        fs::write(&path, &bytes).unwrap();
        untouched_after_refusal(dir.path(), &db, &backups, "corrupt");
    }
}

#[test]
fn p04_ios_qa_future_schema_is_refused_past_schema_is_restored_for_the_migrations_to_replay() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION + 1);
    untouched_after_refusal(dir.path(), &db, &backups, "newer-schema");
    let (_older_dir, older_db, older_backups) = crashed_app_dir(1);
    let out = restore_backup_file(&older_db, &older_backups, SAVED, APP_VERSION, STAMP, NO_FAIL).unwrap();
    assert_eq!(out.schema_version, 1, "restaurée telle quelle : les migrations manquantes sont rejouées à l'ouverture");
    assert_eq!(open_and_titles(&older_db), saved_titles());
}

// --- espace disque insuffisant ---

#[test]
fn p04_ios_qa_disk_full_at_any_step_changes_nothing_and_leaves_no_partial_file() {
    for step in [RestoreStep::Staged, RestoreStep::OldMoved] {
        let (dir, db, backups) = crashed_app_dir(APP_VERSION);
        let main_before = fs::read(&db).unwrap();
        let wal_before = fs::read(dir.path().join("circletasks.db-wal")).unwrap();
        let full = move |s: RestoreStep| if s == step { Err(io::Error::from(io::ErrorKind::StorageFull)) } else { Ok(()) };
        let err = restore_backup_file(&db, &backups, SAVED, APP_VERSION, STAMP, &full).unwrap_err();
        assert_eq!(err.code, "io", "{step:?}");
        assert_eq!(fs::read(&db).unwrap(), main_before, "{step:?}");
        assert_eq!(fs::read(dir.path().join("circletasks.db-wal")).unwrap(), wal_before, "{step:?}");
        assert_clean(dir.path());
        assert_eq!(open_and_titles(&db), old_titles());
        // L'espace libéré, la même restauration réussit.
        restore_backup_file(&db, &backups, SAVED, APP_VERSION, "20261008T121500Z", NO_FAIL).expect("nouvel essai");
        assert_eq!(open_and_titles(&db), saved_titles());
    }
}

#[test]
fn p04_ios_qa_a_safety_copy_that_cannot_be_written_stops_before_anything_moves() {
    let (dir, db, backups) = crashed_app_dir(APP_VERSION);
    // La cible de la copie de sécurité est occupée par un dossier : l'écriture échoue (équivalent d'un disque plein à cette étape).
    fs::create_dir(backups.join(format!("circletasks-pre-restore-{STAMP}.db"))).unwrap();
    let without_shm = |dir: &Path| names(dir).into_iter().filter(|n| !n.ends_with("-shm")).collect::<Vec<_>>();
    let before_files = without_shm(dir.path());
    let err = restore_backup_file(&db, &backups, SAVED, APP_VERSION, STAMP, NO_FAIL).unwrap_err();
    assert!(!err.code.is_empty());
    assert_eq!(without_shm(dir.path()), before_files);
    assert_clean(dir.path());
    assert_eq!(open_and_titles(&db), old_titles());
    assert!(!backups.read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "aucun .tmp laissé");
}
