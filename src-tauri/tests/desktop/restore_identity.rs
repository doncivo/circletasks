//! Y-TECH-04 partie B : une restauration ne change jamais l'identité de l'appareil (décision d'Ali, 2026-10-17). La ligne `is_self` de
//! `sync_state` et le réglage local `device.id` de la base en place sont recopiés dans le fichier PRÉPARÉ, avant l'échange. Bases SQLite
//! réelles (schéma de `sync_state` de la migration 0015), arrêts forcés à chaque point du banc `RestoreStep`.

use std::fs;
use std::path::Path;

use circletasks_lib::backup::{restore_backup_file, RestoreStep, APP_SCHEMA_VERSION, BACKUP_DIR, DB_FILE};
use circletasks_lib::startup_gate::{recover_and_settle, restore_local_rollback, restore_with_provisional_marker};
use rusqlite::Connection;

/// Appareil courant (nouveau PC) et appareil oublié (ancien PC), identifiants du 2026-10-17.
const CURRENT: &str = "7d0b0a0a-0000-4000-8000-00000000007d";
const FORGOTTEN: &str = "56d40a0a-0000-4000-8000-000000000056";
const BACKUP: &str = "circletasks-daily-20261016.db";
const PRE_MIGRATION: &str = "circletasks-pre-migration-v0017-to-v0018-20261016T101500Z.db";

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

const NO_FAIL: &dyn Fn(RestoreStep) -> std::io::Result<()> = &|_| Ok(());

/// Une ligne de `sync_state` fabriquée : identifiant, `is_self`, époque, curseur (segment, enregistrement), accusé, statut.
struct Row {
    id: &'static str,
    is_self: bool,
    epoch: Option<&'static str>,
    cursor: (i64, i64),
    ack: Option<&'static str>,
    status: &'static str,
}

fn row(id: &'static str, is_self: bool, epoch: Option<&'static str>, cursor: (i64, i64)) -> Row {
    Row { id, is_self, epoch, cursor, ack: epoch.map(|_| "0001791446400000-0000-peer"), status: "active" }
}

/// Base de l'app minimale : `task`, `schema_migrations`, `settings` (avec `device.id` JSON si `device`) et `sync_state` (DDL de 0015).
fn make_db(path: &Path, device: Option<&str>, rows: &[Row]) {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(
        "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT);
         CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (17);
         CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL, hlc TEXT NOT NULL);
         CREATE TABLE sync_state (
           device_id TEXT PRIMARY KEY, is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)), platform TEXT, app_version TEXT, epoch TEXT,
           cursor_segment INTEGER NOT NULL DEFAULT 0, cursor_record INTEGER NOT NULL DEFAULT 0, ack_hlc TEXT,
           head_segment INTEGER NOT NULL DEFAULT 0, head_record INTEGER NOT NULL DEFAULT 0, head_hlc TEXT, state_epoch TEXT,
           state_seq INTEGER NOT NULL DEFAULT 0, state_digest TEXT, last_acks TEXT NOT NULL DEFAULT '{}', last_seen_hlc TEXT, last_sync_at TEXT,
           schema_version INTEGER, format_major INTEGER, kid TEXT, purge_horizon TEXT, snapshot_seq INTEGER, snapshot_hlc TEXT,
           status TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'expired', 'newer-major', 'clock-ahead', 'corrupt', 'foreign', 'rollback', 'forgotten'))
         );",
    )
    .unwrap();
    conn.execute("INSERT INTO task (title) VALUES ('tâche')", []).unwrap();
    if let Some(device) = device {
        conn.execute("INSERT INTO settings VALUES ('device.id', ?1, '2026-10-01T08:00:00.000Z', ?2, '0001791446400000-0000-hlc')", [format!("\"{device}\""), device.to_owned()]).unwrap();
    }
    for r in rows {
        conn.execute(
            "INSERT INTO sync_state (device_id, is_self, platform, epoch, cursor_segment, cursor_record, ack_hlc, status) VALUES (?1, ?2, 'windows', ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![r.id, r.is_self, r.epoch, r.cursor.0, r.cursor.1, r.ack, r.status],
        )
        .unwrap();
    }
}

/// Identifiant de la ligne `is_self = 1` (il n'y en a qu'une, sinon le test échoue).
fn self_id(db: &Path) -> String {
    let conn = Connection::open(db).unwrap();
    let ids: Vec<String> = conn.prepare("SELECT device_id FROM sync_state WHERE is_self = 1").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(ids.len(), 1, "exactement une ligne is_self : {ids:?}");
    ids.into_iter().next().unwrap()
}

fn device_setting(db: &Path) -> Option<String> {
    Connection::open(db).unwrap().query_row("SELECT value FROM settings WHERE key = 'device.id'", [], |r| r.get(0)).ok()
}

fn current_setting() -> String {
    format!("\"{CURRENT}\"")
}

type Dump = Vec<(String, i64, Option<String>, i64, i64, Option<String>, String)>;

/// Contenu de `sync_state` (identifiant, is_self, époque, curseur, accusé, statut), trié.
fn dump(db: &Path) -> Dump {
    let conn = Connection::open(db).unwrap();
    let mut statement = conn.prepare("SELECT device_id, is_self, epoch, cursor_segment, cursor_record, ack_hlc, status FROM sync_state ORDER BY device_id").unwrap();
    let rows: Dump = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))).unwrap().map(Result::unwrap).collect();
    rows
}

/// Appareil courant (`7d0b…`, ligne propre et réglage `device.id`) et sauvegarde dont la base désigne `FORGOTTEN` comme propre.
fn app_with_forgotten_backup() -> tempfile::TempDir {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(
        &backups.join(BACKUP),
        Some(FORGOTTEN),
        &[row(FORGOTTEN, true, Some("e0001-56d40a0a"), (3, 7)), row("aaaaaaaa-0000-4000-8000-0000000000aa", false, Some("e0001-56d40a0a"), (2, 4))],
    );
    make_db(&dir.path().join(DB_FILE), Some(CURRENT), &[row(CURRENT, true, Some("e0001-56d40a0a"), (1, 1))]);
    dir
}

fn restore(dir: &Path, name: &str) {
    restore_backup_file(&dir.join(DB_FILE), &dir.join(BACKUP_DIR), name, APP_SCHEMA_VERSION, "20261017T080000Z", NO_FAIL).expect("restauration");
}

// --- critères 9, 10, 11 : l'identité de l'appareil survit à la restauration ---

#[test]
fn y_tech_04_9_restoring_a_copy_made_by_the_forgotten_identity_keeps_the_current_identity() {
    let dir = app_with_forgotten_backup();
    restore(dir.path(), BACKUP);
    assert_eq!(self_id(&dir.path().join(DB_FILE)), CURRENT);
    // Le réglage local qui sert d'identité au démarrage (`device.id`) est celui de l'appareil, pas celui du fichier restauré.
    assert_eq!(device_setting(&dir.path().join(DB_FILE)), Some(current_setting()));
    // Les données de la sauvegarde sont bien celles qui sont en place.
    assert_eq!(Connection::open(dir.path().join(DB_FILE)).unwrap().query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn y_tech_04_10_the_old_identity_row_is_kept_as_a_non_self_device_with_its_positions() {
    let dir = app_with_forgotten_backup();
    restore(dir.path(), BACKUP);
    let rows = dump(&dir.path().join(DB_FILE));
    let old = rows.iter().find(|r| r.0 == FORGOTTEN).expect("l'ancienne ligne n'est jamais supprimée");
    assert_eq!((old.1, old.2.as_deref(), old.3, old.4), (0, Some("e0001-56d40a0a"), 3, 7));
    let peer = rows.iter().find(|r| r.0.starts_with("aaaaaaaa")).expect("les autres appareils sont conservés");
    assert_eq!((peer.1, peer.3, peer.4), (0, 2, 4));
}

#[test]
fn y_tech_04_13_a_current_identity_absent_from_the_backup_gets_a_row_without_position() {
    let dir = app_with_forgotten_backup();
    restore(dir.path(), BACKUP);
    let rows = dump(&dir.path().join(DB_FILE));
    let own = rows.iter().find(|r| r.0 == CURRENT).expect("ligne créée pour l'identité courante");
    // Époque nulle, curseur à zéro, aucun accusé : jamais {époque cible, 0, 0} d'office.
    assert_eq!((own.1, own.2.clone(), own.3, own.4, own.5.clone(), own.6.as_str()), (1, None, 0, 0, None, "active"));
}

#[test]
fn y_tech_04_11_a_backup_that_knows_the_current_identity_as_a_peer_hands_the_self_flag_back_without_position() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    // Sauvegarde faite par l'autre appareil : il connaissait `7d0b…` comme pair, avec des positions.
    make_db(&backups.join(BACKUP), Some(FORGOTTEN), &[row(FORGOTTEN, true, Some("e0001-56d40a0a"), (3, 7)), row(CURRENT, false, Some("e0001-56d40a0a"), (9, 9))]);
    make_db(&dir.path().join(DB_FILE), Some(CURRENT), &[row(CURRENT, true, Some("e0001-56d40a0a"), (1, 1))]);
    restore(dir.path(), BACKUP);
    let rows = dump(&dir.path().join(DB_FILE));
    assert_eq!(self_id(&dir.path().join(DB_FILE)), CURRENT);
    let own = rows.iter().find(|r| r.0 == CURRENT).unwrap();
    assert_eq!((own.2.clone(), own.3, own.4, own.5.clone()), (None, 0, 0, None), "la position vue par l'autre appareil n'est pas celle de soi");
    let old = rows.iter().find(|r| r.0 == FORGOTTEN).unwrap();
    assert_eq!((old.1, old.3, old.4), (0, 3, 7));
}

// --- critère 14 : jamais d'oubli de soi-même ---

#[test]
fn y_tech_04_14_the_forgotten_identity_stays_forgotten_and_the_device_never_forgets_itself() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let forgotten = Row { status: "forgotten", ..row(FORGOTTEN, true, Some("e0001-56d40a0a"), (3, 7)) };
    make_db(&backups.join(BACKUP), Some(FORGOTTEN), &[forgotten, Row { status: "forgotten", ..row(CURRENT, false, None, (0, 0)) }]);
    make_db(&dir.path().join(DB_FILE), Some(CURRENT), &[row(CURRENT, true, Some("e0001-56d40a0a"), (1, 1))]);
    // Déclarations d'oubli du dossier de synchro : jamais touchées par une restauration.
    let declaration = dir.path().join("forgotten.json");
    fs::write(&declaration, format!("{{\"{FORGOTTEN}\":\"declaration\"}}")).unwrap();
    let before = fs::read(&declaration).unwrap();
    restore(dir.path(), BACKUP);
    assert_eq!(fs::read(&declaration).unwrap(), before);
    let rows = dump(&dir.path().join(DB_FILE));
    let own = rows.iter().find(|r| r.0 == CURRENT).unwrap();
    assert_eq!((own.1, own.6.as_str()), (1, "active"), "l'appareil courant n'est jamais marqué oublié");
    assert_eq!(rows.iter().find(|r| r.0 == FORGOTTEN).unwrap().6, "forgotten");
}

// --- critère 15 : même identité, comportement d'avant ---

#[test]
fn y_tech_04_15_restoring_a_copy_of_the_same_identity_changes_nothing_in_sync_state() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_db(&backups.join(BACKUP), Some(CURRENT), &[row(CURRENT, true, Some("e0002-7d0b0a0a"), (5, 5)), row(FORGOTTEN, false, Some("e0001-56d40a0a"), (3, 7))]);
    make_db(&dir.path().join(DB_FILE), Some(CURRENT), &[row(CURRENT, true, Some("e0003-7d0b0a0a"), (1, 1))]);
    let saved = dump(&backups.join(BACKUP));
    restore(dir.path(), BACKUP);
    assert_eq!(dump(&dir.path().join(DB_FILE)), saved);
    assert_eq!(device_setting(&dir.path().join(DB_FILE)), Some(current_setting()));
}

#[test]
fn y_tech_04_12_restoring_twice_gives_the_same_result() {
    let dir = app_with_forgotten_backup();
    restore(dir.path(), BACKUP);
    let first = dump(&dir.path().join(DB_FILE));
    restore(dir.path(), BACKUP);
    assert_eq!(dump(&dir.path().join(DB_FILE)), first);
    assert_eq!(self_id(&dir.path().join(DB_FILE)), CURRENT);
}

// --- critère 12 : arrêt brutal à chaque étape ---

/// Restauration P-04 arrêtée net (panic) au point `stop`, puis démarrage (récupération et règlement du marqueur). `None` : jamais lancée.
fn crash_p04(stop: Option<RestoreStep>) -> tempfile::TempDir {
    let dir = app_with_forgotten_backup();
    if let Some(stop) = stop {
        let hook = move |step: RestoreStep| -> std::io::Result<()> {
            if step == stop {
                panic!("arrêt forcé");
            }
            Ok(())
        };
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| restore_with_provisional_marker(dir.path(), BACKUP, "20261017T080000Z", 1_791_446_400, &hook)));
        assert!(crashed.is_err(), "arrêt simulé");
    }
    recover_and_settle(dir.path()).expect("récupération");
    dir
}

#[test]
fn y_tech_04_12_a_forced_stop_at_each_step_of_a_p04_restoration_leaves_the_current_identity() {
    for stop in [None, Some(RestoreStep::Staged), Some(RestoreStep::OldMoved), Some(RestoreStep::Swapped)] {
        let dir = crash_p04(stop);
        let db = dir.path().join(DB_FILE);
        assert_eq!(self_id(&db), CURRENT, "arrêt à {stop:?}");
        assert_eq!(device_setting(&db), Some(current_setting()), "arrêt à {stop:?}");
    }
}

#[test]
fn y_tech_04_12_a_forced_stop_during_a_local_rollback_leaves_the_current_identity() {
    for stop in [RestoreStep::Staged, RestoreStep::OldMoved, RestoreStep::Swapped] {
        let dir = scratch();
        let backups = dir.path().join(BACKUP_DIR);
        fs::create_dir_all(&backups).unwrap();
        make_db(&backups.join(PRE_MIGRATION), Some(FORGOTTEN), &[row(FORGOTTEN, true, Some("e0001-56d40a0a"), (3, 7))]);
        make_db(&dir.path().join(DB_FILE), Some(CURRENT), &[row(CURRENT, true, Some("e0001-56d40a0a"), (1, 1))]);
        let hook = move |step: RestoreStep| -> std::io::Result<()> {
            if step == stop {
                panic!("arrêt forcé");
            }
            Ok(())
        };
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| restore_local_rollback(dir.path(), PRE_MIGRATION, "20261017T080000Z", &hook)));
        assert!(crashed.is_err());
        recover_and_settle(dir.path()).expect("récupération");
        assert_eq!(self_id(&dir.path().join(DB_FILE)), CURRENT, "arrêt à {stop:?}");
    }
}

#[test]
fn y_tech_04_12_a_refused_restoration_leaves_the_database_and_its_identity_untouched() {
    let dir = app_with_forgotten_backup();
    fs::write(dir.path().join(BACKUP_DIR).join(BACKUP), b"pas une base").unwrap();
    let before = dump(&dir.path().join(DB_FILE));
    assert!(restore_backup_file(&dir.path().join(DB_FILE), &dir.path().join(BACKUP_DIR), BACKUP, APP_SCHEMA_VERSION, "20261017T080000Z", NO_FAIL).is_err());
    assert_eq!(dump(&dir.path().join(DB_FILE)), before);
    assert_eq!(self_id(&dir.path().join(DB_FILE)), CURRENT);
}
