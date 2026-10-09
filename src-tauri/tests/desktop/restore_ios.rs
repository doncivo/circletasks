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
    assert!(guard < command.find("restore_backup_file(").unwrap(), "contrôle AVANT l'échange");
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
    assert!(source.contains("RestoreOutcome { marker: state, marker_code: code, ..outcome }"));
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
