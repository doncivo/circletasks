//! Fichiers à la demande d'iCloud pour Windows (API Cloud Files, ADR 0011 section 6.2 ; Y-01 critère 14).
//!
//! - `expose_placeholders` : `RtlSetProcessPlaceholderCompatibilityMode(PHCM_EXPOSE_PLACEHOLDERS)` au premier usage, pour que les
//!   placeholders apparaissent toujours comme points d'analyse cloud, quel que soit le réglage par défaut du processus.
//! - `hydrate` : `CfHydratePlaceholder` sur le handle déjà contrôlé ; repli : lecture ordinaire (qui déclenche le rappel des données).
//! - `pin` : `CfSetPinState(CF_PIN_STATE_PINNED)` fichier par fichier, jamais récursif (D3 de Y-01).
//! - `sync_root_provider` : nom du fournisseur de la racine de synchronisation qui contient un dossier (`CfGetSyncRootInfoByPath`).
//! - Erreurs : fournisseur arrêté → `ProviderStopped` (« Ouvrez iCloud pour Windows ») ; délai ou réseau → `CloudPending` ; autres
//!   erreurs cloud → `CloudError`. Aucune n'est fatale.

use std::path::Path;
use std::sync::Once;

use windows::core::PCWSTR;
use windows::Wdk::Storage::FileSystem::RtlSetProcessPlaceholderCompatibilityMode;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::CloudFilters::{
    CfGetSyncRootInfoByPath, CfHydratePlaceholder, CfSetPinState, CF_HYDRATE_FLAG_NONE, CF_PIN_STATE_PINNED, CF_SET_PIN_FLAG_NONE,
    CF_SYNC_ROOT_INFO_PROVIDER, CF_SYNC_ROOT_PROVIDER_INFO,
};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN};

use super::files::FsError;

/// `PHCM_EXPOSE_PLACEHOLDERS` (ntifs.h).
pub const PHCM_EXPOSE_PLACEHOLDERS: i8 = 2;

const ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING: u32 = 362;
const ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE: u32 = 388;
const ERROR_CLOUD_FILE_REQUEST_TIMEOUT: u32 = 426;
const ERROR_CLOUD_FILE_REQUEST_CANCELED: u32 = 398;
const ERROR_CLOUD_FILE_REQUEST_ABORTED: u32 = 393;
const ERROR_CLOUD_FILE_US_MESSAGE_TIMEOUT: u32 = 475;
const ERROR_CLOUD_FILE_PROVIDER_TERMINATED: u32 = 404;
const ERROR_NETWORK_UNREACHABLE: u32 = 1231;
const ERROR_SEM_TIMEOUT: u32 = 121;

static EXPOSE: Once = Once::new();

/// Fixe le mode de compatibilité des placeholders du processus (une seule fois).
pub fn expose_placeholders() {
    EXPOSE.call_once(|| {
        // SAFETY: appel sans pointeur ; renvoie l'ancien mode ou -1 (journalisé seulement).
        let previous = unsafe { RtlSetProcessPlaceholderCompatibilityMode(PHCM_EXPOSE_PLACEHOLDERS) };
        if previous < 0 {
            super::log::event("placeholder-mode-failed", &previous.to_string());
        }
    });
}

/// Un attribut indique-t-il un fichier dont les données ne sont pas sur le disque ?
pub fn is_cloud_attributes(attributes: u32) -> bool {
    attributes & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0 | FILE_ATTRIBUTE_RECALL_ON_OPEN.0 | FILE_ATTRIBUTE_OFFLINE.0) != 0
}

/// Code d'erreur Win32 (dans un HRESULT `0x8007xxxx`, un NTSTATUS cloud `0xC000CFxx` ou brut) vers l'erreur de fichier.
pub fn win32_error(code: u32) -> Option<FsError> {
    match code {
        ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING | ERROR_CLOUD_FILE_PROVIDER_TERMINATED => Some(FsError::ProviderStopped),
        ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE
        | ERROR_CLOUD_FILE_REQUEST_TIMEOUT
        | ERROR_CLOUD_FILE_REQUEST_CANCELED
        | ERROR_CLOUD_FILE_REQUEST_ABORTED
        | ERROR_CLOUD_FILE_US_MESSAGE_TIMEOUT
        | ERROR_NETWORK_UNREACHABLE
        | ERROR_SEM_TIMEOUT => Some(FsError::CloudPending),
        358..=475 => Some(FsError::CloudError),
        _ => None,
    }
}

/// NTSTATUS cloud (`STATUS_CLOUD_FILE_*`, `0xC000CFxx`) vers l'erreur de fichier.
pub fn status_error(status: i32) -> Option<FsError> {
    let status = status as u32;
    match status {
        0xC000_CF01 => Some(FsError::ProviderStopped),
        0xC000_CF00..=0xC000_CFFF => Some(FsError::CloudError),
        _ => None,
    }
}

fn hresult_error(hresult: i32) -> FsError {
    let value = hresult as u32;
    if value & 0xFFFF_0000 == 0x8007_0000 {
        return win32_error(value & 0xFFFF).unwrap_or(FsError::Io);
    }
    status_error(hresult).unwrap_or(FsError::CloudError)
}

/// Erreur d'entrée-sortie (lecture qui déclenche le rappel, écriture) vers l'erreur de fichier.
pub fn io_error(error: &std::io::Error) -> FsError {
    match error.raw_os_error() {
        Some(code) => win32_error(code as u32).unwrap_or(FsError::Io),
        None => FsError::Io,
    }
}

/// Hydrate le fichier entier sur le handle contrôlé. Un échec qui n'est pas une erreur cloud laisse la lecture ordinaire tenter le
/// rappel (repli de la section 6.2).
pub fn hydrate(handle: HANDLE) -> Result<(), FsError> {
    // SAFETY: handle de fichier valide pendant l'appel (possédé par l'appelant).
    match unsafe { CfHydratePlaceholder(handle, 0, -1, CF_HYDRATE_FLAG_NONE, None) } {
        Ok(()) => Ok(()),
        Err(error) => match hresult_error(error.code().0) {
            FsError::Io => {
                super::log::event("hydrate-fallback", "lecture");
                Ok(())
            }
            other => Err(other),
        },
    }
}

/// Épingle un fichier (« Toujours conserver sur cet appareil »).
pub fn pin(handle: HANDLE) -> Result<(), FsError> {
    // SAFETY: handle de fichier valide pendant l'appel.
    unsafe { CfSetPinState(handle, CF_PIN_STATE_PINNED, CF_SET_PIN_FLAG_NONE, None) }.map_err(|e| hresult_error(e.code().0))
}

/// Nom du fournisseur de la racine de synchronisation qui contient `path`, ou `None` si le dossier n'est sous aucune racine.
pub fn sync_root_provider(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let mut info = Box::<CF_SYNC_ROOT_PROVIDER_INFO>::default();
    // SAFETY: chaîne terminée par zéro ; tampon de la taille de la structure.
    let result = unsafe {
        CfGetSyncRootInfoByPath(
            PCWSTR(wide.as_ptr()),
            CF_SYNC_ROOT_INFO_PROVIDER,
            (&mut *info as *mut CF_SYNC_ROOT_PROVIDER_INFO).cast(),
            std::mem::size_of::<CF_SYNC_ROOT_PROVIDER_INFO>() as u32,
            None,
        )
    };
    result.ok()?;
    let end = info.ProviderName.iter().position(|&c| c == 0).unwrap_or(info.ProviderName.len());
    Some(String::from_utf16_lossy(&info.ProviderName[..end]))
}

/// Le fournisseur est-il iCloud ?
pub fn is_icloud_provider(name: &str) -> bool {
    name.to_lowercase().contains("icloud")
}
