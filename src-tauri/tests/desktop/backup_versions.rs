//! K-05 critère 4 (ADR 0008 §10.2) : déclencheurs de référence d'une sauvegarde selon la version de schéma. Une sauvegarde de version 17 porte
//! les corps de la migration 0015 (capture de `task` et de `settings` sans les Rappels Apple) : elle est admise, et recréée avec ces corps ;
//! les corps de la migration 0018 ne sont valables qu'à partir de la version 18.

use std::path::Path;

use circletasks_lib::backup::{check_backup_file, normalize_sql, reset_triggers, APP_SCHEMA_VERSION};
use circletasks_lib::backup_triggers::{introduced_in, trigger_body_for, REFERENCE_TRIGGERS, SUPERSEDED_TRIGGERS};
use rusqlite::Connection;

const REPLACED: [&str; 3] = ["sync_settings_ai", "sync_settings_au", "sync_task_au"];

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// Base minimale de cette version, avec les tables qui rendent les déclencheurs de l'app admissibles et leurs corps valables à `bodies_version`.
fn make_db(path: &Path, version: u32, bodies_version: u32) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE sync_guard (id INTEGER PRIMARY KEY);").unwrap();
    for v in 1..=version {
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?1)", [v]).unwrap();
    }
    for table in ["task", "settings", "space", "project", "recurrence", "goal", "routine", "routine_log", "routine_pause", "reminder", "event", "checklist", "checklist_item", "focus_session", "calendar_account", "holiday", "search_index_doc"] {
        conn.execute_batch(&format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY, key TEXT);")).unwrap();
    }
    for (name, table, _) in REFERENCE_TRIGGERS {
        if name.starts_with("search_") {
            // Les déclencheurs de recherche citent des tables d'index absentes de cette base minimale : seuls ceux de capture comptent ici.
            continue;
        }
        let sql = trigger_body_for(name, table, bodies_version).unwrap();
        conn.execute_batch(sql).unwrap();
    }
}

fn error_code(path: &Path) -> &'static str {
    check_backup_file(path, APP_SCHEMA_VERSION).unwrap_err().code
}

#[test]
fn k05_4_the_three_replaced_triggers_have_a_superseded_body_valid_from_15_to_17() {
    assert_eq!(SUPERSEDED_TRIGGERS.len(), 3);
    for (name, table, sql, since, until) in SUPERSEDED_TRIGGERS {
        assert!(REPLACED.contains(&name));
        assert_eq!((since, until), (15, 18));
        assert_eq!(introduced_in(name), 18, "le corps actuel de {name} date de la version 18");
        let current = REFERENCE_TRIGGERS.iter().find(|(n, _, _)| *n == name).unwrap().2;
        assert_ne!(normalize_sql(sql), normalize_sql(current), "{name}");
        assert!(!sql.contains("apple_"), "{name} : le corps de la version 17 ignore les colonnes des Rappels Apple");
        assert!(current.contains("apple_") || name.starts_with("sync_settings"), "{name}");
        assert_eq!(trigger_body_for(name, table, 17), Some(sql));
        assert_eq!(trigger_body_for(name, table, 15), Some(sql));
        assert_eq!(trigger_body_for(name, table, 18), Some(current));
        assert_eq!(trigger_body_for(name, table, 99), Some(current));
    }
    // Les autres déclencheurs ont le même corps à toute version.
    for (name, table, sql) in REFERENCE_TRIGGERS {
        if !REPLACED.contains(&name) {
            assert_eq!(trigger_body_for(name, table, 17), Some(sql));
            assert_eq!(trigger_body_for(name, table, 18), Some(sql));
        }
    }
    assert_eq!(trigger_body_for("sync_task_au", "settings", 17), None, "table différente : inconnu");
    assert_eq!(trigger_body_for("evil", "task", 17), None);
}

#[test]
fn k05_4_a_version_17_backup_is_accepted_and_a_version_18_one_too() {
    let dir = scratch();
    let v17 = dir.path().join("v17.db");
    make_db(&v17, 17, 17);
    assert_eq!(check_backup_file(&v17, APP_SCHEMA_VERSION).unwrap(), 17);
    let v18 = dir.path().join("v18.db");
    make_db(&v18, 18, 18);
    assert_eq!(check_backup_file(&v18, APP_SCHEMA_VERSION).unwrap(), 18);
}

#[test]
fn k05_4_a_body_of_another_version_is_refused() {
    let dir = scratch();
    // Corps de la version 15 dans une base déclarée en 18 : refusé (la migration 0018 les aurait remplacés).
    let old_bodies = dir.path().join("v18-old-bodies.db");
    make_db(&old_bodies, 18, 17);
    assert_eq!(error_code(&old_bodies), "corrupt");
    // Corps de la version 18 dans une base de version 17 : refusé (ils citent des colonnes que la base n'a pas).
    let new_bodies = dir.path().join("v17-new-bodies.db");
    make_db(&new_bodies, 17, 18);
    assert_eq!(error_code(&new_bodies), "corrupt");
    // Corps modifié à la main, version 17 : refusé.
    let tampered = dir.path().join("v17-tampered.db");
    make_db(&tampered, 17, 17);
    Connection::open(&tampered).unwrap().execute_batch("DROP TRIGGER sync_task_au; CREATE TRIGGER sync_task_au AFTER UPDATE ON task BEGIN SELECT 1; END;").unwrap();
    assert_eq!(error_code(&tampered), "corrupt");
}

#[test]
fn k05_4_a_backup_newer_than_the_app_is_still_refused_as_newer_schema() {
    let dir = scratch();
    let newer = dir.path().join("v19.db");
    make_db(&newer, 19, 18);
    assert_eq!(check_backup_file(&newer, APP_SCHEMA_VERSION).unwrap_err().code, "newer-schema");
}

#[test]
fn k05_4_reset_triggers_recreates_the_bodies_of_the_backup_version_and_never_a_column_the_backup_lacks() {
    let dir = scratch();
    for (version, bodies) in [(17u32, 17u32), (18, 18)] {
        let path = dir.path().join(format!("restauree-{version}.db"));
        make_db(&path, version, bodies);
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE journal (x); CREATE TRIGGER evil AFTER INSERT ON task BEGIN INSERT INTO journal VALUES (1); END;").unwrap();
        reset_triggers(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        for name in REPLACED {
            let sql: String = conn.query_row("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1", [name], |r| r.get(0)).unwrap();
            let table = REFERENCE_TRIGGERS.iter().find(|(n, _, _)| *n == name).unwrap().1;
            assert_eq!(normalize_sql(&sql), normalize_sql(trigger_body_for(name, table, version).unwrap()), "{name} en version {version}");
        }
        let evil: u64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'evil'", [], |r| r.get(0)).unwrap();
        assert_eq!(evil, 0);
        drop(conn);
        // Le fichier préparé est admis tel quel par la vérification de la même version.
        assert_eq!(check_backup_file(&path, APP_SCHEMA_VERSION).unwrap(), version);
    }
}
