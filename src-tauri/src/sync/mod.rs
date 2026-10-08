//! Synchronisation par iCloud Drive, partie Rust (ADR 0011 ; lot Y1 : Y-08, Y-01).
//!
//! Rust tient le dossier choisi (jamais de chemin dans la WebView), le contrôle du dossier, l'hydratation des fichiers du nuage,
//! la lecture et l'écriture des fichiers, le chiffrement, le bourrage, l'AAD, les bornes, la clé au coffre, le QR et la clé de
//! secours derrière une confirmation native, et le marqueur de restauration. **Aucune règle de fusion** : elles sont dans
//! `src/domain/sync` (TypeScript).
//!
//! Modules : `limits` (bornes), `names` (noms stricts), `crypto` (chiffrement, clé de secours, QR), `files` (trait `SyncFs`,
//! `StdFs`), `folder` (contrôle du dossier, `folder.json`), `cloud_windows` (fichiers à la demande), `store` (journaux, état,
//! instantanés, `own.json`), `consent` (confirmation native et compteurs), `pairing` (fenêtre dédiée), `reset` (réinitialisation avec une nouvelle clé, Y-11), `marker` (marqueur de
//! restauration), `service` (service commun aux commandes et aux tests), `state` (état publié, `own.json`), `commands` (24 commandes Tauri, PC),
//! `bookmark` et `commands_ios` (iPhone, ADR 0011 §22 : plugin folder-bookmark, 21 commandes).
//!
//! Journal technique : codes, compteurs, noms stricts, identifiants d'appareil et d'époque seulement ; jamais de clé, de texte
//! clair, de `qrText`, de saisie ni de chemin complet (section 2.3).

pub mod limits;
pub mod names;
pub mod crypto;
pub mod files;
pub mod forget;
pub mod folder;
#[cfg(windows)]
pub mod cloud_windows;
pub mod store;
pub mod consent;
pub mod pairing;
pub mod reset;
pub mod marker;
pub mod service;
pub mod state;
#[cfg(desktop)]
pub mod commands;
/// iPhone (ADR 0011 §22) : `BookmarkFs` sur le plugin folder-bookmark ; présent dans les tests Windows (`test-hooks`), absent du PC livré.
#[cfg(any(target_os = "ios", feature = "test-hooks"))]
pub mod bookmark;
/// iPhone (ADR 0011 §23 point 3) : confirmation native par `UIAlertController` (plugin folder-bookmark).
#[cfg(any(target_os = "ios", feature = "test-hooks"))]
pub mod consent_ios;
/// iPhone (ADR 0011 §22 point 7) : les commandes `sync_*` de l'iPhone (mêmes noms, entrées et sorties), même `SyncCore`. iOS seulement :
/// les macros de `#[tauri::command]` portent le nom de la commande à la racine du crate et ne peuvent pas coexister avec `commands` (PC) ;
/// leur logique (`bookmark::ios_core`, `bookmark::choose_with_picker`) est testée sous Windows.
#[cfg(target_os = "ios")]
pub mod commands_ios;

use serde::Serialize;

/// Codes d'erreur des commandes `sync_*` (section 11.1), identiques à `SYNC_ERROR_CODES` de `format.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyncCode {
    NotConfigured,
    FolderUnreachable,
    UnsafeFolder,
    NotLocal,
    FolderTooLarge,
    CloudPending,
    CloudProviderStopped,
    CloudError,
    VaultUnavailable,
    KeyMissing,
    KeyExists,
    KeyMismatch,
    KeyExhausted,
    ConsentDenied,
    RateLimited,
    /// Fenêtre propriétaire pas visible ou pas au premier plan (aucune boîte ouverte) ; Y-06, distinct de `ConsentDenied`.
    NotForeground,
    /// Fenêtre `pairing` déjà ouverte (ou en cours d'ouverture) ; Y-06, distinct de `ConsentDenied`.
    AlreadyOpen,
    /// Fenêtre `pairing` créée mais impossible à protéger (affinité d'affichage ou réglages de la WebView) : détruite ; distinct de
    /// `Io` (page absente, « Installation incomplète »), remarque finale de Y-06.
    WindowUnprotected,
    DecryptFailed,
    Truncated,
    BadName,
    BadHeader,
    TooLarge,
    NewerFormat,
    Rollback,
    SegmentMismatch,
    SegmentFull,
    StateMismatch,
    FolderHasData,
    WrongWindow,
    WrongMode,
    HlcOrder,
    InvalidPairing,
    PairingExpired,
    NotBound,
    AlreadyBound,
    CurrentEpoch,
    Io,
}

impl SyncCode {
    pub const ALL: [SyncCode; 38] = [
        SyncCode::NotConfigured,
        SyncCode::FolderUnreachable,
        SyncCode::UnsafeFolder,
        SyncCode::NotLocal,
        SyncCode::FolderTooLarge,
        SyncCode::CloudPending,
        SyncCode::CloudProviderStopped,
        SyncCode::CloudError,
        SyncCode::VaultUnavailable,
        SyncCode::KeyMissing,
        SyncCode::KeyExists,
        SyncCode::KeyMismatch,
        SyncCode::KeyExhausted,
        SyncCode::ConsentDenied,
        SyncCode::RateLimited,
        SyncCode::NotForeground,
        SyncCode::AlreadyOpen,
        SyncCode::WindowUnprotected,
        SyncCode::DecryptFailed,
        SyncCode::Truncated,
        SyncCode::BadName,
        SyncCode::BadHeader,
        SyncCode::TooLarge,
        SyncCode::NewerFormat,
        SyncCode::Rollback,
        SyncCode::SegmentMismatch,
        SyncCode::SegmentFull,
        SyncCode::StateMismatch,
        SyncCode::FolderHasData,
        SyncCode::WrongWindow,
        SyncCode::WrongMode,
        SyncCode::HlcOrder,
        SyncCode::InvalidPairing,
        SyncCode::PairingExpired,
        SyncCode::NotBound,
        SyncCode::AlreadyBound,
        SyncCode::CurrentEpoch,
        SyncCode::Io,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SyncCode::NotConfigured => "not-configured",
            SyncCode::FolderUnreachable => "folder-unreachable",
            SyncCode::UnsafeFolder => "unsafe-folder",
            SyncCode::NotLocal => "not-local",
            SyncCode::FolderTooLarge => "folder-too-large",
            SyncCode::CloudPending => "cloud-pending",
            SyncCode::CloudProviderStopped => "cloud-provider-stopped",
            SyncCode::CloudError => "cloud-error",
            SyncCode::VaultUnavailable => "vault-unavailable",
            SyncCode::KeyMissing => "key-missing",
            SyncCode::KeyExists => "key-exists",
            SyncCode::KeyMismatch => "key-mismatch",
            SyncCode::KeyExhausted => "key-exhausted",
            SyncCode::ConsentDenied => "consent-denied",
            SyncCode::RateLimited => "rate-limited",
            SyncCode::NotForeground => "not-foreground",
            SyncCode::AlreadyOpen => "already-open",
            SyncCode::WindowUnprotected => "window-unprotected",
            SyncCode::DecryptFailed => "decrypt-failed",
            SyncCode::Truncated => "truncated",
            SyncCode::BadName => "bad-name",
            SyncCode::BadHeader => "bad-header",
            SyncCode::TooLarge => "too-large",
            SyncCode::NewerFormat => "newer-format",
            SyncCode::Rollback => "rollback",
            SyncCode::SegmentMismatch => "segment-mismatch",
            SyncCode::SegmentFull => "segment-full",
            SyncCode::StateMismatch => "state-mismatch",
            SyncCode::FolderHasData => "folder-has-data",
            SyncCode::WrongWindow => "wrong-window",
            SyncCode::WrongMode => "wrong-mode",
            SyncCode::HlcOrder => "hlc-order",
            SyncCode::InvalidPairing => "invalid-pairing",
            SyncCode::PairingExpired => "pairing-expired",
            SyncCode::NotBound => "not-bound",
            SyncCode::AlreadyBound => "already-bound",
            SyncCode::CurrentEpoch => "current-epoch",
            SyncCode::Io => "io",
        }
    }
}

/// Rejet d'une commande : `{ code, message }`. Le message est technique et fixe par code : jamais de chemin, de clé ni de recopie de
/// l'entrée (section 2.3). Les textes affichés viennent de `src/i18n`, choisis par le code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SyncError {
    #[serde(serialize_with = "serialize_code")]
    pub code: SyncCode,
    pub message: &'static str,
}

fn serialize_code<S: serde::Serializer>(code: &SyncCode, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(code.as_str())
}

impl SyncError {
    pub const fn new(code: SyncCode) -> Self {
        Self { code, message: "synchro" }
    }
}

impl From<SyncCode> for SyncError {
    fn from(code: SyncCode) -> Self {
        Self::new(code)
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "synchro : {}", self.code.as_str())
    }
}

pub type SyncResult<T> = Result<T, SyncError>;

/// Raccourci : `Err(code)`.
pub fn fail<T>(code: SyncCode) -> SyncResult<T> {
    Err(SyncError::new(code))
}

/// Journal technique de la synchro : un événement et des compteurs, jamais de contenu (section 2.3). Écrit sur la sortie d'erreur
/// en développement seulement ; les tests le capturent par `take_log`.
pub mod log {
    //! En production, aucun journal n'est gardé : un événement n'est ni écrit ni conservé (pas de tampon inutilisé, revue B5). En
    //! développement et dans les tests (`debug_assertions`), il est écrit sur la sortie d'erreur et remis aux captures ouvertes par
    //! `capture()` : une capture voit les événements de **tous** les fils (fils de `spawn_blocking`, hydratation), sans plafond, et
    //! seulement pendant sa durée de vie ; deux tests parallèles ont chacun la leur.

    #[cfg(debug_assertions)]
    use std::sync::{Arc, Mutex};

    #[cfg(debug_assertions)]
    type Sink = Arc<Mutex<Vec<String>>>;

    #[cfg(debug_assertions)]
    static SINKS: Mutex<Vec<Sink>> = Mutex::new(Vec::new());

    /// `event` : identifiant fixe (`folder-ignored`, `pin-failed`…) ; `detail` : nom strict, code, compteur ou identifiant d'appareil.
    #[cfg(debug_assertions)]
    pub fn event(event: &'static str, detail: &str) {
        let line = format!("sync:{event} {detail}");
        eprintln!("{line}");
        let sinks: Vec<Sink> = SINKS.lock().map(|s| s.clone()).unwrap_or_default();
        for sink in sinks {
            if let Ok(mut lines) = sink.lock() {
                lines.push(line.clone());
            }
        }
    }

    #[cfg(not(debug_assertions))]
    #[inline]
    pub fn event(_event: &'static str, _detail: &str) {}

    /// Capture des événements de tous les fils jusqu'à sa destruction (tests de développement seulement).
    #[cfg(debug_assertions)]
    pub struct Capture(Sink);

    #[cfg(debug_assertions)]
    impl Capture {
        /// Lignes reçues depuis l'ouverture de la capture.
        pub fn lines(&self) -> Vec<String> {
            self.0.lock().map(|l| l.clone()).unwrap_or_default()
        }
    }

    #[cfg(debug_assertions)]
    impl Drop for Capture {
        fn drop(&mut self) {
            if let Ok(mut sinks) = SINKS.lock() {
                sinks.retain(|s| !Arc::ptr_eq(s, &self.0));
            }
        }
    }

    /// Ouvre une capture (voir le module).
    #[cfg(debug_assertions)]
    pub fn capture() -> Capture {
        let sink: Sink = Arc::new(Mutex::new(Vec::new()));
        if let Ok(mut sinks) = SINKS.lock() {
            sinks.push(sink.clone());
        }
        Capture(sink)
    }
}
