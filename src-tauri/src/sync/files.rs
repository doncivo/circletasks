//! Accès aux fichiers du dossier de synchronisation (ADR 0011, sections 1.3, 1.6, 6.1 et 6.2 ; Y-01 critères 11 à 14).
//!
//! Le trait `SyncFs` est la seule porte vers le dossier : chemins **relatifs** à la racine contrôlée, composants déjà validés par
//! `names.rs`. Implémentations : `StdFs` (PC : handles Windows, `cloud_windows` ; autre cible : `std::fs`, en attendant `BookmarkFs`
//! iOS de l'ordre 5) et, dans les tests, un `SyncFs` en mémoire qui simule balises cloud et placeholders.
//!
//! Garanties de `StdFs` sur Windows :
//! - la racine est rouverte à chaque opération (`FILE_FLAG_OPEN_REPARSE_POINT`), sa balise et son chemin final recontrôlés : un dossier
//!   devenu jonction, déplacé ou démonté donne `Unsafe` ou `Unreachable` sans aucune écriture ;
//! - chaque sous-dossier et chaque fichier est ouvert **par rapport au handle de son dossier** (`NtCreateFile`, `RootDirectory`), sans
//!   suivre de point d'analyse ; seules les balises `IO_REPARSE_TAG_CLOUD*` sont acceptées ; un fichier à plusieurs liens physiques
//!   est refusé en écriture ; le handle créé est recontrôlé (balise, chemin final) avant la première écriture ;
//! - toute I/O se fait sur ce handle ; la taille annoncée est comparée à la borne **avant** lecture ou hydratation ;
//! - un fichier « dans le nuage » n'est hydraté que si l'appelant le demande (fichier annoncé par une tête authentifiée ou
//!   `state.ctx`), sur un fil dédié, 60 s par fichier et 3 minutes par cycle (le cycle commence à `revalidate`).

use std::time::Duration;

use super::SyncCode;

/// Disponibilité locale d'un fichier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Local,
    /// Placeholder : `RECALL_ON_DATA_ACCESS`, `RECALL_ON_OPEN` ou `OFFLINE`.
    Cloud,
    /// Point d'analyse non cloud, ou état illisible.
    Error,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Local => "local",
            Availability::Cloud => "cloud",
            Availability::Error => "error",
        }
    }
}

/// Entrée d'un dossier listé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    /// Taille annoncée (logique, même pour un placeholder).
    pub size: u64,
    pub availability: Availability,
}

/// Résultat d'une liste : au plus `max` entrées, `truncated` si le dossier en contenait davantage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
}

/// Erreur d'accès (sans chemin ni détail).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
    NotFound,
    /// Point d'analyse refusé, chemin final différent, liens multiples.
    Unsafe,
    /// Racine introuvable (déplacée, démontée).
    Unreachable,
    /// Fichier dans le nuage non hydraté (pas demandé, délai, réseau).
    CloudPending,
    /// iCloud pour Windows arrêté.
    ProviderStopped,
    CloudError,
    TooLarge,
    /// Fichier déjà présent (création exclusive).
    Exists,
    Io,
}

impl FsError {
    pub fn code(self) -> SyncCode {
        match self {
            FsError::NotFound | FsError::Io | FsError::Exists => SyncCode::Io,
            FsError::Unsafe => SyncCode::UnsafeFolder,
            FsError::Unreachable => SyncCode::FolderUnreachable,
            FsError::CloudPending => SyncCode::CloudPending,
            FsError::ProviderStopped => SyncCode::CloudProviderStopped,
            FsError::CloudError => SyncCode::CloudError,
            FsError::TooLarge => SyncCode::TooLarge,
        }
    }
}

/// Mode d'ouverture pour un ajout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendMode {
    /// Le fichier ne doit pas exister (nouveau segment).
    CreateNew,
    /// Le fichier doit exister.
    Existing,
}

/// Porte vers le dossier lié. `dir` / `file` : composants relatifs à la racine, déjà validés.
pub trait SyncFs: Send + Sync {
    /// Recontrôle la racine seulement (`sync_folder_info`) : le budget d'hydratation n'est pas touché (revue B4).
    fn check_root(&self) -> Result<(), FsError>;
    /// Recontrôle la racine et ouvre un nouveau cycle d'hydratation de 3 minutes (début de `sync_scan`, création et import de clé).
    fn start_cycle(&self) -> Result<(), FsError>;
    /// Premiers octets d'un fichier présent sur le disque (`max` au plus, en-tête) : jamais d'hydratation, `CloudPending` pour un
    /// fichier dans le nuage. Sert aux pré-filtres sur l'en-tête en clair (audit A3, A4).
    fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError>;
    /// Liste un dossier (`NotFound` s'il n'existe pas).
    fn list(&self, dir: &[&str], max: usize) -> Result<Listing, FsError>;
    /// Lit un fichier entier, `limit` octets au plus (taille annoncée contrôlée avant toute lecture ou hydratation). Un placeholder
    /// n'est hydraté que si `hydrate` ; sinon `CloudPending`.
    fn read(&self, file: &[&str], limit: u64, hydrate: bool) -> Result<Vec<u8>, FsError>;
    /// Ajoute à la fin, puis `sync_all`.
    fn append(&self, file: &[&str], bytes: &[u8], mode: AppendMode) -> Result<(), FsError>;
    /// Écrit `<nom>.tmp` puis le renomme en `<nom>` (remplacement atomique).
    fn write_atomic(&self, file: &[&str], bytes: &[u8]) -> Result<(), FsError>;
    /// Renomme un fichier dans son dossier (remplacement).
    fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError>;
    /// Crée le dossier et ses parents (idempotent).
    fn create_dir(&self, dir: &[&str]) -> Result<(), FsError>;
    /// Supprime un fichier ; `false` s'il n'existait pas.
    fn remove_file(&self, file: &[&str]) -> Result<bool, FsError>;
    /// Supprime un dossier vide (sans effet s'il ne l'est pas : un fichier étranger n'est jamais supprimé).
    fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError>;
    /// Épingle un fichier (« Toujours conserver sur cet appareil ») ; un échec est seulement journalisé par l'appelant.
    fn pin(&self, file: &[&str]) -> Result<(), FsError>;
}

/// Délai d'hydratation par fichier.
pub const HYDRATE_FILE_TIMEOUT: Duration = Duration::from_millis(super::limits::HYDRATE_FILE_TIMEOUT_MS);
/// Budget d'hydratation par cycle.
pub const HYDRATE_CYCLE_BUDGET: Duration = Duration::from_millis(super::limits::HYDRATE_CYCLE_TIMEOUT_MS);

pub use imp::StdFs;

/// Composant de chemin sûr (défense en profondeur, revue 19) : non vide, 255 caractères au plus, ni `.` ni `..`, aucun séparateur, ni
/// `:` (flux NTFS, lecteur), ni caractère interdit par Windows ou de contrôle, ni point ou espace final (Windows les retire), ni nom de
/// périphérique réservé (`CON`, `NUL`, `COM1`, `LPT1`…, avec ou sans extension).
pub fn is_safe_component(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > 255 || name == "." || name == ".." || name.ends_with(['.', ' ']) {
        return false;
    }
    if name.chars().any(|c| c < ' ' || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.get(3..), Some("¹" | "²" | "³")));
    !reserved
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-10 : suppression des fichiers d'un appareil oublié (ADR 0011 sections 1.1 et 14.2, avenant à la règle d'écrivain unique)
// ------------------------------------------------------------------------------------------------------------------------------
//
// Seule région du code qui supprime dans le dossier d'un **autre** appareil ; seul appelant : `SyncCore::forgotten_delete`
// (`sync_forgotten_delete`), après les conditions de `forget::forgotten_delete_check`. Jamais d'écriture, de renommage ni de création ;
// jamais d'hydratation (liste et suppression seulement) ; seuls les noms stricts de la section 1.1 sont supprimés : segments et
// instantanés des dossiers d'époque, dossiers d'époque vidés, `state.next.ctx`, puis `state.ctx` **en dernier**, enfin le dossier
// d'appareil s'il est vide. Un nom étranger (`.tmp`, copie de conflit, fichier déposé) n'est ni lu ni supprimé : le dossier reste.

/// Résultat d'une passe de suppression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForgottenDeletion {
    /// Entrées supprimées (fichiers et dossiers d'époque).
    pub deleted: u64,
    /// Plus aucun nom strict dans le dossier (des noms étrangers peuvent rester).
    pub complete: bool,
    /// Noms étrangers laissés en place.
    pub strays: u64,
}

/// Supprime au plus `max_entries` entrées de noms stricts de `devices/<dev>/` (`dev` déjà validé par `names.rs`, différent de
/// l'appareil local : contrôlé par l'appelant). Dossier absent ou fichier déjà supprimé : sans erreur (idempotent).
pub fn delete_forgotten_device_files(fs: &dyn SyncFs, dev: &str, max_entries: usize) -> Result<ForgottenDeletion, FsError> {
    use super::names::{parse_file_name, EpochId, SyncFileName, DEVICES_DIR, STATE_FILE, STATE_NEXT_FILE};
    use super::limits::MAX_SCAN_ENTRIES_PER_FOLDER;

    let mut out = ForgottenDeletion { deleted: 0, complete: false, strays: 0 };
    if !super::names::is_uuid_v4(dev) || !is_safe_component(dev) {
        return Err(FsError::Unsafe);
    }
    let top = match fs.list(&[DEVICES_DIR, dev], MAX_SCAN_ENTRIES_PER_FOLDER) {
        Ok(listing) => listing,
        Err(FsError::NotFound) => {
            out.complete = true;
            return Ok(out);
        }
        Err(error) => return Err(error),
    };
    let mut cut = top.truncated;
    let mut has_state = false;
    let mut has_next = false;
    for entry in &top.entries {
        if entry.is_dir && entry.availability != Availability::Error && EpochId::parse(&entry.name).is_some() {
            let epoch = entry.name.as_str();
            let files = match fs.list(&[DEVICES_DIR, dev, epoch], MAX_SCAN_ENTRIES_PER_FOLDER) {
                Ok(listing) => listing,
                Err(FsError::NotFound) => continue,
                Err(error) => return Err(error),
            };
            cut |= files.truncated;
            let mut left = 0u64;
            for file in &files.entries {
                if file.is_dir || !matches!(parse_file_name(&file.name), Some(SyncFileName::Segment(_) | SyncFileName::Snapshot(_))) {
                    out.strays += 1;
                    left += 1;
                    continue;
                }
                if out.deleted as usize >= max_entries {
                    return Ok(out);
                }
                if fs.remove_file(&[DEVICES_DIR, dev, epoch, &file.name])? {
                    out.deleted += 1;
                }
            }
            if left == 0 && !files.truncated {
                if out.deleted as usize >= max_entries {
                    return Ok(out);
                }
                fs.remove_empty_dir(&[DEVICES_DIR, dev, epoch])?;
                out.deleted += 1;
            }
        } else if !entry.is_dir && entry.name == STATE_FILE {
            has_state = true;
        } else if !entry.is_dir && entry.name == STATE_NEXT_FILE {
            has_next = true;
        } else {
            out.strays += 1;
        }
    }
    if cut {
        // Une liste coupée : des noms stricts peuvent rester ; `state.ctx` est gardé pour la passe suivante.
        return Ok(out);
    }
    for (present, name) in [(has_next, STATE_NEXT_FILE), (has_state, STATE_FILE)] {
        if !present {
            continue;
        }
        if out.deleted as usize >= max_entries {
            return Ok(out);
        }
        if fs.remove_file(&[DEVICES_DIR, dev, name])? {
            out.deleted += 1;
        }
    }
    fs.remove_empty_dir(&[DEVICES_DIR, dev])?;
    out.complete = true;
    Ok(out)
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Instant;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows::Wdk::Storage::FileSystem::{
        NtCreateFile, NtSetInformationFile, FileRenameInformation, FileRenameInformationEx, FILE_CREATE, FILE_RENAME_INFORMATION, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT, NTCREATEFILE_CREATE_DISPOSITION, NTCREATEFILE_CREATE_OPTIONS,
    };
    use windows::Win32::Foundation::{HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, UNICODE_STRING};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, GetFileInformationByHandleEx, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ACCESS_RIGHTS, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FULL_DIR_INFO, FILE_GENERIC_READ, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FileAttributeTagInfo, FileDispositionInfo, FileDispositionInfoEx,
        FileFullDirectoryInfo, FileFullDirectoryRestartInfo, OPEN_EXISTING, SYNCHRONIZE,
    };
    use windows::Win32::System::IO::IO_STATUS_BLOCK;

    use super::super::cloud_windows;
    use super::super::folder::{final_path_of, is_accepted_reparse, normalize_final_path};
    use super::{AppendMode, Availability, FsEntry, FsError, Listing, SyncFs, HYDRATE_CYCLE_BUDGET, HYDRATE_FILE_TIMEOUT};

    const STATUS_OBJECT_NAME_NOT_FOUND: i32 = 0xC000_0034_u32 as i32;
    const STATUS_OBJECT_PATH_NOT_FOUND: i32 = 0xC000_003A_u32 as i32;
    const STATUS_OBJECT_NAME_COLLISION: i32 = 0xC000_0035_u32 as i32;
    const STATUS_NOT_A_DIRECTORY: i32 = 0xC000_0103_u32 as i32;
    const STATUS_FILE_IS_A_DIRECTORY: i32 = 0xC000_00BA_u32 as i32;
    const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 1;
    const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 2;
    const ERROR_NO_MORE_FILES: i32 = 0x8007_0012_u32 as i32;

    fn raw(handle: &OwnedHandle) -> HANDLE {
        HANDLE(handle.as_raw_handle())
    }

    fn status_error(status: NTSTATUS) -> FsError {
        match status.0 {
            STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => FsError::NotFound,
            STATUS_OBJECT_NAME_COLLISION => FsError::Exists,
            STATUS_NOT_A_DIRECTORY | STATUS_FILE_IS_A_DIRECTORY => FsError::Unsafe,
            code => cloud_windows::status_error(code).unwrap_or(FsError::Io),
        }
    }

    /// Ouvre `name` par rapport au handle `parent`, sans suivre de point d'analyse (`NtCreateFile`, `RootDirectory`).
    fn open_relative(
        parent: &OwnedHandle,
        name: &str,
        access: FILE_ACCESS_RIGHTS,
        disposition: NTCREATEFILE_CREATE_DISPOSITION,
        options: NTCREATEFILE_CREATE_OPTIONS,
    ) -> Result<OwnedHandle, FsError> {
        if !super::is_safe_component(name) {
            return Err(FsError::Unsafe);
        }
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let bytes = u16::try_from(wide.len() * 2).map_err(|_| FsError::Unsafe)?;
        let object_name = UNICODE_STRING { Length: bytes, MaximumLength: bytes, Buffer: PWSTR(wide.as_mut_ptr()) };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: raw(parent),
            ObjectName: &object_name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: std::ptr::null(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut handle = HANDLE::default();
        let mut io = IO_STATUS_BLOCK::default();
        // SAFETY: toutes les structures vivent jusqu'au retour ; le handle rendu est possédé par l'`OwnedHandle` ci-dessous.
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                access | SYNCHRONIZE,
                &attributes,
                &mut io,
                None,
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                disposition,
                options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                None,
                0,
            )
        };
        if status.is_ok() {
            // SAFETY: handle valide rendu par NtCreateFile, possédé désormais par OwnedHandle.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle.0 as RawHandle) })
        } else {
            Err(status_error(status))
        }
    }

    /// Attributs et balise d'analyse lus sur le handle.
    fn attribute_tag(handle: &OwnedHandle) -> Result<(u32, u32), FsError> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
        // SAFETY: tampon de la taille de la structure demandée.
        unsafe {
            GetFileInformationByHandleEx(raw(handle), FileAttributeTagInfo, (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(), std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32)
        }
        .map_err(|_| FsError::Io)?;
        Ok((info.FileAttributes, info.ReparseTag))
    }

    fn check_tag(handle: &OwnedHandle) -> Result<u32, FsError> {
        let (attributes, tag) = attribute_tag(handle)?;
        if is_accepted_reparse(attributes, tag) {
            Ok(attributes)
        } else {
            Err(FsError::Unsafe)
        }
    }

    fn by_handle(handle: &OwnedHandle) -> Result<BY_HANDLE_FILE_INFORMATION, FsError> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: structure de sortie possédée.
        unsafe { GetFileInformationByHandle(raw(handle), &mut info) }.map_err(|_| FsError::Io)?;
        Ok(info)
    }

    fn is_cloud(attributes: u32) -> bool {
        attributes & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0 | FILE_ATTRIBUTE_RECALL_ON_OPEN.0 | FILE_ATTRIBUTE_OFFLINE.0) != 0
    }

    /// Dossier lié, rouvert et recontrôlé à chaque opération.
    pub struct StdFs {
        root: PathBuf,
        /// Chemin final normalisé attendu (en minuscules, pour la comparaison).
        root_key: String,
        cycle_started: Mutex<Instant>,
    }

    impl StdFs {
        /// `root` : chemin final normalisé contrôlé par `folder::check_sync_path`.
        pub fn new(root: PathBuf) -> Self {
            cloud_windows::expose_placeholders();
            let root_key = root.to_string_lossy().to_lowercase();
            Self { root, root_key, cycle_started: Mutex::new(Instant::now()) }
        }

        fn open_root(&self) -> Result<OwnedHandle, FsError> {
            let wide: Vec<u16> = self.root.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: chaîne terminée par zéro, vivante pendant l'appel.
            let handle = unsafe {
                CreateFileW(
                    PCWSTR(wide.as_ptr()),
                    (FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE).0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
            }
            .map_err(|_| FsError::Unreachable)?;
            // SAFETY: handle valide rendu par CreateFileW.
            let handle = unsafe { OwnedHandle::from_raw_handle(handle.0 as RawHandle) };
            let attributes = check_tag(&handle)?;
            if attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
                return Err(FsError::Unsafe);
            }
            let final_path = final_path_of(raw(&handle)).and_then(|p| normalize_final_path(&p)).ok_or(FsError::Unsafe)?;
            if final_path.to_lowercase() != self.root_key {
                return Err(FsError::Unsafe);
            }
            Ok(handle)
        }

        /// Handle du dossier `dir` (créé au besoin), chaque composant ouvert par rapport au précédent et contrôlé.
        fn open_dir(&self, dir: &[&str], create: bool) -> Result<OwnedHandle, FsError> {
            let mut handle = self.open_root()?;
            for name in dir {
                let disposition = if create { FILE_OPEN_IF } else { FILE_OPEN };
                let next = open_relative(&handle, name, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES, disposition, FILE_DIRECTORY_FILE)?;
                let attributes = check_tag(&next)?;
                if attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
                    return Err(FsError::Unsafe);
                }
                handle = next;
            }
            Ok(handle)
        }

        fn split<'a>(file: &'a [&'a str]) -> Result<(&'a [&'a str], &'a str), FsError> {
            match file.split_last() {
                Some((name, dir)) => Ok((dir, name)),
                None => Err(FsError::Unsafe),
            }
        }

        /// Le handle d'un fichier créé ou ouvert en écriture est sous la racine, sans point d'analyse étranger, à lien unique.
        fn check_writable(&self, handle: &OwnedHandle) -> Result<(), FsError> {
            check_tag(handle)?;
            if by_handle(handle)?.nNumberOfLinks > 1 {
                return Err(FsError::Unsafe);
            }
            let final_path = final_path_of(raw(handle)).and_then(|p| normalize_final_path(&p)).ok_or(FsError::Unsafe)?;
            let lower = final_path.to_lowercase();
            if !lower.starts_with(&self.root_key) || !lower[self.root_key.len()..].starts_with('\\') {
                return Err(FsError::Unsafe);
            }
            Ok(())
        }

        /// Renomme dans le dossier `parent` (`NtSetInformationFile`, `RootDirectory` = handle du dossier contrôlé) : le nom n'est jamais
        /// résolu par rapport au dossier courant du processus (ce que ferait `SetFileInformationByHandle` avec un nom simple).
        fn rename_handle(handle: &OwnedHandle, parent: &OwnedHandle, to: &str) -> Result<(), FsError> {
            if !super::is_safe_component(to) {
                return Err(FsError::Unsafe);
            }
            let name: Vec<u16> = to.encode_utf16().collect();
            let header = std::mem::size_of::<FILE_RENAME_INFORMATION>();
            let size = header + name.len() * 2;
            // Tampon aligné (u64) : structure de longueur variable, nom après l'en-tête.
            let mut buffer = vec![0u64; size.div_ceil(8)];
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
            let mut last = NTSTATUS(0);
            for (class, flags) in [(FileRenameInformationEx, FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS), (FileRenameInformation, 1)] {
                let mut io = IO_STATUS_BLOCK::default();
                // SAFETY: le tampon couvre l'en-tête et le nom ; écriture des champs dans la mémoire possédée, vivante pendant l'appel.
                last = unsafe {
                    (*info).Anonymous.Flags = flags;
                    (*info).RootDirectory = raw(parent);
                    (*info).FileNameLength = (name.len() * 2) as u32;
                    std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(), name.len());
                    NtSetInformationFile(raw(handle), &mut io, info.cast(), size as u32, class)
                };
                if last.is_ok() {
                    return Ok(());
                }
            }
            Err(status_error(last))
        }

        fn delete_handle(handle: &OwnedHandle) -> Result<(), FsError> {
            let ex = FILE_DISPOSITION_INFO_EX { Flags: FILE_DISPOSITION_INFO_EX_FLAGS(FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0) };
            // SAFETY: structures possédées, tailles exactes.
            unsafe {
                if SetFileInformationByHandle(raw(handle), FileDispositionInfoEx, (&ex as *const FILE_DISPOSITION_INFO_EX).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32).is_ok() {
                    return Ok(());
                }
                let plain = FILE_DISPOSITION_INFO { DeleteFile: true };
                SetFileInformationByHandle(raw(handle), FileDispositionInfo, (&plain as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32)
            }
            .map_err(|_| FsError::Io)
        }

        fn remaining_budget(&self) -> std::time::Duration {
            let started = *self.cycle_started.lock().unwrap_or_else(|e| e.into_inner());
            HYDRATE_CYCLE_BUDGET.saturating_sub(started.elapsed())
        }
    }

    fn list_handle(handle: &OwnedHandle, max: usize) -> Result<Listing, FsError> {
        let mut listing = Listing::default();
        let mut buffer = vec![0u64; 8 * 1024];
        let mut first = true;
        loop {
            let class = if first { FileFullDirectoryRestartInfo } else { FileFullDirectoryInfo };
            first = false;
            // SAFETY: tampon possédé de la taille annoncée.
            let result = unsafe { GetFileInformationByHandleEx(raw(handle), class, buffer.as_mut_ptr().cast(), (buffer.len() * 8) as u32) };
            if let Err(error) = result {
                if error.code().0 == ERROR_NO_MORE_FILES {
                    break;
                }
                return Err(FsError::Io);
            }
            let base = buffer.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            loop {
                // SAFETY: les entrées sont dans le tampon rendu ; lecture non alignée des champs.
                let (next, name, attributes, size, tag) = unsafe {
                    let entry = base.add(offset).cast::<FILE_FULL_DIR_INFO>();
                    let info = std::ptr::read_unaligned(entry);
                    let name_ptr = std::ptr::addr_of!((*entry).FileName).cast::<u16>();
                    let chars = info.FileNameLength as usize / 2;
                    let mut name = vec![0u16; chars];
                    std::ptr::copy_nonoverlapping(name_ptr.cast::<u8>(), name.as_mut_ptr().cast::<u8>(), chars * 2);
                    // EaSize porte la balise d'analyse quand FILE_ATTRIBUTE_REPARSE_POINT est posé.
                    (info.NextEntryOffset as usize, String::from_utf16_lossy(&name), info.FileAttributes, info.EndOfFile.max(0) as u64, info.EaSize)
                };
                if name != "." && name != ".." {
                    if listing.entries.len() >= max {
                        listing.truncated = true;
                        return Ok(listing);
                    }
                    let availability = if !is_accepted_reparse(attributes, tag) {
                        // Jonction, lien symbolique ou balise inconnue : jamais ouvert (la balise est aussi recontrôlée à l'ouverture).
                        Availability::Error
                    } else if is_cloud(attributes) {
                        Availability::Cloud
                    } else {
                        Availability::Local
                    };
                    listing.entries.push(FsEntry { name, is_dir: attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0, size, availability });
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
        Ok(listing)
    }

    fn read_limited(file: &mut File, limit: u64) -> Result<Vec<u8>, FsError> {
        let mut out = Vec::new();
        file.take(limit.saturating_add(1)).read_to_end(&mut out).map_err(|e| cloud_windows::io_error(&e))?;
        if out.len() as u64 > limit {
            return Err(FsError::TooLarge);
        }
        Ok(out)
    }

    impl SyncFs for StdFs {
        fn check_root(&self) -> Result<(), FsError> {
            self.open_root().map(|_| ())
        }

        fn start_cycle(&self) -> Result<(), FsError> {
            self.open_root()?;
            *self.cycle_started.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
            Ok(())
        }

        fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = self.open_dir(dir, false)?;
            let handle = open_relative(&parent, name, FILE_GENERIC_READ, FILE_OPEN, FILE_NON_DIRECTORY_FILE)?;
            if is_cloud(check_tag(&handle)?) {
                return Err(FsError::CloudPending);
            }
            let mut out = Vec::with_capacity(max);
            File::from(handle).take(max as u64).read_to_end(&mut out).map_err(|e| cloud_windows::io_error(&e))?;
            Ok(out)
        }

        fn list(&self, dir: &[&str], max: usize) -> Result<Listing, FsError> {
            let handle = self.open_dir(dir, false)?;
            list_handle(&handle, max)
        }

        fn read(&self, file: &[&str], limit: u64, hydrate: bool) -> Result<Vec<u8>, FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = self.open_dir(dir, false)?;
            let handle = open_relative(&parent, name, FILE_GENERIC_READ, FILE_OPEN, FILE_NON_DIRECTORY_FILE)?;
            let attributes = check_tag(&handle)?;
            let info = by_handle(&handle)?;
            let size = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
            // Taille annoncée contrôlée avant toute lecture ou hydratation (section 1.6).
            if size > limit {
                return Err(FsError::TooLarge);
            }
            if !is_cloud(attributes) {
                return read_limited(&mut File::from(handle), limit);
            }
            if !hydrate {
                return Err(FsError::CloudPending);
            }
            let budget = self.remaining_budget().min(HYDRATE_FILE_TIMEOUT);
            if budget.is_zero() {
                return Err(FsError::CloudPending);
            }
            // Hydratation sur un fil dédié : au-delà du délai, le fichier reste « en attente d'iCloud » (le fil finit seul).
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let result = cloud_windows::hydrate(raw(&handle)).and_then(|()| read_limited(&mut File::from(handle), limit));
                let _ = sender.send(result);
            });
            receiver.recv_timeout(budget).unwrap_or(Err(FsError::CloudPending))
        }

        fn append(&self, file: &[&str], bytes: &[u8], mode: AppendMode) -> Result<(), FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = self.open_dir(dir, false)?;
            let disposition = if mode == AppendMode::CreateNew { FILE_CREATE } else { FILE_OPEN };
            let handle = open_relative(&parent, name, FILE_APPEND_DATA | FILE_READ_ATTRIBUTES, disposition, FILE_NON_DIRECTORY_FILE)?;
            self.check_writable(&handle)?;
            let mut file = File::from(handle);
            file.write_all(bytes).map_err(|e| cloud_windows::io_error(&e))?;
            file.sync_all().map_err(|e| cloud_windows::io_error(&e))
        }

        fn write_atomic(&self, file: &[&str], bytes: &[u8]) -> Result<(), FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = self.open_dir(dir, false)?;
            let temp = format!("{name}{}", super::super::names::TEMP_SUFFIX);
            // Un ancien `.tmp` est supprimé (son nom seulement), puis le nouveau est créé exclusivement : un `.tmp` lien physique vers un
            // autre fichier n'est jamais tronqué ni écrit (audit S3).
            match open_relative(&parent, &temp, DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN, FILE_NON_DIRECTORY_FILE) {
                Ok(old) => {
                    check_tag(&old)?;
                    Self::delete_handle(&old)?;
                }
                Err(FsError::NotFound) => {}
                Err(error) => return Err(error),
            }
            let handle = open_relative(&parent, &temp, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE, FILE_CREATE, FILE_NON_DIRECTORY_FILE)?;
            self.check_writable(&handle)?;
            let mut file = File::from(handle);
            file.write_all(bytes).map_err(|e| cloud_windows::io_error(&e))?;
            file.sync_all().map_err(|e| cloud_windows::io_error(&e))?;
            let handle = OwnedHandle::from(file);
            Self::rename_handle(&handle, &parent, name)
        }

        fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError> {
            let parent = self.open_dir(dir, false)?;
            let handle = open_relative(&parent, from, DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN, FILE_NON_DIRECTORY_FILE)?;
            self.check_writable(&handle)?;
            Self::rename_handle(&handle, &parent, to)
        }

        fn create_dir(&self, dir: &[&str]) -> Result<(), FsError> {
            self.open_dir(dir, true).map(|_| ())
        }

        fn remove_file(&self, file: &[&str]) -> Result<bool, FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = match self.open_dir(dir, false) {
                Ok(parent) => parent,
                Err(FsError::NotFound) => return Ok(false),
                Err(error) => return Err(error),
            };
            let handle = match open_relative(&parent, name, DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN, FILE_NON_DIRECTORY_FILE) {
                Ok(handle) => handle,
                Err(FsError::NotFound) => return Ok(false),
                Err(error) => return Err(error),
            };
            check_tag(&handle)?;
            Self::delete_handle(&handle).map(|()| true)
        }

        fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError> {
            let (parent_dir, name) = Self::split(dir)?;
            let parent = self.open_dir(parent_dir, false)?;
            let handle = match open_relative(&parent, name, DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_OPEN, FILE_DIRECTORY_FILE) {
                Ok(handle) => handle,
                Err(FsError::NotFound) => return Ok(()),
                Err(error) => return Err(error),
            };
            check_tag(&handle)?;
            if !list_handle(&handle, 1)?.entries.is_empty() {
                return Ok(());
            }
            Self::delete_handle(&handle)
        }

        fn pin(&self, file: &[&str]) -> Result<(), FsError> {
            let (dir, name) = Self::split(file)?;
            let parent = self.open_dir(dir, false)?;
            let handle = open_relative(&parent, name, FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, FILE_OPEN, FILE_NON_DIRECTORY_FILE)?;
            check_tag(&handle)?;
            cloud_windows::pin(raw(&handle))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! Repli sans contrôle de point d'analyse Windows (cibles non livrées par ce lot) : liens symboliques refusés, `std::fs`.
    //! L'iPhone utilisera `BookmarkFs` (plugin folder-bookmark, ordre 5).

    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

    use super::{AppendMode, Availability, FsEntry, FsError, Listing, SyncFs};

    pub struct StdFs {
        root: PathBuf,
    }

    impl StdFs {
        pub fn new(root: PathBuf) -> Self {
            Self { root }
        }

        fn path(&self, parts: &[&str]) -> Result<PathBuf, FsError> {
            let mut path = self.root.clone();
            for part in parts {
                if !super::is_safe_component(part) {
                    return Err(FsError::Unsafe);
                }
                path.push(part);
                if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err(FsError::Unsafe);
                }
            }
            Ok(path)
        }
    }

    fn io(error: &std::io::Error) -> FsError {
        if error.kind() == std::io::ErrorKind::NotFound {
            FsError::NotFound
        } else {
            FsError::Io
        }
    }

    fn sync_dir(path: &Path) {
        if let Some(parent) = path.parent() {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }

    impl SyncFs for StdFs {
        fn check_root(&self) -> Result<(), FsError> {
            match fs::symlink_metadata(&self.root) {
                Ok(m) if m.is_dir() => Ok(()),
                Ok(_) => Err(FsError::Unsafe),
                Err(_) => Err(FsError::Unreachable),
            }
        }

        fn start_cycle(&self) -> Result<(), FsError> {
            self.check_root()
        }

        fn read_head(&self, file: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
            let mut out = Vec::new();
            File::open(self.path(file)?).map_err(|e| io(&e))?.take(max as u64).read_to_end(&mut out).map_err(|e| io(&e))?;
            Ok(out)
        }

        fn list(&self, dir: &[&str], max: usize) -> Result<Listing, FsError> {
            let mut listing = Listing::default();
            for entry in fs::read_dir(self.path(dir)?).map_err(|e| io(&e))? {
                let entry = entry.map_err(|e| io(&e))?;
                if listing.entries.len() >= max {
                    listing.truncated = true;
                    break;
                }
                let meta = entry.metadata().map_err(|e| io(&e))?;
                let availability = if meta.file_type().is_symlink() { Availability::Error } else { Availability::Local };
                listing.entries.push(FsEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir: meta.is_dir(), size: meta.len(), availability });
            }
            Ok(listing)
        }

        fn read(&self, file: &[&str], limit: u64, _hydrate: bool) -> Result<Vec<u8>, FsError> {
            let path = self.path(file)?;
            let meta = fs::symlink_metadata(&path).map_err(|e| io(&e))?;
            if meta.len() > limit {
                return Err(FsError::TooLarge);
            }
            let mut out = Vec::new();
            File::open(&path).map_err(|e| io(&e))?.take(limit.saturating_add(1)).read_to_end(&mut out).map_err(|e| io(&e))?;
            if out.len() as u64 > limit {
                return Err(FsError::TooLarge);
            }
            Ok(out)
        }

        fn append(&self, file: &[&str], bytes: &[u8], mode: AppendMode) -> Result<(), FsError> {
            let path = self.path(file)?;
            let mut options = OpenOptions::new();
            options.append(true);
            if mode == AppendMode::CreateNew {
                options.create_new(true);
            }
            let mut handle = options.open(&path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { FsError::Exists } else { io(&e) })?;
            handle.write_all(bytes).map_err(|e| io(&e))?;
            handle.sync_all().map_err(|e| io(&e))?;
            sync_dir(&path);
            Ok(())
        }

        fn write_atomic(&self, file: &[&str], bytes: &[u8]) -> Result<(), FsError> {
            let path = self.path(file)?;
            let mut temp = path.clone().into_os_string();
            temp.push(super::super::names::TEMP_SUFFIX);
            let temp = PathBuf::from(temp);
            let mut handle = File::create(&temp).map_err(|e| io(&e))?;
            handle.write_all(bytes).map_err(|e| io(&e))?;
            handle.sync_all().map_err(|e| io(&e))?;
            fs::rename(&temp, &path).map_err(|e| io(&e))?;
            sync_dir(&path);
            Ok(())
        }

        fn rename(&self, dir: &[&str], from: &str, to: &str) -> Result<(), FsError> {
            let base = self.path(dir)?;
            fs::rename(base.join(from), base.join(to)).map_err(|e| io(&e))
        }

        fn create_dir(&self, dir: &[&str]) -> Result<(), FsError> {
            let path = self.path(dir)?;
            fs::create_dir_all(path).map_err(|e| io(&e))
        }

        fn remove_file(&self, file: &[&str]) -> Result<bool, FsError> {
            match fs::remove_file(self.path(file)?) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(io(&e)),
            }
        }

        fn remove_empty_dir(&self, dir: &[&str]) -> Result<(), FsError> {
            let _ = fs::remove_dir(self.path(dir)?);
            Ok(())
        }

        fn pin(&self, _file: &[&str]) -> Result<(), FsError> {
            Ok(())
        }
    }
}
