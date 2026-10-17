//! Y-TECH-04 partie B, bloquant B1 de la revue : l'état de synchro qui porte l'identité suit l'identité. Restaurer la copie d'un AUTRE appareil
//! ne doit laisser ni sa tête de publication (`sync_meta`) ni ses écritures non publiées signées de son nom : le publieur n'envoie que les champs
//! dont l'horloge porte l'identité de l'appareil, et écrirait au segment et à l'enregistrement de l'autre appareil dans le journal du premier.

use std::fs;
use std::path::Path;

use circletasks_lib::backup::{restore_backup_file, RestoreStep, APP_SCHEMA_VERSION, BACKUP_DIR, DB_FILE};
use rusqlite::Connection;

const CURRENT: &str = "7d0b0a0a-0000-4000-8000-00000000007d";
const FORGOTTEN: &str = "56d40a0a-0000-4000-8000-000000000056";
const PEER: &str = "aaaaaaaa-0000-4000-8000-0000000000aa";
const BACKUP: &str = "circletasks-daily-20261016.db";

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// Horloge hybride à la forme de l'app : 15 chiffres de millisecondes, compteur sur 4 chiffres, identifiant de l'appareil.
fn hlc(ms: u64, device: &str) -> String {
    format!("{ms:015}-0000-{device}")
}

/// Base synchronisée minimale : `settings` (dont les déclencheurs de capture sont recréés à la restauration), tables de la synchro, `sync_state`
/// (ligne propre) et `sync_meta`. `settings` : (clé, valeur JSON, hlc) ; `clocks` : (clé, champ, hlc) ; `outbox` : (clé, champ) ; `meta` : (clé, valeur).
fn make_synced_db(path: &Path, device: &str, settings: &[(&str, &str, String)], clocks: &[(&str, &str, String)], outbox: &[(&str, &str)], meta: &[(&str, &str)]) {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(
        "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT);
         CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (17);
         CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL, hlc TEXT NOT NULL);
         CREATE TABLE search_index_doc (id INTEGER PRIMARY KEY, type TEXT, ref_id TEXT);
         CREATE TABLE sync_guard (id INTEGER PRIMARY KEY);
         CREATE TABLE sync_field_clock (table_name TEXT NOT NULL, row_id TEXT NOT NULL, field TEXT NOT NULL, hlc TEXT NOT NULL, base_hlc TEXT, PRIMARY KEY (table_name, row_id, field));
         CREATE TABLE sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL, field TEXT NOT NULL, UNIQUE (table_name, row_id, field));
         CREATE TABLE sync_tombstone (table_name TEXT NOT NULL, row_id TEXT NOT NULL, deleted_hlc TEXT NOT NULL, purged_at TEXT NOT NULL, PRIMARY KEY (table_name, row_id));
         CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE sync_state (device_id TEXT PRIMARY KEY, is_self INTEGER NOT NULL DEFAULT 0, platform TEXT, app_version TEXT, epoch TEXT,
           cursor_segment INTEGER NOT NULL DEFAULT 0, cursor_record INTEGER NOT NULL DEFAULT 0, ack_hlc TEXT, status TEXT NOT NULL DEFAULT 'active');",
    )
    .unwrap();
    conn.execute("INSERT INTO settings VALUES ('device.id', ?1, '2026-10-01T08:00:00.000Z', ?2, ?3)", rusqlite::params![format!("\"{device}\""), device, hlc(1_790_000_000_000, device)]).unwrap();
    conn.execute("INSERT INTO sync_state (device_id, is_self, platform) VALUES (?1, 1, 'windows')", [device]).unwrap();
    for (key, value, h) in settings {
        conn.execute("INSERT INTO settings VALUES (?1, ?2, '2026-10-16T08:00:00.000Z', ?3, ?4)", rusqlite::params![key, value, &h[21..], h]).unwrap();
    }
    for (key, field, h) in clocks {
        conn.execute("INSERT INTO sync_field_clock VALUES ('settings', ?1, ?2, ?3, NULL)", rusqlite::params![key, field, h]).unwrap();
    }
    for (key, field) in outbox {
        conn.execute("INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('settings', ?1, ?2)", [key, field]).unwrap();
    }
    for (key, value) in meta {
        conn.execute("INSERT INTO sync_meta VALUES (?1, ?2)", [key, value]).unwrap();
    }
}

fn setting_hlc(db: &Path, key: &str) -> (String, String) {
    Connection::open(db).unwrap().query_row("SELECT hlc, device_id FROM settings WHERE key = ?1", [key], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

fn clock_of(db: &Path, key: &str, field: &str) -> Option<String> {
    Connection::open(db).unwrap().query_row("SELECT hlc FROM sync_field_clock WHERE row_id = ?1 AND field = ?2", [key, field], |r| r.get(0)).ok()
}

fn meta_of(db: &Path) -> Vec<(String, String)> {
    let conn = Connection::open(db).unwrap();
    let mut statement = conn.prepare("SELECT key, value FROM sync_meta ORDER BY key").unwrap();
    let rows: Vec<(String, String)> = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    rows
}

fn outbox_of(db: &Path) -> Vec<(String, String)> {
    let conn = Connection::open(db).unwrap();
    let mut statement = conn.prepare("SELECT row_id, field FROM sync_outbox ORDER BY seq").unwrap();
    let rows: Vec<(String, String)> = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    rows
}

fn restore(dir: &Path) {
    restore_backup_file(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), BACKUP, APP_SCHEMA_VERSION, "20261017T080000Z", NO_FAIL).expect("restauration");
}

/// Appareil courant `7d0b…` avec son état de synchro propre ; sauvegarde de `56d4…` : lignes non publiées (file d'envoi), lignes publiées,
/// état de publication de l'autre appareil.
fn app_with_synced_backup() -> tempfile::TempDir {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_synced_db(
        &backups.join(BACKUP),
        FORGOTTEN,
        &[
            // Ligne créée par l'autre appareil, jamais publiée (entrée « * »).
            ("general.theme", "\"dark\"", hlc(1_791_000_000_001, FORGOTTEN)),
            // Ligne publiée puis modifiée : champ « value » non publié, horloge « * » publiée.
            ("general.locale", "\"fr\"", hlc(1_791_000_000_003, FORGOTTEN)),
            // Ligne d'un pair et ligne de l'autre appareil déjà publiées : aucune entrée en file.
            ("general.timeFormat", "\"24h\"", hlc(1_791_000_000_004, PEER)),
            ("general.firstWeekday", "1", hlc(1_791_000_000_005, FORGOTTEN)),
        ],
        &[("general.locale", "*", hlc(1_791_000_000_002, FORGOTTEN)), ("general.locale", "value", hlc(1_791_000_000_003, FORGOTTEN))],
        &[("general.theme", "*"), ("general.locale", "value")],
        &[
            ("epoch", "\"e0001-56d40a0a\""),
            ("stateSeq", "9"),
            ("head", "{\"epoch\":\"e0001-56d40a0a\",\"segment\":3,\"record\":7,\"hlc\":null,\"stateSeq\":9}"),
            ("snapshot", "{\"epoch\":\"e0001-56d40a0a\",\"seq\":1}"),
            ("segments", "{\"3\":\"2026-10-16T08:00:00.000Z\"}"),
            ("ownStateHlcs", "[[9,\"x\"]]"),
            ("orphanTraces", "[\"task|t1\"]"),
            ("purgeHorizon", "\"001791187200000-0000-aaaa\""),
        ],
    );
    make_synced_db(
        &dir.path().join(DB_FILE),
        CURRENT,
        &[("general.theme", "\"light\"", hlc(1_791_000_000_900, CURRENT))],
        &[],
        &[],
        &[
            ("epoch", "\"e0001-56d40a0a\""),
            ("stateSeq", "4"),
            ("head", "{\"epoch\":\"e0001-56d40a0a\",\"segment\":2,\"record\":5,\"hlc\":\"h\",\"stateSeq\":4}"),
            ("ownStateHlcs", "[[4,\"y\"]]"),
            ("purgeHorizon", "\"001791187200000-0000-bbbb\""),
        ],
    );
    dir
}

#[test]
fn y_tech_04_b1_the_unpublished_writes_of_the_other_device_are_resigned_with_the_current_identity() {
    let dir = app_with_synced_backup();
    restore(dir.path());
    let db = dir.path().join(DB_FILE);
    // Ligne entière non publiée : ligne et horloge d'ensemble au nom de l'appareil courant, même instant et même compteur.
    assert_eq!(setting_hlc(&db, "general.theme"), (hlc(1_791_000_000_001, CURRENT), CURRENT.to_owned()));
    // Champ non publié : son horloge change de signataire, l'horloge « * » déjà publiée reste celle de l'autre appareil.
    assert_eq!(clock_of(&db, "general.locale", "value"), Some(hlc(1_791_000_000_003, CURRENT)));
    assert_eq!(clock_of(&db, "general.locale", "*"), Some(hlc(1_791_000_000_002, FORGOTTEN)));
    assert_eq!(setting_hlc(&db, "general.locale"), (hlc(1_791_000_000_003, CURRENT), CURRENT.to_owned()));
    // Ce qui était déjà publié (pair ou autre appareil) n'est pas touché.
    assert_eq!(setting_hlc(&db, "general.timeFormat"), (hlc(1_791_000_000_004, PEER), PEER.to_owned()));
    assert_eq!(setting_hlc(&db, "general.firstWeekday"), (hlc(1_791_000_000_005, FORGOTTEN), FORGOTTEN.to_owned()));
    // La file d'envoi garde les mêmes entrées (rien n'est perdu, rien n'est ajouté par les déclencheurs) et la garde est levée.
    assert_eq!(outbox_of(&db), vec![("general.theme".to_owned(), "*".to_owned()), ("general.locale".to_owned(), "value".to_owned())]);
    assert_eq!(Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM sync_guard", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn y_tech_04_b1_the_publication_state_of_the_other_device_is_replaced_by_the_one_of_the_current_device() {
    let dir = app_with_synced_backup();
    restore(dir.path());
    let meta = meta_of(&dir.path().join(DB_FILE));
    let get = |key: &str| meta.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    // Tête, numéro d'état et repères de l'appareil courant : ils décrivent SON journal, que le dossier contient déjà.
    assert_eq!(get("stateSeq"), Some("4"));
    assert_eq!(get("head"), Some("{\"epoch\":\"e0001-56d40a0a\",\"segment\":2,\"record\":5,\"hlc\":\"h\",\"stateSeq\":4}"));
    assert_eq!(get("ownStateHlcs"), Some("[[4,\"y\"]]"));
    assert_eq!(get("epoch"), Some("\"e0001-56d40a0a\""));
    // Ce que l'appareil courant n'a pas est absent (jamais la valeur de l'autre appareil).
    for key in ["snapshot", "segments", "orphanTraces"] {
        assert_eq!(get(key), None, "{key}");
    }
    // Le reste de la méta vient de la sauvegarde.
    assert_eq!(get("purgeHorizon"), Some("\"001791187200000-0000-aaaa\""));
}

#[test]
fn y_tech_04_b1_restoring_a_copy_of_the_same_identity_keeps_its_publication_state_and_its_signatures() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let settings = [("general.theme", "\"dark\"", hlc(1_791_000_000_001, CURRENT))];
    make_synced_db(&backups.join(BACKUP), CURRENT, &settings, &[], &[("general.theme", "*")], &[("stateSeq", "2"), ("head", "{\"segment\":1}")]);
    make_synced_db(&dir.path().join(DB_FILE), CURRENT, &settings, &[], &[], &[("stateSeq", "7"), ("head", "{\"segment\":6}"), ("snapshot", "{}")]);
    restore(dir.path());
    let db = dir.path().join(DB_FILE);
    assert_eq!(meta_of(&db), meta_of(&backups.join(BACKUP)));
    assert_eq!(setting_hlc(&db, "general.theme"), (hlc(1_791_000_000_001, CURRENT), CURRENT.to_owned()));
    assert_eq!(outbox_of(&db), vec![("general.theme".to_owned(), "*".to_owned())]);
}
