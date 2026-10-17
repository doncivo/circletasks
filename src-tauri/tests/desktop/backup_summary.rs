//! Y-TECH-04 partie C (côté Rust) : la liste des sauvegardes dit quel appareil a fait chaque copie et dans quelle époque (`deviceId`,
//! `platform`, `epoch`), lus en lecture seule. Chaque champ absent ou illisible vaut `None`, jamais une erreur de liste.

use circletasks_lib::backup::{list_backups_in, BackupEntry, BACKUP_DIR, MAX_BACKUP_BYTES};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

const DEVICE: &str = "56d40a0a-0000-4000-8000-000000000056";

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// Sauvegarde fabriquée : `task`, `schema_migrations`, et selon les cas `sync_state` (ligne propre, ligne d'un pair) et `sync_meta`.
struct Spec {
    sync_state: bool,
    own: Option<(&'static str, Option<&'static str>)>,
    peer: bool,
    sync_meta: bool,
    epoch_raw: Option<String>,
}

impl Spec {
    fn full() -> Spec {
        Spec { sync_state: true, own: Some((DEVICE, Some("windows"))), peer: true, sync_meta: true, epoch_raw: Some(format!("\"e0001-{DEVICE}\"")) }
    }
}

fn make_backup(path: &Path, spec: &Spec) {
    let conn = Connection::open(path).unwrap();
    // Journal « DELETE » comme les copies de l'app : le fichier reste seul sur le disque.
    conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0)).unwrap();
    conn.execute_batch(
        "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT);
         CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (17);
         INSERT INTO task (title) VALUES ('une'), ('deux');",
    )
    .unwrap();
    if spec.sync_state {
        conn.execute_batch(
            "CREATE TABLE sync_state (device_id TEXT PRIMARY KEY, is_self INTEGER NOT NULL DEFAULT 0, platform TEXT, epoch TEXT);
             INSERT INTO sync_state (device_id, is_self, platform) VALUES ('aaaaaaaa-0000-4000-8000-0000000000aa', 0, 'ios');",
        )
        .unwrap();
        if !spec.peer {
            conn.execute("DELETE FROM sync_state", []).unwrap();
        }
        if let Some((id, platform)) = spec.own {
            conn.execute("INSERT INTO sync_state (device_id, is_self, platform) VALUES (?1, 1, ?2)", rusqlite::params![id, platform]).unwrap();
        }
    }
    if spec.sync_meta {
        conn.execute_batch("CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sync_meta VALUES ('purgeHorizon', 'null');").unwrap();
        if let Some(raw) = &spec.epoch_raw {
            conn.execute("INSERT INTO sync_meta VALUES ('epoch', ?1)", [raw]).unwrap();
        }
    }
}

/// Une sauvegarde seule dans un dossier ; rend le dossier et l'entrée listée.
fn listed(spec: &Spec) -> (tempfile::TempDir, BackupEntry) {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_backup(&backups.join("circletasks-daily-20261016.db"), spec);
    let mut entries = list_backups_in(&backups).unwrap();
    assert_eq!(entries.len(), 1);
    (dir, entries.remove(0))
}

fn identity(entry: &BackupEntry) -> (Option<&str>, Option<&str>, Option<&str>) {
    (entry.device_id.as_deref(), entry.platform.as_deref(), entry.epoch.as_deref())
}

#[test]
fn y_tech_04_16_a_backup_reports_its_device_platform_and_decoded_epoch() {
    let (_dir, entry) = listed(&Spec::full());
    assert_eq!(identity(&entry), (Some(DEVICE), Some("windows"), Some(format!("e0001-{DEVICE}").as_str())));
    // Les champs existants sont inchangés.
    assert_eq!((entry.tasks, entry.schema_version), (Some(2), Some(17)));
}

#[test]
fn y_tech_04_16_the_listing_serializes_the_new_fields_in_camel_case() {
    let (_dir, entry) = listed(&Spec::full());
    let json = serde_json::to_value(&entry).unwrap();
    assert_eq!(json["deviceId"], DEVICE);
    assert_eq!(json["platform"], "windows");
    assert_eq!(json["epoch"], format!("e0001-{DEVICE}"));
    assert_eq!(json["schemaVersion"], 17);
    let (_dir, bare) = listed(&Spec { sync_state: false, sync_meta: false, ..Spec::full() });
    let json = serde_json::to_value(&bare).unwrap();
    assert!(json["deviceId"].is_null() && json["platform"].is_null() && json["epoch"].is_null(), "{json}");
}

#[test]
fn y_tech_04_16_only_the_self_row_designates_the_device() {
    // Aucune ligne propre : le pair n'est jamais pris pour l'auteur de la copie.
    let (_dir, entry) = listed(&Spec { own: None, ..Spec::full() });
    assert_eq!((entry.device_id, entry.platform), (None, None));
    // Plateforme absente sur la ligne propre : l'appareil est connu, la plateforme non.
    let (_dir, entry) = listed(&Spec { own: Some((DEVICE, None)), ..Spec::full() });
    assert_eq!((entry.device_id.as_deref(), entry.platform), (Some(DEVICE), None));
}

#[test]
fn y_tech_04_16_missing_tables_and_rows_give_none_for_the_field_only() {
    // Schéma antérieur à sync_state et sync_meta.
    let (_dir, entry) = listed(&Spec { sync_state: false, sync_meta: false, ..Spec::full() });
    assert_eq!((identity(&entry), entry.tasks, entry.schema_version), ((None, None, None), Some(2), Some(17)));
    // sync_meta sans la clé `epoch` : l'appareil reste connu.
    let (_dir, entry) = listed(&Spec { epoch_raw: None, ..Spec::full() });
    assert_eq!(identity(&entry), (Some(DEVICE), Some("windows"), None));
    // sync_state absent, sync_meta présente.
    let (_dir, entry) = listed(&Spec { sync_state: false, ..Spec::full() });
    assert_eq!(identity(&entry), (None, None, Some(format!("e0001-{DEVICE}").as_str())));
}

#[test]
fn y_tech_04_16_an_epoch_that_is_not_a_json_text_or_is_oversized_gives_none() {
    for raw in ["null", "12", "{\"a\":1}", "e0001-pas-du-json", "\"\"", &format!("\"{}\"", "x".repeat(200))] {
        let (_dir, entry) = listed(&Spec { epoch_raw: Some(raw.to_owned()), ..Spec::full() });
        assert_eq!(entry.epoch, None, "{raw}");
        assert_eq!(entry.device_id.as_deref(), Some(DEVICE), "{raw}");
    }
}

#[test]
fn y_tech_04_16_an_oversized_identifier_gives_none() {
    let long = "d".repeat(200);
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let path = backups.join("circletasks-daily-20261016.db");
    make_backup(&path, &Spec { own: None, ..Spec::full() });
    Connection::open(&path).unwrap().execute("INSERT INTO sync_state (device_id, is_self, platform) VALUES (?1, 1, 'windows')", [&long]).unwrap();
    let entry = list_backups_in(&backups).unwrap().remove(0);
    assert_eq!((entry.device_id, entry.platform.as_deref()), (None, Some("windows")));
}

#[test]
fn y_tech_04_16_a_file_over_the_size_bound_is_listed_without_being_read() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let path = backups.join("circletasks-daily-20261016.db");
    make_backup(&path, &Spec::full());
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_BACKUP_BYTES + 1).unwrap();
    let entry = list_backups_in(&backups).unwrap().remove(0);
    assert_eq!((identity(&entry), entry.tasks, entry.schema_version), ((None, None, None), None, None));
    assert_eq!(entry.size, MAX_BACKUP_BYTES + 1);
    fs::remove_file(&path).unwrap();
}

#[test]
fn y_tech_04_17_an_unreadable_backup_stays_listed_and_the_others_are_not_affected() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    make_backup(&backups.join("circletasks-daily-20261016.db"), &Spec::full());
    fs::write(backups.join("circletasks-daily-20261015.db"), b"ceci n'est pas une base SQLite, aucune en-tete").unwrap();
    fs::write(backups.join("circletasks-daily-20261014.db"), b"").unwrap();
    let entries = list_backups_in(&backups).unwrap();
    assert_eq!(entries.len(), 3);
    for entry in &entries {
        if entry.stamp == "20261016" {
            assert_eq!(identity(entry), (Some(DEVICE), Some("windows"), Some(format!("e0001-{DEVICE}").as_str())));
        } else {
            assert_eq!((identity(entry), entry.tasks, entry.schema_version), ((None, None, None), None, None), "{}", entry.name);
        }
    }
}

#[test]
fn y_tech_04_17_listing_never_writes_into_a_backup() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let healthy = backups.join("circletasks-daily-20261016.db");
    let broken = backups.join("circletasks-daily-20261015.db");
    make_backup(&healthy, &Spec::full());
    fs::write(&broken, b"ceci n'est pas une base SQLite, aucune en-tete").unwrap();
    let names = || {
        let mut all: Vec<String> = fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        all.sort();
        all
    };
    let (healthy_before, broken_before, names_before) = (fs::read(&healthy).unwrap(), fs::read(&broken).unwrap(), names());
    let modified_before = fs::metadata(&healthy).unwrap().modified().unwrap();
    for _ in 0..2 {
        assert_eq!(list_backups_in(&backups).unwrap().len(), 2);
    }
    assert_eq!(fs::read(&healthy).unwrap(), healthy_before);
    assert_eq!(fs::read(&broken).unwrap(), broken_before);
    assert_eq!(fs::metadata(&healthy).unwrap().modified().unwrap(), modified_before);
    // Ni journal ni fichier de mémoire partagée laissé à côté.
    assert_eq!(names(), names_before);
    assert!(!names().iter().any(|n| n.ends_with("-wal") || n.ends_with("-shm") || n.ends_with("-journal")));
}

#[test]
fn y_tech_04_16_the_listing_keeps_its_order_newest_first() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    for day in ["20261014", "20261016", "20261015"] {
        make_backup(&backups.join(format!("circletasks-daily-{day}.db")), &Spec::full());
    }
    let stamps: Vec<String> = list_backups_in(&backups).unwrap().into_iter().map(|e| e.stamp).collect();
    // Même ordre qu'avant : date de modification décroissante, puis horodatage du nom décroissant (fichiers créés dans la même seconde).
    let by_modified: Vec<String> = {
        let mut all: Vec<(u128, String)> = fs::read_dir(&backups)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.metadata().unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), e.file_name().to_string_lossy().replace("circletasks-daily-", "").replace(".db", ""))
            })
            .collect();
        all.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        all.into_iter().map(|(_, stamp)| stamp).collect()
    };
    assert_eq!(stamps, by_modified);
}

#[test]
fn y_tech_04_17_a_backup_left_in_wal_mode_is_read_without_leaving_a_journal_or_changing_bytes() {
    let dir = scratch();
    let backups = dir.path().join(BACKUP_DIR);
    fs::create_dir_all(&backups).unwrap();
    let path = backups.join("circletasks-daily-20261016.db");
    make_backup(&path, &Spec::full());
    // Copie déposée à la main par l'utilisateur : l'en-tête du fichier annonce le mode WAL (copie d'une base qui l'utilisait).
    {
        let conn = Connection::open(&path).unwrap();
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0)).unwrap();
    }
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let before = fs::read(&path).unwrap();
    let entry = list_backups_in(&backups).unwrap().remove(0);
    assert_eq!(entry.device_id.as_deref(), Some(DEVICE));
    assert_eq!(fs::read(&path).unwrap(), before);
    let leftovers: Vec<String> = fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with("-wal") || n.ends_with("-shm")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn y_tech_04_16_a_folder_name_with_special_characters_is_read_like_any_other() {
    let dir = scratch();
    let backups = dir.path().join("sauvegardes #é 100% +x");
    fs::create_dir_all(&backups).unwrap();
    make_backup(&backups.join("circletasks-daily-20261016.db"), &Spec::full());
    let entry = list_backups_in(&backups).unwrap().remove(0);
    assert_eq!((identity(&entry).0, entry.tasks), (Some(DEVICE), Some(2)));
}
