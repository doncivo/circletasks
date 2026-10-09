//! P-04-iOS (ADR 0009 avenant lot F B3 à B6) : valeur actuelle du verrouillage recopiée dans le fichier préparé, porte de démarrage et
//! enregistrement tardif du plugin SQL (runtime de test de Tauri), aucune 2e connexion pendant la restauration (pool à une connexion de
//! `vendor/tauri-plugin-sql`), marqueur de restauration renvoyé (écrit, non configuré, échec), même code sur le chemin de la plateforme iOS.

use std::fs;
use std::path::Path;

use circletasks_lib::backup::{carry_app_lock, restore_backup_file, RestoreStep, APP_LOCK_SETTING_KEY, APP_SCHEMA_VERSION, BACKUP_DIR, DB_FILE};
use circletasks_lib::startup_gate::{
    open_sql_pools, register_sql_after_recovery, status_of, write_marker_with_retry, MarkerToWrite, StartupGate, StartupStatus,
};
use rusqlite::Connection;
use tauri::Manager;

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

/// Base minimale de l'app avec `settings` (schéma de 0001_core_tables) et le verrou à `lock` (None : ligne absente).
fn make_db(path: &Path, lock: Option<&str>) {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)", []).unwrap();
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)", []).unwrap();
    conn.execute("INSERT INTO schema_migrations (version) VALUES (1)", []).unwrap();
    conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL, hlc TEXT NOT NULL)", []).unwrap();
    if let Some(value) = lock {
        conn.execute("INSERT INTO settings VALUES (?1, ?2, '2026-10-01T08:00:00.000Z', 'appareil', 'hlc-1')", [APP_LOCK_SETTING_KEY, value]).unwrap();
    }
}

fn lock_value(path: &Path) -> Option<String> {
    let conn = Connection::open(path).unwrap();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [APP_LOCK_SETTING_KEY], |r| r.get(0)).ok()
}

/// App avec une base actuelle (`current`) et une sauvegarde quotidienne (`saved`), restaurée.
fn restore_with(current: Option<&str>, saved: Option<&str>) -> Option<String> {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join("circletasks-daily-20261007.db"), saved);
    make_db(&dir.path().join(DB_FILE), current);
    restore_backup_file(&dir.path().join(DB_FILE), &backups, "circletasks-daily-20261007.db", APP_SCHEMA_VERSION, "20261008T080000Z", NO_FAIL).expect("restauration");
    lock_value(&dir.path().join(DB_FILE))
}

// --- critère 11 : la valeur actuelle du verrouillage prévaut ---

#[test]
fn p04_ios_11_an_old_version_never_disables_the_current_lock() {
    assert_eq!(restore_with(Some("true"), Some("false")).as_deref(), Some("true"));
    assert_eq!(restore_with(Some("true"), None).as_deref(), Some("true"));
    // Valeur actuelle illisible : échec fermé.
    assert_eq!(restore_with(Some("peut-être"), Some("false")).as_deref(), Some("true"));
}

#[test]
fn p04_ios_11_a_version_with_lock_stays_locked_and_the_reverse_changes_nothing() {
    assert_eq!(restore_with(Some("false"), Some("true")).as_deref(), Some("true"));
    assert_eq!(restore_with(None, Some("true")).as_deref(), Some("true"));
    assert_eq!(restore_with(Some("false"), Some("false")).as_deref(), Some("false"));
    assert_eq!(restore_with(None, None), None);
}

#[test]
fn p04_ios_11_unreadable_current_database_writes_true_and_metadata_is_kept() {
    let dir = scratch();
    let staged = dir.path().join("staged.db");
    make_db(&staged, Some("false"));
    let broken = dir.path().join("cassée.db");
    fs::write(&broken, b"ceci n'est pas une base SQLite, aucune en-tete").unwrap();
    carry_app_lock(&broken, &staged).unwrap();
    assert_eq!(lock_value(&staged).as_deref(), Some("true"));
    // Ligne actuelle recopiée entière (métadonnées comprises).
    let current = dir.path().join("current.db");
    make_db(&current, Some("true"));
    let other = dir.path().join("other.db");
    make_db(&other, Some("false"));
    carry_app_lock(&current, &other).unwrap();
    let conn = Connection::open(&other).unwrap();
    let row: (String, String, String) = conn.query_row("SELECT value, device_id, hlc FROM settings WHERE key = ?1", [APP_LOCK_SETTING_KEY], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(row, ("true".into(), "appareil".into(), "hlc-1".into()));
    // Aucune base actuelle (premier lancement) : rien à reporter.
    carry_app_lock(&dir.path().join("absente.db"), &staged).unwrap();
}

#[test]
fn p04_ios_11_the_key_is_the_one_of_the_domain() {
    let domain = include_str!("../../../src/domain/model/settings.ts");
    assert!(domain.contains(&format!("'{APP_LOCK_SETTING_KEY}': {{ scope: 'local'")), "clé et portée locale (aucune synchro)");
    let triggers = include_str!("../../src/backup_triggers.rs");
    assert!(!triggers.contains(APP_LOCK_SETTING_KEY), "aucun déclencheur de synchro ne vise le verrou");
}

// --- B3 : porte de démarrage et enregistrement tardif du plugin SQL (runtime de test) ---

#[test]
fn p04_ios_5_sql_plugin_is_registered_only_after_a_successful_recovery() {
    // Restauration interrompue après le déplacement de la base : remise en place AVANT toute ouverture, puis plugin SQL.
    let dir = scratch();
    fs::create_dir_all(dir.path().join(BACKUP_DIR)).unwrap();
    make_db(&dir.path().join(format!("{DB_FILE}.restore-old")), Some("true"));
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(app.try_state::<tauri_plugin_sql::DbInstances>().is_none(), "aucun plugin SQL avant la récupération");
    assert_eq!(status_of(None), StartupStatus { state: "pending", code: None });
    assert_eq!(register_sql_after_recovery(app.handle(), Some(dir.path())), Ok(()));
    assert!(dir.path().join(DB_FILE).is_file(), "ancienne base remise en place");
    assert!(app.try_state::<tauri_plugin_sql::DbInstances>().is_some(), "plugin SQL enregistré après");
    assert_eq!(status_of(app.try_state::<StartupGate>().as_deref()), StartupStatus { state: "ready", code: None });
}

#[test]
fn p04_ios_5_failed_recovery_registers_no_sql_plugin_and_keeps_the_files() {
    let dir = scratch();
    fs::create_dir_all(dir.path().join(BACKUP_DIR)).unwrap();
    // Conflit : base et `-wal.restore-old` présents, et la cible `-wal` occupée -> `recovery-conflict` ; rien n'est déplacé.
    make_db(&dir.path().join(DB_FILE), None);
    fs::write(dir.path().join(format!("{DB_FILE}-wal.restore-old")), b"ancien wal").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"wal actuel").unwrap();
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let outcome = register_sql_after_recovery(app.handle(), Some(dir.path()));
    assert!(outcome.is_err());
    assert!(app.try_state::<tauri_plugin_sql::DbInstances>().is_none(), "aucune base ne peut être ouverte ni créée");
    let status = status_of(app.try_state::<StartupGate>().as_deref());
    assert_eq!(status.state, "failed");
    assert_eq!(status.code, outcome.err());
    assert_eq!(fs::read(dir.path().join(format!("{DB_FILE}-wal.restore-old"))).unwrap(), b"ancien wal", ".restore-old intact");
    // Dossier de données introuvable : même porte fermée.
    let other = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert_eq!(register_sql_after_recovery(other.handle(), None), Err("no-data-dir"));
    assert!(other.try_state::<tauri_plugin_sql::DbInstances>().is_none());
}

// --- aucune 2e connexion pendant la restauration (pool à une connexion) ---

#[test]
fn p04_ios_6_restore_requires_every_sql_pool_to_be_closed() {
    let dir = scratch();
    make_db(&dir.path().join(DB_FILE), None);
    let url = format!("sqlite:{}", dir.path().join(DB_FILE).to_string_lossy());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let pool = tauri_plugin_sql::open_sqlite_pool(&url).await.unwrap();
        assert_eq!(pool.options().get_max_connections(), 1, "pool à une connexion");
        let instances = tauri_plugin_sql::DbInstances::default();
        instances.0.write().await.insert("sqlite:circletasks.db".into(), tauri_plugin_sql::DbPool::Sqlite(pool.clone()));
        assert_eq!(open_sql_pools(&instances).await, 1, "connexion ouverte : restauration refusée (db-open)");
        pool.close().await;
        assert_eq!(open_sql_pools(&instances).await, 0, "connexion fermée par le front : restauration permise");
    });
    let source = include_str!("../../src/backup.rs");
    let command = &source[source.find("pub async fn restore_backup(").unwrap()..];
    let guard = command.find("ensure_sql_closed(&app).await?").unwrap();
    assert!(guard < command.find("restore_with_provisional_marker(").unwrap(), "contrôle AVANT l'échange");
}

// --- critère 12 et règle 2 : marqueur renvoyé ---

#[test]
fn p04_ios_12_marker_outcome_is_returned_not_configured_or_failed() {
    let dir = scratch();
    let marker = MarkerToWrite { config_dir: dir.path().to_path_buf(), backup: "circletasks-daily-20261007.db".into(), restored_at_secs: 1_791_446_400, schema_version: 17 };
    // Aucun dossier de synchro configuré : aucun marqueur, ce n'est pas un échec.
    assert_eq!(write_marker_with_retry(&marker, std::time::Duration::from_millis(0)), ("not-configured", None));
    // Dossier de configuration inutilisable (un fichier à sa place) : échec renvoyé avec son code, jamais seulement journalisé.
    let blocked = dir.path().join("bloqué");
    fs::write(&blocked, b"x").unwrap();
    let broken = MarkerToWrite { config_dir: blocked, ..marker };
    let (state, code) = write_marker_with_retry(&broken, std::time::Duration::from_millis(0));
    assert!(state == "failed" || state == "not-configured", "{state}");
    if state == "failed" {
        assert!(code.is_some());
    }
    let source = include_str!("../../src/backup.rs");
    assert!(!source.contains("eprintln!"), "plus aucun eprintln! pour le marqueur");
    assert!(include_str!("../../src/startup_gate.rs").contains("RestoreOutcome { marker: state, marker_code: code, ..outcome }"));
}

#[test]
fn p04_ios_4_same_rust_code_on_the_platform_data_folder() {
    // Le dossier de l'iPhone (`Library/Application Support/<identifiant>`) : mêmes noms et même échange que sur PC.
    let dir = scratch();
    let config = dir.path().join("Library").join("Application Support").join("fr.circletasks.planner");
    fs::create_dir_all(config.join(BACKUP_DIR)).unwrap();
    make_db(&config.join(BACKUP_DIR).join("circletasks-daily-20261007.db"), None);
    make_db(&config.join(DB_FILE), None);
    let outcome = restore_backup_file(&config.join(DB_FILE), &config.join(BACKUP_DIR), "circletasks-daily-20261007.db", APP_SCHEMA_VERSION, "20261008T080000Z", NO_FAIL).unwrap();
    assert_eq!(outcome.marker, "not-configured");
    assert!(config.join(BACKUP_DIR).join("circletasks-pre-restore-20261008T080000Z.db").is_file());
}

// --- revue B1 : échange en échec sans retour arrière complet, jamais une base vide ---

#[test]
fn p04_ios_b1_failed_rollback_is_recovered_immediately_and_never_leaves_an_empty_base() {
    use circletasks_lib::startup_gate::recover_after_failed_swap;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join("circletasks-daily-20261007.db"), Some("false"));
    make_db(&dir.path().join(DB_FILE), Some("true"));
    let db = dir.path().join(DB_FILE);
    // Pendant l'échange, un obstacle prend la place de la base : le retour arrière de la base échoue (`rollback-failed`).
    let obstacle = db.clone();
    let hook = move |step: RestoreStep| -> std::io::Result<()> {
        if step == RestoreStep::OldMoved {
            fs::create_dir(&obstacle)?;
            return Err(std::io::Error::other("arrêt simulé"));
        }
        Ok(())
    };
    let error = restore_backup_file(&db, &backups, "circletasks-daily-20261007.db", APP_SCHEMA_VERSION, "20261008T080000Z", &hook).unwrap_err();
    assert_eq!(error.code, "rollback-failed");
    assert!(tauri_plugin_sql::restore_pending(&db), "le plugin SQL refuse d'ouvrir ou de créer la base");
    // L'obstacle passager disparaît : la récupération immédiate remet la vraie base en place.
    fs::remove_dir(&db).unwrap();
    assert_eq!(recover_after_failed_swap(&db, &backups), Some(Ok(())));
    assert_eq!(lock_value(&db).as_deref(), Some("true"), "la base d'avant, intacte");
    assert!(!tauri_plugin_sql::restore_pending(&db));
    assert_eq!(recover_after_failed_swap(&db, &backups), None, "rien en attente");
}

#[test]
fn p04_ios_b1_failed_immediate_recovery_closes_the_gate_and_keeps_the_files() {
    use circletasks_lib::startup_gate::recover_after_failed_swap;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let db = dir.path().join(DB_FILE);
    make_db(&db, None);
    fs::write(dir.path().join(format!("{DB_FILE}-wal.restore-old")), b"ancien wal").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"wal actuel").unwrap();
    let outcome = recover_after_failed_swap(&db, &backups).expect("en attente");
    let code = outcome.unwrap_err();
    let gate = StartupGate::default();
    gate.set(Ok(()));
    gate.set(Err(code));
    assert_eq!(status_of(Some(&gate)), StartupStatus { state: "failed", code: Some(code) }, "la porte peut repasser à l'échec");
    assert_eq!(fs::read(dir.path().join(format!("{DB_FILE}-wal.restore-old"))).unwrap(), b"ancien wal");
    assert!(tauri_plugin_sql::restore_pending(&db));
}

#[test]
fn p04_ios_b1_the_sql_plugin_checks_for_a_pending_restore_before_creating_the_database() {
    let wrapper = include_str!("../../vendor/tauri-plugin-sql/src/wrapper.rs");
    let connect = &wrapper[wrapper.find("pub(crate) async fn connect").unwrap()..];
    let check = connect.find("restore_pending(").unwrap();
    assert!(check < connect.find("create_database").unwrap() && check < connect.find("open_sqlite_pool(").unwrap());
    let command = include_str!("../../src/backup.rs");
    let restore = &command[command.find("pub async fn restore_backup(").unwrap()..];
    assert!(restore.contains("recover_after_failed_swap"));
}

// --- revue I1 : « Mettre les fichiers en conflit de côté » ---

#[test]
fn p04_ios_i1_conflicting_files_are_set_aside_never_deleted_then_recovery_succeeds() {
    use circletasks_lib::backup::recover_interrupted_restore;
    use circletasks_lib::startup_gate::set_aside_conflicts;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let db = dir.path().join(DB_FILE);
    make_db(&db, Some("true"));
    fs::write(dir.path().join(format!("{DB_FILE}-wal.restore-old")), b"ancien wal").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"wal en conflit").unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap_err().code, "recovery-conflict");
    assert_eq!(set_aside_conflicts(&db, &backups, "20261009T080000Z").map(|aside| aside.moved), Ok(1));
    let aside = backups.join("circletasks-set-aside-20261009T080000Z");
    assert_eq!(fs::read(aside.join(format!("{DB_FILE}-wal"))).unwrap(), b"wal en conflit", "déplacé, jamais supprimé");
    recover_interrupted_restore(&db, &backups).expect("récupération possible");
    assert_eq!(fs::read(dir.path().join(format!("{DB_FILE}-wal"))).unwrap(), b"ancien wal");
    // Le dossier mis de côté n'est ni listé ni purgé comme une sauvegarde.
    assert!(circletasks_lib::backup::list_backups_in(&backups).unwrap().iter().all(|entry| !entry.name.contains("set-aside")));
    assert!(aside.is_dir());
}

#[test]
fn p04_ios_i1_an_unsafe_restore_old_is_set_aside() {
    use circletasks_lib::backup::recover_interrupted_restore;
    use circletasks_lib::startup_gate::set_aside_conflicts;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let db = dir.path().join(DB_FILE);
    make_db(&db, Some("true"));
    fs::create_dir_all(dir.path().join(format!("{DB_FILE}.restore-old"))).unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap_err().code, "unsafe-restore-file");
    assert_eq!(set_aside_conflicts(&db, &backups, "20261009T080001Z").map(|aside| aside.moved), Ok(1));
    assert!(backups.join("circletasks-set-aside-20261009T080001Z").join(format!("{DB_FILE}.restore-old")).is_dir());
    recover_interrupted_restore(&db, &backups).expect("plus rien d'anormal");
    assert_eq!(lock_value(&db).as_deref(), Some("true"), "base actuelle intacte");
    assert_eq!(set_aside_conflicts(&db, &backups, "20261009T080002Z").map(|aside| aside.moved), Ok(0), "rien à déplacer");
}

// --- revue du lot F : mise de côté encadrée (porte, connexion, dossier ordinaire, destination exclusive, conservation) ---

#[test]
fn p04_ios_set_aside_is_refused_unless_the_gate_failed_on_a_conflict_and_no_pool_is_open() {
    use circletasks_lib::startup_gate::set_aside_allowed;
    assert_eq!(set_aside_allowed(Some(Err("recovery-conflict")), 0), Ok(()));
    assert_eq!(set_aside_allowed(Some(Err("unsafe-restore-file")), 0), Ok(()));
    assert_eq!(set_aside_allowed(Some(Err("recovery-conflict")), 1), Err("db-open"), "jamais avec une connexion ouverte");
    for outcome in [None, Some(Ok(())), Some(Err("io")), Some(Err("no-data-dir")), Some(Err("sql-plugin")), Some(Err("recovery-failed"))] {
        assert_eq!(set_aside_allowed(outcome, 0), Err("set-aside-refused"), "{outcome:?}");
    }
    // La commande vérifie la porte et les pools AVANT tout déplacement.
    let source = include_str!("../../src/startup_gate.rs");
    let command = &source[source.find("pub async fn backup_set_aside_conflicts(").unwrap()..];
    let allowed = command.find("set_aside_allowed(").unwrap();
    assert!(command.find("open_sql_pools(").unwrap() < allowed && allowed < command.find("set_aside_conflicts(&").unwrap());
}

#[test]
fn p04_ios_set_aside_moves_an_abnormal_backups_entry_itself_then_recovery_succeeds() {
    use circletasks_lib::backup::{recover_interrupted_restore, Recovery};
    use circletasks_lib::startup_gate::set_aside_conflicts;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::write(&backups, b"un fichier a la place du dossier").unwrap();
    let db = dir.path().join(DB_FILE);
    make_db(&db, Some("true"));
    fs::write(dir.path().join(format!("{DB_FILE}.restore-old")), b"ancienne base").unwrap();
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap_err().code, "unsafe-restore-file");
    let aside = set_aside_conflicts(&db, &backups, "20261009T090000Z").unwrap();
    assert_eq!(aside.moved, 1);
    assert!(!aside.fresh_base);
    let holder = dir.path().join("circletasks-set-aside-20261009T090000Z");
    assert_eq!(fs::read(holder.join(BACKUP_DIR)).unwrap(), b"un fichier a la place du dossier", "déplacé, jamais supprimé");
    assert!(backups.is_dir());
    assert_eq!(recover_interrupted_restore(&db, &backups).unwrap(), Recovery::Archived);
}

#[test]
fn p04_ios_set_aside_destination_is_created_exclusively_never_overwritten() {
    use circletasks_lib::startup_gate::set_aside_conflicts;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    let taken = backups.join("circletasks-set-aside-20261009T080000Z");
    fs::create_dir_all(&taken).unwrap();
    fs::write(taken.join(format!("{DB_FILE}-wal")), b"mise de cote precedente").unwrap();
    let db = dir.path().join(DB_FILE);
    make_db(&db, Some("true"));
    fs::write(dir.path().join(format!("{DB_FILE}-wal.restore-old")), b"ancien wal").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"wal en conflit").unwrap();
    assert_eq!(set_aside_conflicts(&db, &backups, "20261009T080000Z").map(|aside| aside.moved), Ok(1));
    assert_eq!(fs::read(taken.join(format!("{DB_FILE}-wal"))).unwrap(), b"mise de cote precedente", "jamais écrasé");
    let next = backups.join("circletasks-set-aside-20261009T080000Z-1");
    assert_eq!(fs::read(next.join(format!("{DB_FILE}-wal"))).unwrap(), b"wal en conflit");
}

#[test]
fn p04_ios_set_aside_of_an_unsafe_old_base_takes_its_journal_and_reports_a_fresh_base() {
    use circletasks_lib::backup::recover_interrupted_restore;
    use circletasks_lib::startup_gate::set_aside_conflicts;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let db = dir.path().join(DB_FILE);
    fs::create_dir_all(dir.path().join(format!("{DB_FILE}.restore-old"))).unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal.restore-old")), b"wal de l'ancienne base").unwrap();
    let aside = set_aside_conflicts(&db, &backups, "20261009T100000Z").unwrap();
    assert_eq!(aside.moved, 2, "le journal de l'ancienne base suit sa base : jamais remis à côté d'une autre");
    assert!(aside.fresh_base, "l'app va créer une base neuve : le message renvoie vers « Avant restauration »");
    let target = backups.join("circletasks-set-aside-20261009T100000Z");
    assert_eq!(fs::read(target.join(format!("{DB_FILE}-wal.restore-old"))).unwrap(), b"wal de l'ancienne base");
    recover_interrupted_restore(&db, &backups).expect("plus rien d'anormal");
    assert!(!dir.path().join(format!("{DB_FILE}-wal")).exists(), "aucun ancien journal remis");
}

#[test]
fn p04_ios_set_aside_folders_are_purged_after_30_days() {
    use circletasks_lib::backup::utc_stamp;
    use circletasks_lib::startup_gate::purge_set_aside;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let now = 1_791_590_400_u64; // 2026-10-10T00:00:00Z
    let old = backups.join(format!("circletasks-set-aside-{}", utc_stamp(now - 31 * 86_400)));
    let old_suffixed = dir.path().join(format!("circletasks-set-aside-{}-1", utc_stamp(now - 40 * 86_400)));
    let recent = backups.join(format!("circletasks-set-aside-{}", utc_stamp(now - 29 * 86_400)));
    for folder in [&old, &old_suffixed, &recent] {
        fs::create_dir_all(folder).unwrap();
        fs::write(folder.join("x"), b"x").unwrap();
    }
    let not_a_folder = backups.join(format!("circletasks-set-aside-{}", utc_stamp(now - 90 * 86_400)));
    fs::write(&not_a_folder, b"fichier").unwrap();
    let odd = backups.join("circletasks-set-aside-pas-une-date");
    fs::create_dir_all(&odd).unwrap();
    assert_eq!(purge_set_aside(dir.path(), now), 2);
    assert!(!old.exists() && !old_suffixed.exists());
    assert!(recent.is_dir() && not_a_folder.is_file() && odd.is_dir(), "seuls les dossiers datés de plus de 30 jours");
    // Purge faite au démarrage, après une récupération réussie.
    let source = include_str!("../../src/startup_gate.rs");
    let settle = &source[source.find("pub fn recover_and_settle(").unwrap()..];
    assert!(settle[..settle.find("\n}\n").unwrap()].contains("purge_set_aside("));
}

// --- revue I2 : nouvel essai du marqueur depuis le mémo ---

#[test]
fn p04_ios_i2_marker_retry_revalidates_the_name_and_reports_its_outcome() {
    use circletasks_lib::startup_gate::{write_marker_for, MarkerWriteOutcome};
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join("circletasks-daily-20261007.db"), None);
    assert_eq!(write_marker_for(dir.path(), "../circletasks.db", 1_791_446_400), MarkerWriteOutcome { marker: "failed", code: Some("bad-name") });
    assert_eq!(write_marker_for(dir.path(), "circletasks-daily-20261001.db", 1_791_446_400).marker, "failed", "sauvegarde absente");
    assert_eq!(write_marker_for(dir.path(), "circletasks-daily-20261007.db", 1_791_446_400), MarkerWriteOutcome { marker: "not-configured", code: None });
}

// --- revue : marqueur provisoire écrit AVANT l'échange, retiré si l'échange échoue ---

fn sync_configured(dir: &Path) {
    let config = dir.join(circletasks_lib::sync::folder::CONFIG_SUBDIR);
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join(circletasks_lib::sync::folder::FOLDER_FILE), b"{}").unwrap();
}

#[test]
fn p04_ios_marker_is_written_before_the_swap_and_undone_when_the_swap_fails() {
    use circletasks_lib::startup_gate::restore_with_provisional_marker;
    use circletasks_lib::sync::marker::MARKER_FILE;
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join("circletasks-daily-20261007.db"), None);
    make_db(&dir.path().join(DB_FILE), None);
    sync_configured(dir.path());
    let marker = dir.path().join(MARKER_FILE);
    // Le marqueur existe déjà au moment de l'échange (point d'arrêt) ; l'échange échoue : il est retiré.
    let seen = std::sync::Arc::new(std::sync::Mutex::new(false));
    let probe = seen.clone();
    let marker_probe = marker.clone();
    let failing = move |step: RestoreStep| -> std::io::Result<()> {
        if step == RestoreStep::OldMoved {
            *probe.lock().unwrap() = marker_probe.is_file();
            return Err(std::io::Error::other("arrêt simulé"));
        }
        Ok(())
    };
    assert!(restore_with_provisional_marker(dir.path(), "circletasks-daily-20261007.db", "20261008T080000Z", 1_791_446_400, &failing).is_err());
    assert!(*seen.lock().unwrap(), "marqueur écrit avant l'échange");
    assert!(!marker.exists(), "marqueur provisoire retiré après l'échec");
    // Un marqueur d'une restauration précédente (choix pas encore fait) est remis tel quel.
    fs::write(&marker, br#"{"v":1,"backup":"ancien","backupTakenAt":"x","restoredAt":"y","schemaVersion":17}"#).unwrap();
    let before = fs::read(&marker).unwrap();
    assert!(restore_with_provisional_marker(dir.path(), "circletasks-daily-20261007.db", "20261008T080001Z", 1_791_446_401, &failing).is_err());
    assert_eq!(fs::read(&marker).unwrap(), before);
    // Échange abouti : marqueur écrit, issue « written ».
    let (outcome, pending) = restore_with_provisional_marker(dir.path(), "circletasks-daily-20261007.db", "20261008T080002Z", 1_791_446_402, NO_FAIL).unwrap();
    assert_eq!(outcome.marker, "written");
    assert!(pending.is_none());
    assert!(fs::read_to_string(&marker).unwrap().contains("circletasks-daily-20261007.db"));
}

#[test]
fn p04_ios_11_unreadable_current_base_writes_true_with_valid_device_and_clock() {
    let dir = scratch();
    let staged = dir.path().join("staged.db");
    make_db(&staged, None);
    let conn = Connection::open(&staged).unwrap();
    conn.execute("INSERT INTO settings VALUES ('device.id', '\"60000000-0000-4000-8000-0000000000aa\"', '2026-10-01T08:00:00.000Z', '60000000-0000-4000-8000-0000000000aa', '0001791446400000-0000-60000000')", []).unwrap();
    drop(conn);
    let broken = dir.path().join("cassée.db");
    fs::write(&broken, b"pas une base").unwrap();
    carry_app_lock(&broken, &staged).unwrap();
    let conn = Connection::open(&staged).unwrap();
    let row: (String, String, String) = conn.query_row("SELECT value, device_id, hlc FROM settings WHERE key = ?1", [APP_LOCK_SETTING_KEY], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(row, ("true".into(), "60000000-0000-4000-8000-0000000000aa".into(), "0001791446400000-0000-60000000".into()));
}

// --- revue du lot F : marqueur provisoire, fermeture forcée à chaque étape ---

/// Restauration arrêtée net (panic) au point `stop`, avec un dossier de synchro configuré et, si `previous`, un marqueur d'une restauration
/// précédente ; puis démarrage : récupération et règlement du marqueur. Rend le marqueur lu après le démarrage.
fn crash_then_start(stop: RestoreStep, previous: bool) -> (Option<circletasks_lib::sync::marker::RestoreMarker>, tempfile::TempDir) {
    use circletasks_lib::startup_gate::{recover_and_settle, restore_with_provisional_marker};
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join("circletasks-daily-20261007.db"), None);
    make_db(&dir.path().join(DB_FILE), Some("true"));
    sync_configured(dir.path());
    if previous {
        fs::write(dir.path().join(circletasks_lib::sync::marker::MARKER_FILE), br#"{"v":1,"backup":"ancien","backupTakenAt":"x","restoredAt":"y","schemaVersion":17}"#).unwrap();
    }
    let hook = move |step: RestoreStep| -> std::io::Result<()> {
        if step == stop {
            panic!("arrêt forcé");
        }
        Ok(())
    };
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| restore_with_provisional_marker(dir.path(), "circletasks-daily-20261007.db", "20261008T080000Z", 1_791_446_400, &hook)));
    assert!(crashed.is_err(), "arrêt simulé");
    recover_and_settle(dir.path()).expect("récupération");
    (circletasks_lib::sync::marker::read(dir.path()).unwrap(), dir)
}

#[test]
fn p04_ios_provisional_marker_is_settled_after_a_forced_stop_at_each_step() {
    // Fichier préparé seulement (la version n'a jamais été en place) : aucun marqueur, la base d'avant reste.
    let (marker, dir) = crash_then_start(RestoreStep::Staged, false);
    assert_eq!(marker, None);
    assert_eq!(lock_value(&dir.path().join(DB_FILE)).as_deref(), Some("true"));
    // Ancienne base déplacée, nouvelle pas en place : ancienne remise (PutBack), aucun marqueur.
    let (marker, dir) = crash_then_start(RestoreStep::OldMoved, false);
    assert_eq!(marker, None);
    assert_eq!(lock_value(&dir.path().join(DB_FILE)).as_deref(), Some("true"));
    // Version en place (Archived au démarrage) : marqueur confirmé, la fenêtre de choix complète est due.
    let (marker, _dir) = crash_then_start(RestoreStep::Swapped, false);
    let marker = marker.expect("marqueur");
    assert_eq!(marker.backup, "circletasks-daily-20261007.db");
    assert!(!marker.provisional);
}

#[test]
fn p04_ios_provisional_marker_restores_the_previous_pending_marker_when_the_version_never_landed() {
    for stop in [RestoreStep::Staged, RestoreStep::OldMoved] {
        let (marker, dir) = crash_then_start(stop, true);
        let marker = marker.expect("marqueur d'avant remis");
        assert_eq!(marker.backup, "ancien", "{stop:?}");
        assert!(!marker.provisional);
        assert!(!dir.path().join(circletasks_lib::startup_gate::PREVIOUS_MARKER_FILE).exists());
    }
    let (marker, _dir) = crash_then_start(RestoreStep::Swapped, true);
    assert_eq!(marker.expect("nouveau").backup, "circletasks-daily-20261007.db");
}
