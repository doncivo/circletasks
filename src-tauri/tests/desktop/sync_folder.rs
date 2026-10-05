//! Y-01 critères 6, 7, 9, 13 et 14 sur le vrai système de fichiers Windows : `check_sync_path` (jonction, lien symbolique, partage
//! réseau, chemin final), `StdFs` (fichiers ouverts par handle, créés par rapport au handle du dossier, liens multiples refusés en
//! écriture), parcours complet avec `SystemBackend`, et test ignoré d'hydratation réelle (`CT_SYNC_TEST_DIR`).

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use circletasks_lib::sync::consent::ConsentGate;
use circletasks_lib::sync::files::{AppendMode, Availability, FsError, StdFs, SyncFs};
use circletasks_lib::sync::folder::{check_sync_path, normalize_final_path, FolderKind};
use circletasks_lib::sync::service::{AppendRequest, SyncCore, SyncOptions, SystemBackend};
use circletasks_lib::sync::store::RecordCursor;
use circletasks_lib::sync::SyncCode;
use circletasks_lib::vault::MemoryVault;

use crate::sync_support::{epoch, hlc, FakeUi, TestClock, DEV_A, NOW};

/// Dossier temporaire sous son chemin final (sans nom court 8.3 ni préfixe verbatim).
fn temp_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("dossier temporaire");
    let canonical = std::fs::canonicalize(dir.path()).unwrap();
    let text = canonical.to_string_lossy().into_owned();
    let path = PathBuf::from(normalize_final_path(&text).expect("chemin local"));
    (dir, path)
}

fn junction(link: &Path, target: &Path) -> bool {
    Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
}

fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
    match result {
        Ok(_) => panic!("erreur attendue"),
        Err(error) => error.code,
    }
}

#[test]
fn y01_6_normalizes_final_paths_and_refuses_network_prefixes() {
    assert_eq!(normalize_final_path(r"\\?\C:\Users\Ali\iCloudDrive\CircleTasks").as_deref(), Some(r"C:\Users\Ali\iCloudDrive\CircleTasks"));
    assert_eq!(normalize_final_path(r"C:\Dossier\").as_deref(), Some(r"C:\Dossier"));
    assert_eq!(normalize_final_path(r"C:\").as_deref(), Some(r"C:\"));
    for refused in [r"\\?\UNC\serveur\partage\x", r"\\serveur\partage\x", r"\\.\C:\x", r"\\?\GLOBALROOT\Device\x", r"relatif\x", "/srv/x"] {
        assert_eq!(normalize_final_path(refused), None, "{refused}");
    }
    assert_eq!(code(check_sync_path(Path::new(r"\\serveur\partage\CircleTasks"))), SyncCode::NotLocal);
    assert_eq!(code(check_sync_path(Path::new(r"\\?\UNC\serveur\partage\CircleTasks"))), SyncCode::NotLocal);
}

#[test]
fn y01_6_accepts_a_plain_local_folder_with_a_warning_kind() {
    let (_dir, root) = temp_root();
    let checked = check_sync_path(&root).unwrap();
    assert_eq!(checked.path, root);
    assert_eq!(checked.kind, FolderKind::Local, "hors iCloud : avertissement");
    assert_eq!(checked.name(), root.file_name().unwrap().to_string_lossy());
    // Casse différente : accepté, le chemin final (casse réelle) est enregistré.
    let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
    assert_eq!(check_sync_path(&upper).unwrap().path, root);
    assert_eq!(code(check_sync_path(&root.join("absent"))), SyncCode::FolderUnreachable);
    std::fs::write(root.join("fichier"), b"x").unwrap();
    assert_eq!(code(check_sync_path(&root.join("fichier"))), SyncCode::UnsafeFolder);
}

#[test]
fn y01_6_refuses_junctions_and_symbolic_links_on_any_component() {
    let (_dir, root) = temp_root();
    let target = root.join("cible");
    std::fs::create_dir_all(target.join("CircleTasks")).unwrap();
    let link = root.join("lien");
    assert!(junction(&link, &target), "mklink /J");
    assert_eq!(code(check_sync_path(&link)), SyncCode::UnsafeFolder, "dossier jonction");
    assert_eq!(code(check_sync_path(&link.join("CircleTasks"))), SyncCode::UnsafeFolder, "jonction sur un composant intermédiaire");
    // Lien symbolique : demande un privilège (mode développeur) ; testé quand il est disponible.
    let symlink = root.join("symlink");
    if std::os::windows::fs::symlink_dir(&target, &symlink).is_ok() {
        assert_eq!(code(check_sync_path(&symlink)), SyncCode::UnsafeFolder);
    }
    assert!(check_sync_path(&target.join("CircleTasks")).is_ok());
}

#[test]
fn y01_7_root_replaced_by_a_junction_between_two_operations_is_refused() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let fs = StdFs::new(check_sync_path(&folder).unwrap().path);
    fs.revalidate().unwrap();
    fs.create_dir(&["devices"]).unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    assert_eq!(fs.revalidate(), Err(FsError::Unreachable), "dossier déplacé ou démonté");
    let elsewhere = root.join("ailleurs");
    std::fs::create_dir(&elsewhere).unwrap();
    assert!(junction(&folder, &elsewhere));
    assert_eq!(fs.revalidate(), Err(FsError::Unsafe), "dossier devenu jonction");
    assert_eq!(fs.list(&["devices"], 10), Err(FsError::Unsafe));
    assert_eq!(fs.append(&["x.ctj"], b"x", AppendMode::CreateNew), Err(FsError::Unsafe), "aucune écriture");
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
}

#[test]
fn y01_13_files_are_opened_relative_to_the_checked_folder_and_hard_links_are_refused_for_writing() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let fs = StdFs::new(check_sync_path(&folder).unwrap().path);
    fs.create_dir(&["devices", DEV_A]).unwrap();
    fs.append(&["devices", DEV_A, "j.ctj"], b"ligne\n", AppendMode::CreateNew).unwrap();
    assert_eq!(fs.append(&["devices", DEV_A, "j.ctj"], b"x", AppendMode::CreateNew), Err(FsError::Exists));
    fs.append(&["devices", DEV_A, "j.ctj"], b"suite\n", AppendMode::Existing).unwrap();
    assert_eq!(fs.read(&["devices", DEV_A, "j.ctj"], 100, false).unwrap(), b"ligne\nsuite\n");
    assert_eq!(fs.read(&["devices", DEV_A, "j.ctj"], 5, false), Err(FsError::TooLarge), "taille contrôlée avant lecture");
    fs.write_atomic(&["devices", DEV_A, "state.ctx"], b"v1").unwrap();
    fs.write_atomic(&["devices", DEV_A, "state.ctx"], b"v2").unwrap();
    assert_eq!(std::fs::read(folder.join("devices").join(DEV_A).join("state.ctx")).unwrap(), b"v2");
    assert!(!folder.join("devices").join(DEV_A).join("state.ctx.tmp").exists());
    let listing = fs.list(&["devices", DEV_A], 10).unwrap();
    let mut names: Vec<_> = listing.entries.iter().map(|e| (e.name.clone(), e.availability.as_str())).collect();
    names.sort();
    assert_eq!(names, vec![("j.ctj".to_owned(), "local"), ("state.ctx".to_owned(), "local")]);
    // Fichier à plusieurs liens physiques : refusé en écriture.
    std::fs::hard_link(folder.join("devices").join(DEV_A).join("j.ctj"), root.join("autre-lien")).unwrap();
    assert_eq!(fs.append(&["devices", DEV_A, "j.ctj"], b"x", AppendMode::Existing), Err(FsError::Unsafe));
    // Sous-dossier remplacé par une jonction : refusé.
    let outside = root.join("dehors");
    std::fs::create_dir(&outside).unwrap();
    assert!(junction(&folder.join("devices").join("piege"), &outside));
    assert_eq!(fs.list(&["devices", "piege"], 10), Err(FsError::Unsafe));
    assert_eq!(fs.append(&["devices", "piege", "x"], b"x", AppendMode::CreateNew), Err(FsError::Unsafe));
    assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    let entry = fs.list(&["devices"], 10).unwrap().entries.into_iter().find(|e| e.name == "piege").unwrap();
    assert_eq!(entry.availability, Availability::Error, "listé comme point d'analyse refusé");
    // Suppression par handle ; dossier non vide jamais supprimé.
    assert!(fs.remove_file(&["devices", DEV_A, "state.ctx"]).unwrap());
    assert!(!fs.remove_file(&["devices", DEV_A, "state.ctx"]).unwrap());
    fs.remove_empty_dir(&["devices", DEV_A]).unwrap();
    assert!(folder.join("devices").join(DEV_A).exists());
}

/// Parcours complet sur le disque avec le contrôle et les fichiers de production (dossier local : avertissement, pas d'épinglage).
#[test]
fn y01_full_flow_on_disk_with_the_production_backend() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let base = tempfile::tempdir().unwrap();
    let clock = TestClock::new(NOW);
    let consent = Arc::new(ConsentGate::new(base.path().join("sync"), FakeUi::new(), clock.clock()));
    let core = SyncCore::new(SyncOptions::new(base.path().to_path_buf()), Arc::new(MemoryVault::default()), Arc::new(SystemBackend), consent, clock.clock());
    let info = core.choose_folder(&folder).unwrap();
    assert_eq!((info.name.as_deref(), info.kind), (Some("CircleTasks"), "local"));
    core.key_create().unwrap();
    core.bind_device(DEV_A).unwrap();
    let ep = epoch(1, DEV_A);
    let request = AppendRequest { epoch: ep.clone(), segment: 1, expect_records: 0, sv: 14, max_hlc: hlc(10, DEV_A), records: vec!["{\"t\":\"Acheter du pain\"}".into()] };
    core.append_journal(&request).unwrap();
    let state = serde_json::json!({
        "deviceId": DEV_A, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": ep, "stateSeq": 1,
        "head": { "epoch": ep, "segment": 1, "record": 1, "hlc": hlc(10, DEV_A), "stateSeq": 1 },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(10, DEV_A), "forgotten": [], "reset": null
    });
    core.write_state(14, state).unwrap();
    let scan = core.scan(&[]).unwrap();
    assert_eq!(scan.devices[0].state_status, "ok");
    let page = core.read_journal(DEV_A, &ep, RecordCursor { segment: 0, record: 0 }, None).unwrap();
    assert_eq!(page.records, vec!["{\"t\":\"Acheter du pain\"}".to_owned()]);
    let on_disk = std::fs::read(folder.join("devices").join(DEV_A).join(&ep).join("j-00000001.ctj")).unwrap();
    assert!(!String::from_utf8_lossy(&on_disk).contains("Acheter"));
    // Contrôles de l'existant inchangés : le dossier de sauvegarde garde son contrôle strict.
    assert!(circletasks_lib::export::is_local_disk_path(&folder));
}

/// Vérification manuelle d'Ali (Y-01, vérification 5) : hydratation réelle d'un fichier « en ligne seulement » d'iCloud Drive sur un
/// handle ouvert sans suivre le point d'analyse. `CT_SYNC_TEST_DIR` = sous-dossier **non épinglé** d'iCloud Drive contenant au moins un
/// fichier passé en « Libérer de l'espace ». Avec `CT_SYNC_EXPECT_STOPPED=1` (iCloud pour Windows quitté) : erreur
/// « Ouvrez iCloud pour Windows » attendue, sans plantage.
#[test]
#[ignore = "iCloud pour Windows réel : CT_SYNC_TEST_DIR"]
fn y01_14_real_icloud_placeholder_is_hydrated_on_the_checked_handle() {
    let dir = PathBuf::from(std::env::var("CT_SYNC_TEST_DIR").expect("CT_SYNC_TEST_DIR"));
    let checked = check_sync_path(&dir).expect("dossier accepté (balises cloud)");
    println!("nature du dossier : {:?}", checked.kind);
    let fs = StdFs::new(checked.path.clone());
    fs.revalidate().unwrap();
    let listing = fs.list(&[], 10_000).unwrap();
    let cloud = listing.entries.iter().find(|e| !e.is_dir && e.availability == Availability::Cloud).expect("un fichier « en ligne seulement »");
    println!("fichier dans le nuage : {} ({} octets annoncés)", cloud.name, cloud.size);
    assert_eq!(fs.read(&[&cloud.name], u64::MAX, false), Err(FsError::CloudPending), "jamais hydraté sans demande");
    let result = fs.read(&[&cloud.name], 1 << 30, true);
    if std::env::var("CT_SYNC_EXPECT_STOPPED").is_ok_and(|v| v == "1") {
        assert_eq!(result, Err(FsError::ProviderStopped), "iCloud arrêté : « Ouvrez iCloud pour Windows »");
        return;
    }
    let bytes = result.expect("hydratation");
    assert_eq!(bytes.len() as u64, cloud.size, "le contenu est lu, pas la balise");
    let after = fs.list(&[], 10_000).unwrap().entries.into_iter().find(|e| e.name == cloud.name).unwrap();
    assert_eq!(after.availability, Availability::Local);
}
