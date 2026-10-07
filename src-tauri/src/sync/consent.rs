//! Confirmation native avant d'exposer ou de remplacer la clé (ADR 0011 section 2.1 ; Y-08 critères 10, 11 et 14).
//!
//! - Boîte système ouverte par Rust (`TaskDialogIndirect` sur Windows), propriétaire = fenêtre appelante, deux boutons, « Annuler »
//!   par défaut (`nDefaultButton == IDCANCEL` : Entrée ou Espace répondent « Annuler »). Textes lus dans `src/i18n/native/fr.json`,
//!   compilés dans le binaire : jamais fournis par la WebView.
//! - Préconditions : fenêtre propriétaire visible, non réduite et au premier plan, sinon `consent-denied` sans boîte.
//! - Compteurs persistés (`sync/consent.json`, `.tmp` + renommage) : 3 affichages et 5 imports par 10 minutes (toute ouverture compte,
//!   refus compris), 10 minutes de blocage après un refus, relus après un redémarrage ; un fichier illisible vaut « bloqué 10
//!   minutes ». Une seule boîte à la fois (`rate-limited` pendant qu'une boîte est ouverte).
//! - Y-TECH-02 : une ouverture qui n'a pas pu être comptée sur le disque n'ouvre aucune boîte (`io`) ; un blocage (refus, fichier
//!   illisible) est toujours gardé en mémoire, même si son écriture échoue.
//!
//! Le trait `ConsentUi` est injecté : les tests remplacent la boîte et les préconditions.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::folder::{read_config_file, write_config_file};
use super::limits::{CONSENT_BLOCK_MS, CONSENT_MAX_IMPORT, CONSENT_MAX_SHOW, CONSENT_WINDOW_MS};
use super::{fail, log, SyncCode, SyncResult};

pub const CONSENT_FILE: &str = "consent.json";
/// Audit (point bas 7 ; seconde revue, point 4) : refus qui n'a pas pu être écrit ; contient l'échéance du blocage (ms), respectée à la
/// relance, puis retiré.
pub const CONSENT_REFUSED_MARKER: &str = "consent.refused";
/// Identifiant du bouton de confirmation ; « Annuler » porte `IDCANCEL`.
pub const ID_CONFIRM: i32 = 100;
/// `IDCANCEL` (winuser.h).
pub const IDCANCEL: i32 = 2;

/// Textes des boîtes natives (`src/i18n/native/fr.json`).
const NATIVE_TEXTS: &str = include_str!("../../../src/i18n/native/fr.json");

/// Boîte demandée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentKind {
    /// Afficher le QR et la clé de secours (`sync_pairing_open({ mode: 'show' })`, « Nouveau code »).
    ShowKey,
    /// Remplacer une autre clé déjà au coffre (`sync_key_import`).
    ReplaceKey,
    /// Oublier le dossier et effacer la clé (`sync_folder_forget({ eraseKey: true })`).
    EraseKey,
    /// Oublier un autre appareil (`sync_device_forget`, Y-10) : irréversible.
    ForgetDevice,
    /// Réinitialiser la synchronisation avec une nouvelle clé (`sync_reset_key`, Y-11).
    ResetKey,
}

impl ConsentKind {
    fn key(self) -> &'static str {
        match self {
            ConsentKind::ShowKey => "showKey",
            ConsentKind::ReplaceKey => "replaceKey",
            ConsentKind::EraseKey => "eraseKey",
            ConsentKind::ForgetDevice => "forgetDevice",
            ConsentKind::ResetKey => "resetKey",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DialogTexts {
    pub title: String,
    pub instruction: String,
    pub content: String,
    pub confirm: String,
    pub cancel: String,
}

/// Textes d'une boîte, lus dans le fichier compilé.
pub fn dialog_texts(kind: ConsentKind) -> DialogTexts {
    static TEXTS: OnceLock<serde_json::Value> = OnceLock::new();
    let all = TEXTS.get_or_init(|| serde_json::from_str(NATIVE_TEXTS).unwrap_or(serde_json::Value::Null));
    serde_json::from_value(all["consent"][kind.key()].clone()).unwrap_or_else(|_| DialogTexts {
        title: String::new(),
        instruction: String::new(),
        content: String::new(),
        confirm: String::new(),
        cancel: String::new(),
    })
}

/// Textes du détail de la boîte « Oublier cet appareil » (`forgetDetail` de `native/fr.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ForgetDetailTexts {
    pub detail: String,
    pub never: String,
    pub windows: String,
    pub ios: String,
}

/// Textes du détail de la boîte d'oubli, lus dans le fichier compilé.
pub fn forget_detail_texts() -> ForgetDetailTexts {
    let all: serde_json::Value = serde_json::from_str(NATIVE_TEXTS).unwrap_or(serde_json::Value::Null);
    serde_json::from_value(all["forgetDetail"].clone()).unwrap_or_default()
}

/// Configuration d'une boîte (fonction pure, testée) : propriétaire, deux boutons, « Annuler » par défaut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogSpec {
    pub owner: isize,
    pub texts: DialogTexts,
    pub buttons: Vec<(i32, String)>,
    pub default_button: i32,
}

pub fn dialog_spec(kind: ConsentKind, owner: isize) -> DialogSpec {
    dialog_spec_with(kind, owner, None)
}

/// Même boîte, avec une ligne de détail composée par Rust en tête de l'explication (Y-10 : appareil visé, audit e).
pub fn dialog_spec_with(kind: ConsentKind, owner: isize, detail: Option<&str>) -> DialogSpec {
    let mut texts = dialog_texts(kind);
    if let Some(detail) = detail {
        texts.content = format!("{detail}\n\n{}", texts.content);
    }
    let buttons = vec![(ID_CONFIRM, texts.confirm.clone()), (IDCANCEL, texts.cancel.clone())];
    DialogSpec { owner, texts, buttons, default_button: IDCANCEL }
}

/// Boîte et préconditions de premier plan (injectables).
pub trait ConsentUi: Send + Sync {
    /// Fenêtre propriétaire visible, non réduite et au premier plan.
    fn owner_ready(&self, owner: isize) -> bool;
    /// Ouvre la boîte (bloquant) ; `true` seulement si l'utilisateur a choisi le bouton de confirmation.
    fn ask(&self, spec: &DialogSpec) -> bool;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Counters {
    show: Vec<u64>,
    import: Vec<u64>,
    blocked_until: u64,
    /// Y-10 : ouvertures de la boîte « Oublier cet appareil » (même plafond que l'affichage de la clé). Absent des fichiers antérieurs.
    #[serde(default)]
    forget: Vec<u64>,
    /// Y-11 : ouvertures de la boîte « Réinitialiser la synchronisation » (même plafond). Absent des fichiers antérieurs.
    #[serde(default)]
    reset: Vec<u64>,
}

/// Compteurs persistés et verrou « une seule boîte à la fois ».
pub struct ConsentGate {
    path: PathBuf,
    marker: PathBuf,
    ui: Arc<dyn ConsentUi>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    busy: AtomicBool,
    file: Mutex<()>,
    /// Fin du dernier blocage décidé par cette instance (refus, fichier illisible), gardée même si son écriture échoue.
    blocked_until: AtomicU64,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ConsentGate {
    /// `config_dir` : dossier `sync/` du dossier de configuration.
    pub fn new(config_dir: PathBuf, ui: Arc<dyn ConsentUi>, now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            marker: config_dir.join(CONSENT_REFUSED_MARKER),
            path: config_dir.join(CONSENT_FILE),
            ui,
            now,
            busy: AtomicBool::new(false),
            file: Mutex::new(()),
            blocked_until: AtomicU64::new(0),
        }
    }

    fn load(&self, now: u64) -> SyncResult<Counters> {
        // Refus non écrit (marqueur) : blocage jusqu'à son échéance. Troisième revue, point 3 : `consent.json` lisible reste lu (le
        // plus tardif des deux blocages), pour qu'un refus pendant le blocage ne réécrive jamais des compteurs vides.
        let marker = self.marker_block(now)?;
        Ok(match read_config_file::<Counters>(&self.path) {
            Ok(Some(mut counters)) => {
                if let Some(deadline) = marker {
                    counters.blocked_until = counters.blocked_until.max(deadline);
                }
                counters
            }
            Ok(None) => Counters { blocked_until: marker.unwrap_or(0), ..Counters::default() },
            // Fichier illisible pendant le blocage du marqueur : comportement inchangé (compteurs vides, échéance du marqueur).
            Err(()) if marker.is_some() => Counters { blocked_until: marker.unwrap_or(0), ..Counters::default() },
            Err(()) => {
                // Fichier illisible : bloqué 10 minutes (et réécrit, pour que le blocage ne se prolonge pas à chaque lecture).
                log::event("consent-file-unreadable", "blocked");
                let blocked = Counters { blocked_until: now + CONSENT_BLOCK_MS, ..Counters::default() };
                self.block_in_memory(blocked.blocked_until);
                // Échec d'écriture journalisé par `save` : le blocage reste en mémoire, et le fichier illisible le redonne au démarrage.
                let _ = self.save(&blocked);
                blocked
            }
        })
    }

    /// Seconde revue, point 4 : marqueur `consent.refused` (échéance du blocage, ms) : bloqué jusqu'à l'échéance, jamais prolongé à la
    /// lecture ; illisible : 10 minutes, échéance réécrite ; échu : retiré, et `io` s'il ne peut pas l'être (la cause est l'écriture).
    /// Rend l'échéance du blocage en cours (None : aucun marqueur, ou marqueur échu et retiré).
    fn marker_block(&self, now: u64) -> SyncResult<Option<u64>> {
        let text = match std::fs::read_to_string(&self.marker) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                log::event("consent-marker-unreadable", "io");
                return fail(SyncCode::Io);
            }
        };
        let deadline = match text.trim().parse::<u64>() {
            Ok(deadline) => deadline,
            Err(_) => {
                let deadline = now + CONSENT_BLOCK_MS;
                if std::fs::write(&self.marker, deadline.to_string()).is_err() {
                    log::event("consent-marker-write-failed", "io");
                    return fail(SyncCode::Io);
                }
                deadline
            }
        };
        if now < deadline {
            self.block_in_memory(deadline);
            return Ok(Some(deadline));
        }
        if std::fs::remove_file(&self.marker).is_err() && self.marker.exists() {
            log::event("consent-marker-not-removed", "io");
            return fail(SyncCode::Io);
        }
        Ok(None)
    }

    /// Blocage après un refus (audit, point bas 7) : écrit, sinon réessayé une fois, sinon marqueur `consent.refused` que `load` lit comme
    /// un fichier illisible : le refus n'est jamais perdu à la relance.
    fn save_refusal(&self, counters: &Counters) {
        if self.save(counters).is_ok() || self.save(counters).is_ok() {
            return;
        }
        if std::fs::write(&self.marker, counters.blocked_until.to_string()).is_err() {
            log::event("consent-marker-write-failed", "io");
        } else {
            log::event("consent-refusal-marked", "blocked");
        }
    }

    /// Écrit les compteurs ; un échec est journalisé et rendu (`io`) : l'appelant n'ouvre alors aucune boîte.
    fn save(&self, counters: &Counters) -> SyncResult<()> {
        let written = serde_json::to_vec(counters).map_err(|_| super::SyncError::new(SyncCode::Io)).and_then(|bytes| write_config_file(&self.path, &bytes));
        if written.is_err() {
            log::event("consent-file-write-failed", "io");
        }
        written
    }

    fn block_in_memory(&self, until: u64) {
        self.blocked_until.fetch_max(until, Ordering::SeqCst);
    }

    /// Préconditions communes : propriétaire au premier plan, pas de blocage en cours, pas d'autre boîte ouverte.
    fn gate(&self, owner: isize, counters: &Counters, now: u64) -> SyncResult<()> {
        if self.busy.load(Ordering::SeqCst) {
            return fail(SyncCode::RateLimited);
        }
        if !self.ui.owner_ready(owner) {
            return fail(SyncCode::NotForeground);
        }
        if now < counters.blocked_until.max(self.blocked_until.load(Ordering::SeqCst)) {
            return fail(SyncCode::RateLimited);
        }
        Ok(())
    }

    fn prune(list: &mut Vec<u64>, now: u64) {
        list.retain(|&at| now.saturating_sub(at) < CONSENT_WINDOW_MS);
    }

    /// Ouvre la boîte ; un refus bloque 10 minutes.
    fn ask(&self, kind: ConsentKind, owner: isize) -> SyncResult<()> {
        self.ask_with(kind, owner, None)
    }

    fn ask_with(&self, kind: ConsentKind, owner: isize, detail: Option<&str>) -> SyncResult<()> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return fail(SyncCode::RateLimited);
        }
        let _busy = BusyGuard(&self.busy);
        log::event("consent-dialog", kind.key());
        if self.ui.ask(&dialog_spec_with(kind, owner, detail)) {
            return Ok(());
        }
        let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        // Lecture impossible : compteurs vides, le blocage est posé quand même (mémoire, fichier ou marqueur).
        let mut counters = self.load(now).unwrap_or_default();
        counters.blocked_until = now + CONSENT_BLOCK_MS;
        // Blocage gardé en mémoire d'abord : un échec d'écriture (journalisé) ne le lève jamais pendant cette session, ni après une
        // relance (marqueur).
        self.block_in_memory(counters.blocked_until);
        self.save_refusal(&counters);
        fail(SyncCode::ConsentDenied)
    }

    /// Affichage de la clé : 3 ouvertures par 10 minutes (toute ouverture compte, refus compris), puis la boîte.
    pub fn confirm_show(&self, owner: isize) -> SyncResult<()> {
        {
            let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            let mut counters = self.load(now)?;
            self.gate(owner, &counters, now)?;
            Self::prune(&mut counters.show, now);
            if counters.show.len() >= CONSENT_MAX_SHOW {
                return fail(SyncCode::RateLimited);
            }
            counters.show.push(now);
            // Ouverture non comptée sur le disque : aucune boîte (le plafond ne tiendrait plus après un redémarrage).
            self.save(&counters)?;
        }
        self.ask(ConsentKind::ShowKey, owner)
    }

    /// Oubli d'un appareil (Y-10) : mêmes préconditions, compteur persisté (3 ouvertures par 10 minutes, refus compris), blocage et
    /// verrou que l'affichage de la clé (Y-08), puis la boîte, « Annuler » par défaut.
    pub fn confirm_forget(&self, owner: isize, detail: &str) -> SyncResult<()> {
        {
            let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            let mut counters = self.load(now)?;
            self.gate(owner, &counters, now)?;
            Self::prune(&mut counters.forget, now);
            if counters.forget.len() >= CONSENT_MAX_SHOW {
                return fail(SyncCode::RateLimited);
            }
            counters.forget.push(now);
            // Ouverture non comptée sur le disque : aucune boîte (le plafond ne tiendrait plus après un redémarrage).
            self.save(&counters)?;
        }
        self.ask_with(ConsentKind::ForgetDevice, owner, Some(detail))
    }

    /// Réinitialisation (Y-11) : mêmes préconditions, compteur persisté (3 ouvertures par 10 minutes, refus compris), blocage et verrou
    /// que l'affichage de la clé (Y-08), puis la boîte, « Annuler » par défaut.
    pub fn confirm_reset(&self, owner: isize) -> SyncResult<()> {
        {
            let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            let mut counters = self.load(now)?;
            self.gate(owner, &counters, now)?;
            Self::prune(&mut counters.reset, now);
            if counters.reset.len() >= CONSENT_MAX_SHOW {
                return fail(SyncCode::RateLimited);
            }
            counters.reset.push(now);
            // Ouverture non comptée sur le disque : aucune boîte (le plafond ne tiendrait plus après un redémarrage).
            self.save(&counters)?;
        }
        self.ask(ConsentKind::ResetKey, owner)
    }

    /// Appel d'import : 5 par 10 minutes, fenêtre appelante au premier plan (aucune boîte à ce stade).
    pub fn count_import(&self, owner: isize) -> SyncResult<()> {
        let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        let mut counters = self.load(now)?;
        self.gate(owner, &counters, now)?;
        Self::prune(&mut counters.import, now);
        if counters.import.len() >= CONSENT_MAX_IMPORT {
            return fail(SyncCode::RateLimited);
        }
        counters.import.push(now);
        self.save(&counters)
    }

    /// Boîte sans compteur d'ouverture (remplacement ou effacement de la clé) : préconditions, blocage et verrou communs.
    pub fn confirm(&self, kind: ConsentKind, owner: isize) -> SyncResult<()> {
        {
            let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            let counters = self.load(now)?;
            self.gate(owner, &counters, now)?;
        }
        self.ask(kind, owner)
    }

    /// Préconditions seules (ouverture de la fenêtre de saisie) : premier plan, pas de blocage ni de boîte ouverte.
    pub fn precheck(&self, owner: isize) -> SyncResult<()> {
        let _lock = self.file.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        let counters = self.load(now)?;
        self.gate(owner, &counters, now)
    }

    /// Fenêtre propriétaire visible, non réduite et au premier plan.
    pub fn owner_ready(&self, owner: isize) -> bool {
        self.ui.owner_ready(owner)
    }

    /// Une boîte est-elle ouverte ?
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// Boîte système Windows et préconditions Win32.
#[cfg(windows)]
pub struct WindowsConsentUi;

#[cfg(windows)]
impl ConsentUi for WindowsConsentUi {
    fn owner_ready(&self, owner: isize) -> bool {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsIconic, IsWindowVisible};
        if owner == 0 {
            return false;
        }
        let hwnd = HWND(owner as *mut core::ffi::c_void);
        // SAFETY: fonctions de lecture d'état, tout handle accepté.
        unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() && GetForegroundWindow() == hwnd }
    }

    fn ask(&self, spec: &DialogSpec) -> bool {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Controls::{TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW};

        let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
        let title = wide(&spec.texts.title);
        let instruction = wide(&spec.texts.instruction);
        let content = wide(&spec.texts.content);
        let labels: Vec<Vec<u16>> = spec.buttons.iter().map(|(_, label)| wide(label)).collect();
        let buttons: Vec<TASKDIALOG_BUTTON> =
            spec.buttons.iter().zip(&labels).map(|((id, _), label)| TASKDIALOG_BUTTON { nButtonID: *id, pszButtonText: PCWSTR(label.as_ptr()) }).collect();
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: HWND(spec.owner as *mut core::ffi::c_void),
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            pszMainInstruction: PCWSTR(instruction.as_ptr()),
            pszContent: PCWSTR(content.as_ptr()),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: spec.default_button,
            ..Default::default()
        };
        let mut pressed = 0i32;
        // SAFETY: toutes les chaînes et le tableau de boutons vivent jusqu'au retour de la boîte modale.
        let result = unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) };
        result.is_ok() && pressed == ID_CONFIRM
    }
}

/// Repli des autres cibles : aucune boîte, toujours refusé (la confirmation iOS arrive à l'ordre 5).
#[cfg(not(windows))]
pub struct WindowsConsentUi;

#[cfg(not(windows))]
impl ConsentUi for WindowsConsentUi {
    fn owner_ready(&self, _owner: isize) -> bool {
        false
    }

    fn ask(&self, _spec: &DialogSpec) -> bool {
        false
    }
}
