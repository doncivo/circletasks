//! Dossier de synchronisation (ADR 0011 section 6.1, audit H4 ; Y-01 critères 2 à 9).
//!
//! - `check_sync_path` (Windows) : lettre de lecteur (`export::is_local_disk_path`, inchangé) et `DRIVE_FIXED` ; chaque composant
//!   ouvert sans suivre de point d'analyse, seules les balises `IO_REPARSE_TAG_CLOUD*` acceptées ; chemin final résolu par
//!   `GetFinalPathNameByHandleW`, préfixe `\\?\` retiré, `\\?\UNC\` refusé, égal au chemin demandé (casse ignorée). C'est ce chemin
//!   final normalisé qui est enregistré. `backup::is_plain_dir` et `export::is_local_disk_path` ne changent pas (la synchro a sa
//!   propre fonction, plus stricte).
//! - `folder.json` (dossier de configuration) garde le chemin et l'appareil lié : la WebView ne reçoit qu'un libellé.
//! - Fichiers de configuration écrits par `.tmp` + renommage (`write_config_file`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::crypto::sha256_hex;
use super::{fail, SyncCode, SyncResult};

/// Nom du sous-dossier de configuration de la synchro.
pub const CONFIG_SUBDIR: &str = "sync";
pub const FOLDER_FILE: &str = "folder.json";
/// Dossier proposé : `%USERPROFILE%\iCloudDrive\CircleTasks`.
pub const ICLOUD_DRIVE_DIR: &str = "iCloudDrive";
pub const DEFAULT_FOLDER_NAME: &str = "CircleTasks";

/// Nature du dossier choisi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderKind {
    /// Sous une racine de synchronisation iCloud.
    Icloud,
    /// Sous aucune racine de synchronisation (avertissement : les appareils ne le partageront pas).
    Local,
    /// Sous la racine d'un autre fournisseur, ou indéterminé.
    Unknown,
}

/// Dossier contrôlé : chemin final normalisé, nature, épinglage par l'utilisateur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedFolder {
    pub path: PathBuf,
    pub kind: FolderKind,
    pub pinned: bool,
}

impl CheckedFolder {
    /// `folderId` = SHA-256 du chemin final normalisé (en minuscules : Windows ignore la casse).
    pub fn folder_id(&self) -> String {
        sha256_hex(self.path.to_string_lossy().to_lowercase().as_bytes())
    }

    /// Nom du dossier, jamais un chemin. Le libellé affiché (« iCloud Drive / CircleTasks ») est composé par l'interface à partir du
    /// nom et de la nature (textes dans `src/i18n`, revue 13). Jamais vide : une racine de lecteur est refusée par `check_sync_path`.
    pub fn name(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

/// `folder.json` : chemin final et appareil lié (figé jusqu'à l'oubli du dossier).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderRecord {
    pub v: u32,
    pub path: String,
    pub device_id: Option<String>,
    /// iPhone (ADR 0011 §22 point 5) : signet de sécurité du dossier (base64), jamais transmis à la WebView ; absent sur PC (un
    /// `folder.json` du PC est inchangé et toujours lu).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

pub fn config_dir(base: &Path) -> PathBuf {
    base.join(CONFIG_SUBDIR)
}

/// Écrit un fichier de configuration par `.tmp` + renommage (remplacement atomique), dossier créé au besoin.
pub fn write_config_file(path: &Path, bytes: &[u8]) -> SyncResult<()> {
    use std::io::Write;
    let parent = path.parent().ok_or(super::SyncError::new(SyncCode::Io))?;
    std::fs::create_dir_all(parent).map_err(|_| super::SyncError::new(SyncCode::Io))?;
    let mut temp = path.as_os_str().to_owned();
    temp.push(super::names::TEMP_SUFFIX);
    let temp = PathBuf::from(temp);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    result.map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        super::SyncError::new(SyncCode::Io)
    })
}

/// Lit un fichier de configuration JSON : `Ok(None)` s'il manque, `Err` s'il est illisible (le motif n'a pas d'intérêt :
/// l'appelant applique sa règle, par exemple « bloqué 10 minutes » pour `consent.json`).
#[allow(clippy::result_unit_err)]
pub fn read_config_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, ()> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

pub fn remove_config_file(path: &Path) -> SyncResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => fail(SyncCode::Io),
    }
}

/// Dossier à lier après la boîte de choix (audit S10) : le dossier choisi ; si c'est `iCloud Drive` lui-même, son sous-dossier
/// `CircleTasks`, à créer seulement maintenant que l'utilisateur a validé. Rend (dossier, à créer).
pub fn chosen_target(chosen: &Path, icloud_drive: Option<&Path>) -> (PathBuf, bool) {
    let is_drive = icloud_drive.is_some_and(|drive| drive.to_string_lossy().to_lowercase().trim_end_matches('\\') == chosen.to_string_lossy().to_lowercase().trim_end_matches('\\'));
    if is_drive {
        (chosen.join(DEFAULT_FOLDER_NAME), true)
    } else {
        (chosen.to_path_buf(), false)
    }
}

/// Retire le préfixe verbatim `\\?\` suivi d'une lettre de lecteur ; refuse `\\?\UNC\`, `\\.\` et tout autre préfixe ; sans
/// préfixe, exige une lettre de lecteur. Retire la barre finale (sauf racine de lecteur).
pub fn normalize_final_path(path: &str) -> Option<String> {
    let rest = match path.strip_prefix(r"\\?\") {
        Some(rest) => rest,
        None if path.starts_with(r"\\") => return None,
        None => path,
    };
    let b = rest.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return None;
    }
    let trimmed = if rest.len() > 3 { rest.trim_end_matches('\\') } else { rest };
    Some(trimmed.to_owned())
}

/// Balise d'analyse acceptée : aucune, ou `IO_REPARSE_TAG_CLOUD` à `IO_REPARSE_TAG_CLOUD_F` (`tag & 0xFFFF0FFF == 0x9000001A`).
pub fn is_accepted_reparse(attributes: u32, tag: u32) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
    attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 || tag & 0xFFFF_0FFF == IO_REPARSE_TAG_CLOUD
}

#[cfg(windows)]
pub use win::{check_sync_path, final_path_of};

#[cfg(windows)]
mod win {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::path::{Path, PathBuf};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, FileAttributeTagInfo, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_PINNED, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GETFINALPATHNAMEBYHANDLE_FLAGS, OPEN_EXISTING, VOLUME_NAME_DOS,
    };

    use super::{is_accepted_reparse, normalize_final_path, CheckedFolder, FolderKind};
    use crate::sync::{cloud_windows, fail, SyncCode, SyncResult};

    /// `DRIVE_FIXED` (fileapi.h).
    const DRIVE_FIXED: u32 = 3;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Chemin final (`FILE_NAME_NORMALIZED | VOLUME_NAME_DOS`) d'un handle, non normalisé.
    pub fn final_path_of(handle: HANDLE) -> Option<String> {
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: tampon possédé, longueur passée par la tranche.
            let len = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0)) } as usize;
            if len == 0 {
                return None;
            }
            if len < buffer.len() {
                return String::from_utf16(&buffer[..len]).ok();
            }
            if len > 32_768 {
                return None;
            }
            buffer = vec![0u16; len + 1];
        }
    }

    fn open_component(path: &str) -> SyncResult<OwnedHandle> {
        let name = wide(path);
        // SAFETY: chaîne terminée par zéro ; le point d'analyse n'est pas suivi.
        let handle = unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
        };
        match handle {
            // SAFETY: handle valide rendu par CreateFileW.
            Ok(handle) => Ok(unsafe { OwnedHandle::from_raw_handle(handle.0 as RawHandle) }),
            Err(_) => fail(SyncCode::FolderUnreachable),
        }
    }

    fn tag_of(handle: &OwnedHandle) -> SyncResult<(u32, u32)> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
        // SAFETY: tampon de la taille de la structure.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(handle.as_raw_handle()),
                FileAttributeTagInfo,
                (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        }
        .map_err(|_| crate::sync::SyncError::new(SyncCode::UnsafeFolder))?;
        Ok((info.FileAttributes, info.ReparseTag))
    }

    /// Étapes 1 et 2 de la section 6.1 sur un chemin à lettre de lecteur ; rend le handle du dernier composant et ses attributs.
    fn check_components(path: &str) -> SyncResult<(OwnedHandle, u32)> {
        if !crate::export::is_local_disk_path(Path::new(path)) {
            return fail(SyncCode::NotLocal);
        }
        let root = &path[..3];
        // SAFETY: chaîne terminée par zéro.
        if unsafe { GetDriveTypeW(PCWSTR(wide(root).as_ptr())) } != DRIVE_FIXED {
            return fail(SyncCode::NotLocal);
        }
        let mut current = root.to_owned();
        let mut last = open_component(&current)?;
        let mut attributes = tag_of(&last)?.0;
        for part in path[3..].split('\\').filter(|p| !p.is_empty()) {
            if part == "." || part == ".." {
                return fail(SyncCode::UnsafeFolder);
            }
            if !current.ends_with('\\') {
                current.push('\\');
            }
            current.push_str(part);
            last = open_component(&current)?;
            let (attrs, tag) = tag_of(&last)?;
            if !is_accepted_reparse(attrs, tag) {
                crate::sync::log::event("folder-refused", "reparse");
                return fail(SyncCode::UnsafeFolder);
            }
            attributes = attrs;
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return fail(SyncCode::UnsafeFolder);
        }
        Ok((last, attributes))
    }

    /// Contrôle complet du dossier choisi (section 6.1, étapes 1 à 3). Erreurs : `not-local`, `unsafe-folder`, `folder-unreachable`.
    pub fn check_sync_path(path: &Path) -> SyncResult<CheckedFolder> {
        cloud_windows::expose_placeholders();
        let requested = normalize_final_path(&path.to_string_lossy()).ok_or(crate::sync::SyncError::new(SyncCode::NotLocal))?;
        // Racine de lecteur refusée (QA-Y1-2) : pas de nom à afficher, et `devices/` serait créé à la racine du disque.
        if requested.len() <= 3 {
            return fail(SyncCode::UnsafeFolder);
        }
        let (handle, _) = check_components(&requested)?;
        let Some(final_path) = final_path_of(HANDLE(handle.as_raw_handle())) else { return fail(SyncCode::UnsafeFolder) };
        let Some(final_path) = normalize_final_path(&final_path) else {
            crate::sync::log::event("folder-refused", "final-path");
            return fail(SyncCode::UnsafeFolder);
        };
        if final_path.to_lowercase() != requested.to_lowercase() {
            crate::sync::log::event("folder-refused", "final-path-differs");
            return fail(SyncCode::UnsafeFolder);
        }
        // Chemin final recontrôlé (étapes 1 et 2) : c'est lui qui est enregistré.
        let (handle, attributes) = check_components(&final_path)?;
        drop(handle);
        let path = PathBuf::from(&final_path);
        let kind = match cloud_windows::sync_root_provider(&path) {
            Some(provider) if cloud_windows::is_icloud_provider(&provider) => FolderKind::Icloud,
            Some(_) => FolderKind::Unknown,
            None => FolderKind::Local,
        };
        Ok(CheckedFolder { path, kind, pinned: attributes & FILE_ATTRIBUTE_PINNED.0 != 0 })
    }
}

/// Repli des cibles sans contrôle Windows (aucune n'est livrée par ce lot : l'iPhone passe par son signet, ordre 5).
#[cfg(not(windows))]
pub fn check_sync_path(path: &Path) -> SyncResult<CheckedFolder> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| super::SyncError::new(SyncCode::FolderUnreachable))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return fail(SyncCode::UnsafeFolder);
    }
    let path = std::fs::canonicalize(path).map_err(|_| super::SyncError::new(SyncCode::FolderUnreachable))?;
    if path.parent().is_none() {
        return fail(SyncCode::UnsafeFolder);
    }
    Ok(CheckedFolder { path, kind: FolderKind::Unknown, pinned: false })
}
