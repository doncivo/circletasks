//! QA du lot Y1 (Y-01 critères 6, 7, 11 et 13) : chemins Windows piégés sur le vrai système de fichiers. Complète `sync_folder.rs`.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;

use std::os::windows::process::CommandExt;

use circletasks_lib::sync::files::{AppendMode, StdFs, SyncFs};
use circletasks_lib::sync::folder::{check_sync_path, normalize_final_path, CheckedFolder, FolderKind};
use circletasks_lib::sync::{SyncCode, SyncError};

fn temp_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("dossier temporaire");
    let canonical = std::fs::canonicalize(dir.path()).unwrap();
    let path = PathBuf::from(normalize_final_path(&canonical.to_string_lossy()).expect("chemin local"));
    (dir, path)
}

fn refused(result: Result<CheckedFolder, SyncError>) -> SyncCode {
    match result {
        Ok(folder) => panic!("accepté à tort : {}", folder.path.display()),
        Err(error) => error.code,
    }
}

const REFUSALS: [SyncCode; 4] = [SyncCode::NotLocal, SyncCode::UnsafeFolder, SyncCode::FolderUnreachable, SyncCode::BadName];

#[test]
fn y01_6_drive_relative_device_and_malformed_paths_are_refused() {
    for path in [
        "",
        "C:",
        "C:CircleTasks",
        r"C:..\CircleTasks",
        "/CircleTasks",
        "//serveur/partage/CircleTasks",
        r"\\.\C:\CircleTasks",
        r"\\.\PhysicalDrive0",
        r"\\.\pipe\x",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\CircleTasks",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\CircleTasks",
        r"\\?\UNC\localhost\C$\CircleTasks",
        r"\\localhost\C$\CircleTasks",
        r"\\127.0.0.1\C$\CircleTasks",
        "C:/CircleTasks",
        "1:\\CircleTasks",
        "é:\\CircleTasks",
        "relatif\\CircleTasks",
        ".",
        "..",
    ] {
        let code = refused(check_sync_path(Path::new(path)));
        assert!(REFUSALS.contains(&code), "{path:?} -> {code:?}");
        if path.starts_with(r"\\") || path.contains('/') || !path.contains(':') || path.len() < 3 {
            assert_eq!(code, SyncCode::NotLocal, "{path:?}");
        }
    }
}

#[test]
fn y01_6_dot_dot_components_and_verbatim_prefix_tricks_are_refused() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir_all(root.join("autre")).unwrap();
    std::fs::create_dir(&folder).unwrap();
    // `..` : Win32 le résoudrait en silence ; le contrôle le refuse sur chaque composant.
    let dotdot = format!(r"{}\autre\..\CircleTasks", root.display());
    assert_eq!(refused(check_sync_path(Path::new(&dotdot))), SyncCode::UnsafeFolder);
    let dot = format!(r"{}\.\CircleTasks", root.display());
    assert_eq!(refused(check_sync_path(Path::new(&dot))), SyncCode::UnsafeFolder);
    let verbatim_dotdot = format!(r"\\?\{}\autre\..\CircleTasks", root.display());
    assert_eq!(refused(check_sync_path(Path::new(&verbatim_dotdot))), SyncCode::UnsafeFolder);
    // Le préfixe verbatim seul est accepté et normalisé ; la barre finale aussi.
    let verbatim = PathBuf::from(format!(r"\\?\{}", folder.display()));
    assert_eq!(check_sync_path(&verbatim).unwrap().path, folder);
    assert_eq!(check_sync_path(Path::new(&format!(r"{}\", folder.display()))).unwrap().path, folder);
    assert_eq!(check_sync_path(Path::new(&format!(r"{}\\", folder.display()))).unwrap().path, folder, "barres répétées en fin");
}

#[test]
fn y01_6_trailing_dot_space_and_stream_names_do_not_alias_another_folder() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    // Win32 retire le point et l'espace finaux : le chemin final diffère du chemin demandé, donc refus (jamais accepté tel quel).
    for alias in ["CircleTasks.", "CircleTasks ", "CircleTasks. .", "CircleTasks..."] {
        let requested = format!(r"{}\{alias}", root.display());
        let code = refused(check_sync_path(Path::new(&requested)));
        assert!(matches!(code, SyncCode::UnsafeFolder | SyncCode::FolderUnreachable), "{alias:?} -> {code:?}");
    }
    for alias in [r"CircleTasks::$DATA", r"CircleTasks:flux", r"CircleTasks::$INDEX_ALLOCATION", "CircleTasks\\CON", "CircleTasks\\NUL", "CircleTasks?", "CircleTasks*", "CircleTasks<", "CircleTasks|"] {
        let requested = format!(r"{}\{alias}", root.display());
        let code = refused(check_sync_path(Path::new(&requested)));
        assert!(REFUSALS.contains(&code), "{alias:?} -> {code:?}");
    }
    // Aucun effet de bord : le dossier réel est resté vide.
    assert!(std::fs::read_dir(&folder).unwrap().next().is_none());
}

#[test]
fn y01_6_short_8_3_names_are_refused_when_the_volume_creates_them() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasksLongFolderName");
    std::fs::create_dir(&folder).unwrap();
    let probe = Command::new("cmd").raw_arg(format!(r#"/C "for %I in ("{}") do @echo %~sI""#, folder.display())).output().unwrap();
    let short = String::from_utf8_lossy(&probe.stdout).trim().to_owned();
    if short.is_empty() || short.eq_ignore_ascii_case(&folder.to_string_lossy()) {
        eprintln!("noms courts 8.3 désactivés sur ce volume : cas non exercé");
        return;
    }
    assert_eq!(refused(check_sync_path(Path::new(&short))), SyncCode::UnsafeFolder, "{short}");
}

#[test]
fn y01_6_subst_drive_is_refused_even_though_windows_calls_it_fixed() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let Some(letter) = ('M'..='Z').rev().find(|c| !Path::new(&format!("{c}:\\")).exists()) else {
        eprintln!("aucune lettre libre : cas non exercé");
        return;
    };
    let drive = format!("{letter}:");
    if !Command::new("subst").arg(&drive).arg(&folder).output().map(|o| o.status.success()).unwrap_or(false) {
        eprintln!("subst indisponible : cas non exercé");
        return;
    }
    struct Unsubst(String);
    impl Drop for Unsubst {
        fn drop(&mut self) {
            let _ = Command::new("subst").arg(&self.0).arg("/D").output();
        }
    }
    let _guard = Unsubst(drive.clone());
    let code = refused(check_sync_path(Path::new(&format!("{drive}\\"))));
    assert!(matches!(code, SyncCode::NotLocal | SyncCode::UnsafeFolder), "{code:?}");
    std::fs::create_dir(folder.join("sous")).unwrap();
    let code = refused(check_sync_path(Path::new(&format!("{drive}\\sous"))));
    assert!(matches!(code, SyncCode::NotLocal | SyncCode::UnsafeFolder), "{code:?}");
}

#[test]
fn y01_6_case_and_trailing_slash_do_not_change_the_folder_identity() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let a = check_sync_path(&folder).unwrap();
    let b = check_sync_path(Path::new(&folder.to_string_lossy().to_uppercase())).unwrap();
    let c = check_sync_path(Path::new(&format!(r"{}\", folder.display()))).unwrap();
    let d = check_sync_path(Path::new(&folder.to_string_lossy().to_lowercase())).unwrap();
    assert_eq!(a.folder_id(), b.folder_id());
    assert_eq!(a.folder_id(), c.folder_id());
    assert_eq!(a.folder_id(), d.folder_id());
    assert_eq!(a.folder_id().len(), 64);
    assert!(!a.folder_id().contains("circletasks") && !a.name().contains('\\'), "ni chemin ni libellé à backslash");
    assert_eq!(a.kind, FolderKind::Local);
    // Deux dossiers distincts : deux identifiants distincts.
    let other = root.join("Autre");
    std::fs::create_dir(&other).unwrap();
    assert_ne!(a.folder_id(), check_sync_path(&other).unwrap().folder_id());
}

/// Défaut QA-Y1-2 (faible) : la racine d'un lecteur est acceptée comme dossier de synchro et son libellé est vide (`file_name()` de
/// `C:\` est `None`), donc la ligne de Réglages n'affiche rien ; de plus `devices/` serait créé à la racine du disque. Attendu :
/// refuser une racine de lecteur (`unsafe-folder`) ou renvoyer un libellé non vide.
#[test]
fn y01_6_a_drive_root_is_not_a_usable_sync_folder() {
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    match check_sync_path(Path::new(&format!("{system_drive}\\"))) {
        Err(_) => {}
        Ok(folder) => assert!(!folder.name().is_empty(), "nom vide pour {}", folder.path.display()),
    }
}

#[test]
fn y01_13_names_with_windows_traps_never_reach_the_disk_through_stdfs() {
    let (_dir, root) = temp_root();
    let folder = root.join("CircleTasks");
    std::fs::create_dir(&folder).unwrap();
    let fs = StdFs::new(check_sync_path(&folder).unwrap().path);
    fs.create_dir(&["devices"]).unwrap();
    // Aucun nom ne sort du dossier : `..`, séparateurs, lecteur, flux, nom de périphérique ; refusés ou sans effet hors du dossier.
    let outside = root.join("dehors.txt");
    for name in ["..", "..\\dehors.txt", "../dehors.txt", "C:\\dehors.txt", "a:b", "x\\y", "dehors.txt::$DATA", "\\\\?\\C:\\x", ""] {
        let result = fs.append(&["devices", name], b"x", AppendMode::CreateNew);
        assert!(result.is_err(), "{name:?} accepté");
    }
    assert!(!outside.exists(), "aucun fichier hors du dossier");
    let leftovers: Vec<_> = std::fs::read_dir(folder.join("devices")).unwrap().collect();
    assert!(leftovers.is_empty(), "rien n'a été créé : {leftovers:?}");
    assert!(fs.read(&["devices", "..", "..", "x"], 10, false).is_err(), "lecture hors du dossier refusée");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-01 critères 4 et 7 : `folder.json` hostile ou périmé, revalidé à chaque chargement (disque réel, contrôle de production)
// ------------------------------------------------------------------------------------------------------------------------------

mod persisted {
    use std::path::Path;
    use std::sync::Arc;

    use circletasks_lib::sync::consent::ConsentGate;
    use circletasks_lib::sync::service::{SyncCore, SyncOptions, SystemBackend};
    use circletasks_lib::sync::SyncCode;
    use circletasks_lib::vault::MemoryVault;

    use super::temp_root;
    use crate::sync_support::{FakeUi, TestClock, DEV_A, DEV_B, NOW};

    fn core_on(base: &Path) -> SyncCore {
        let clock = TestClock::new(NOW);
        let consent = Arc::new(ConsentGate::new(base.join("sync"), FakeUi::new(), clock.clock()));
        SyncCore::new(SyncOptions::new(base.to_path_buf()), Arc::new(MemoryVault::default()), Arc::new(SystemBackend), consent, clock.clock())
    }

    fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
        match result {
            Ok(_) => panic!("erreur attendue"),
            Err(error) => error.code,
        }
    }

    fn write_record(base: &Path, path: &str, device: Option<&str>) {
        let dir = base.join("sync");
        std::fs::create_dir_all(&dir).unwrap();
        let record = serde_json::json!({ "v": 1, "path": path, "deviceId": device });
        std::fs::write(dir.join("folder.json"), serde_json::to_vec(&record).unwrap()).unwrap();
    }

    #[test]
    fn y01_7_a_tampered_folder_json_is_revalidated_and_never_written_through() {
        let (_dir, root) = temp_root();
        let base = tempfile::tempdir().unwrap();
        let outside = root.join("dehors");
        std::fs::create_dir(&outside).unwrap();
        let folder = root.join("CircleTasks");
        std::fs::create_dir(&folder).unwrap();
        let real = folder.to_string_lossy().into_owned();
        for (path, expected) in [
            (r"\\serveur\partage\CircleTasks".to_owned(), SyncCode::NotLocal),
            (r"\\?\UNC\serveur\partage\CircleTasks".to_owned(), SyncCode::NotLocal),
            (format!(r"{real}\..\dehors"), SyncCode::UnsafeFolder),
            (format!(r"{real}\absent"), SyncCode::FolderUnreachable),
            ("relatif".to_owned(), SyncCode::NotLocal),
            (String::new(), SyncCode::NotLocal),
            (format!(r"\\?\{real}"), SyncCode::UnsafeFolder),
        ] {
            write_record(base.path(), &path, Some(DEV_A));
            let core = core_on(base.path());
            assert_eq!(code(core.folder_info()), expected, "{path}");
            assert_eq!(code(core.scan(&[])), expected, "scan : {path}");
            assert_eq!(code(core.key_create()), expected, "clé : {path}");
        }
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        assert!(std::fs::read_dir(&folder).unwrap().next().is_none(), "aucune écriture dans les dossiers désignés");
    }

    #[test]
    fn y01_4_unreadable_or_foreign_folder_json_is_treated_as_not_configured_without_panic() {
        let (_dir, root) = temp_root();
        let base = tempfile::tempdir().unwrap();
        let folder = root.join("CircleTasks");
        std::fs::create_dir(&folder).unwrap();
        let dir = base.path().join("sync");
        std::fs::create_dir_all(&dir).unwrap();
        for content in [&b""[..], b"{", b"null", b"[]", b"\xff\xfe\x00", b"{\"v\":1}", b"{\"v\":1,\"path\":1,\"deviceId\":null}", b"{\"v\":1,\"path\":\"C:\\x\",\"deviceId\":null,\"extra\":1}"] {
            std::fs::write(dir.join("folder.json"), content).unwrap();
            let info = core_on(base.path()).folder_info().unwrap();
            assert!(!info.configured, "{:?}", String::from_utf8_lossy(content));
        }
        // Un dossier valide persisté puis relu par une nouvelle instance : même libellé, sans nouvelle boîte (critère 4).
        write_record(base.path(), &folder.to_string_lossy(), Some(DEV_B));
        let info = core_on(base.path()).folder_info().unwrap();
        assert_eq!((info.configured, info.name.as_deref()), (true, Some("CircleTasks")));
    }

    #[test]
    fn y01_7_a_linked_folder_replaced_by_a_junction_is_refused_at_the_next_load() {
        let (_dir, root) = temp_root();
        let base = tempfile::tempdir().unwrap();
        let folder = root.join("CircleTasks");
        std::fs::create_dir(&folder).unwrap();
        let first = core_on(base.path());
        first.choose_folder(&folder).unwrap();
        first.key_create().unwrap();
        drop(first);
        std::fs::remove_dir(&folder).unwrap();
        let elsewhere = root.join("ailleurs");
        std::fs::create_dir(&elsewhere).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&folder).arg(&elsewhere).output().map(|o| o.status.success()).unwrap_or(false);
        assert!(made, "mklink /J");
        let second = core_on(base.path());
        assert_eq!(code(second.folder_info()), SyncCode::UnsafeFolder);
        assert_eq!(code(second.scan(&[])), SyncCode::UnsafeFolder);
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none(), "aucune écriture à travers la jonction");
    }

    /// Défaut QA-Y1-3 (faible) : renommer le dossier lié en ne changeant que la casse (`CircleTasks` -> `circletasks`) fait comparer le
    /// chemin de `folder.json` au chemin final en respectant la casse : `unsafe-folder` permanent jusqu'à « Oublier le dossier ».
    /// Attendu : comparaison insensible à la casse comme dans `check_sync_path`.
    #[test]
    fn y01_7_a_case_only_rename_of_the_linked_folder_is_still_the_same_folder() {
        let (_dir, root) = temp_root();
        let base = tempfile::tempdir().unwrap();
        let folder = root.join("CircleTasks");
        std::fs::create_dir(&folder).unwrap();
        let first = core_on(base.path());
        first.choose_folder(&folder).unwrap();
        drop(first);
        std::fs::rename(&folder, root.join("circletasks")).unwrap();
        assert!(core_on(base.path()).folder_info().is_ok());
    }
}

/// Y-01 critère 2 : la boîte de choix de dossier est ouverte par Rust ; aucune capability n'accorde de permission `dialog:` (ni `fs:`).
#[test]
fn y01_2_no_capability_grants_a_dialog_or_fs_permission_to_any_window() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut seen = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for permission in value["permissions"].as_array().unwrap() {
            let id = permission.as_str().or_else(|| permission["identifier"].as_str()).unwrap_or_default();
            assert!(!id.starts_with("dialog:") && !id.starts_with("fs:"), "{} : {id}", path.display());
        }
        seen += 1;
    }
    assert!(seen >= 5, "capabilities lues : {seen}");
}

/// Y-01 critère 6 : seules les balises `IO_REPARSE_TAG_CLOUD` à `IO_REPARSE_TAG_CLOUD_F` sont acceptées (placeholders iCloud) ; toute
/// autre balise (jonction, lien symbolique, WCI, OneDrive hérité, balise inconnue) est refusée.
#[test]
fn y01_6_only_cloud_reparse_tags_are_accepted() {
    use circletasks_lib::sync::folder::is_accepted_reparse;
    const REPARSE: u32 = 0x400;
    const DIRECTORY: u32 = 0x10;
    // Sans attribut de point d'analyse : toujours accepté, quelle que soit la valeur de balise lue.
    assert!(is_accepted_reparse(DIRECTORY, 0));
    assert!(is_accepted_reparse(DIRECTORY, 0xA000_0003));
    // CLOUD (0x9000001A) et CLOUD_1 à CLOUD_F (0x9000101A, ..., 0x9000F01A).
    for n in 0u32..=15 {
        assert!(is_accepted_reparse(DIRECTORY | REPARSE, 0x9000_001A | (n << 12)), "CLOUD_{n:X}");
    }
    for refused in [
        0xA000_0003u32, // IO_REPARSE_TAG_MOUNT_POINT (jonction)
        0xA000_000C,    // IO_REPARSE_TAG_SYMLINK
        0x8000_0018,    // IO_REPARSE_TAG_WCI
        0x9000_001B,    // voisine de CLOUD
        0x9000_0019,
        0x9001_001A, // bits hauts différents
        0x9100_001A,
        0xA000_001A,
        0x0000_001A,
        0x8000_001A,
        0x9000_001A | 0x0000_0F00 | 0x0000_0001, // bit bas modifié
        0xC000_0003,
        0,
        u32::MAX,
    ] {
        assert!(!is_accepted_reparse(DIRECTORY | REPARSE, refused), "{refused:#010X}");
    }
}
