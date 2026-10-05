//! Fenêtre dédiée `pairing` (ADR 0011 sections 2.1 et 10.3 ; Y-08 critères 12 et 13).
//!
//! La fenêtre n'est jamais déclarée dans `tauri.conf.json` : Rust la crée (`commands.rs`), masquée, avec l'URL fixe `pairing.html`,
//! lui applique `WDA_EXCLUDEFROMCAPTURE` avant de l'afficher et mémorise l'**instance** (HWND, mode, génération). Ce registre, sans
//! dépendance à Tauri, porte les règles testées :
//! - une instance n'est jamais réutilisée (`open` refuse un libellé occupé) ;
//! - chaque appel de la fenêtre est vérifié : libellé `pairing`, URL exacte, HWND de l'instance, sinon `wrong-window` ;
//! - le mode est lié à l'instance (`wrong-mode`) ;
//! - le jeton de consentement est à usage unique, lié à l'instance et à la génération ;
//! - un seul minuteur de 5 minutes par génération : celui d'une génération remplacée est sans effet.

use std::sync::Mutex;

use super::limits::PAIRING_VALIDITY_MS;
use super::{fail, SyncCode, SyncResult};

/// Libellé de la fenêtre dédiée (capability `sync-pairing.json`).
pub const PAIRING_WINDOW: &str = "pairing";
/// Page de la fenêtre (troisième entrée Vite, Y-06).
pub const PAIRING_PAGE: &str = "pairing.html";
/// URL de la page embarquée selon la plateforme.
pub const PAIRING_URLS: [&str; 3] = ["tauri://localhost/pairing.html", "http://tauri.localhost/pairing.html", "https://tauri.localhost/pairing.html"];
/// Serveur Vite (`devUrl`) : accepté seulement sous `cfg(debug_assertions)`.
#[cfg(debug_assertions)]
pub const PAIRING_DEV_URL: &str = "http://localhost:1420/pairing.html";

/// URL exacte de la page `pairing`, sans requête ni fragment. Le code qui accepte l'URL du serveur Vite n'existe pas en production.
pub fn is_pairing_url(url: &str) -> bool {
    if PAIRING_URLS.contains(&url) {
        return true;
    }
    #[cfg(debug_assertions)]
    if url == PAIRING_DEV_URL {
        return true;
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingMode {
    /// Affichage du QR et de la clé de secours (après confirmation native).
    Show,
    /// Saisie de la clé de secours.
    Import,
}

impl PairingMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "show" => Some(Self::Show),
            "import" => Some(Self::Import),
            _ => None,
        }
    }
}

/// Instance créée par Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairingInstance {
    pub hwnd: isize,
    pub mode: PairingMode,
    pub generation: u64,
    /// Échéance de la génération courante (ms Unix).
    pub expires_at: u64,
    /// Jeton de consentement de la génération courante encore disponible (usage unique).
    pub token: bool,
}

/// Fenêtre qui appelle une commande réservée à `pairing`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caller<'a> {
    pub label: &'a str,
    pub url: &'a str,
    pub hwnd: isize,
}

/// Instance mémorisée (une seule à la fois) et réservation du libellé pendant la boîte de confirmation.
#[derive(Default)]
pub struct PairingRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    instance: Option<PairingInstance>,
    /// Une ouverture est en cours (boîte de confirmation affichée) : un second `sync_pairing_open` est refusé.
    opening: bool,
}

impl PairingRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Début d'ouverture : refusé si une instance existe, si une ouverture est en cours ou si le libellé est occupé.
    pub fn begin_open(&self, label_taken: bool) -> SyncResult<()> {
        let mut state = self.lock();
        if label_taken || state.instance.is_some() || state.opening {
            super::log::event("pairing-refused", "label-taken");
            return fail(SyncCode::ConsentDenied);
        }
        state.opening = true;
        Ok(())
    }

    /// Fin d'une ouverture échouée.
    pub fn abort_open(&self) {
        self.lock().opening = false;
    }

    /// Enregistre l'instance créée par Rust ; jeton disponible pour la génération 1 en mode `show`.
    pub fn register(&self, hwnd: isize, mode: PairingMode, now: u64) -> PairingInstance {
        let mut state = self.lock();
        let instance = PairingInstance { hwnd, mode, generation: 1, expires_at: now + PAIRING_VALIDITY_MS, token: mode == PairingMode::Show };
        state.instance = Some(instance);
        state.opening = false;
        instance
    }

    pub fn current(&self) -> Option<PairingInstance> {
        self.lock().instance
    }

    /// Contrôles de chaque appel de la fenêtre : libellé, URL exacte, HWND de l'instance, échéance.
    pub fn verify(&self, caller: &Caller<'_>, now: u64) -> SyncResult<PairingInstance> {
        let state = self.lock();
        let Some(instance) = state.instance else { return fail(SyncCode::WrongWindow) };
        if caller.label != PAIRING_WINDOW || !is_pairing_url(caller.url) || caller.hwnd == 0 || caller.hwnd != instance.hwnd || now >= instance.expires_at {
            super::log::event("pairing-refused", "wrong-window");
            return fail(SyncCode::WrongWindow);
        }
        Ok(instance)
    }

    /// Consomme le jeton de la génération courante (`sync_pairing_payload` sans `renew`).
    pub fn take_token(&self, caller: &Caller<'_>, now: u64) -> SyncResult<PairingInstance> {
        let instance = self.verify(caller, now)?;
        if instance.mode != PairingMode::Show {
            return fail(SyncCode::WrongMode);
        }
        let mut state = self.lock();
        let Some(current) = state.instance.as_mut().filter(|i| i.hwnd == instance.hwnd && i.generation == instance.generation) else {
            return fail(SyncCode::WrongWindow);
        };
        if !current.token {
            return fail(SyncCode::WrongWindow);
        }
        current.token = false;
        Ok(*current)
    }

    /// « Nouveau code » (après une nouvelle confirmation) : génération suivante, nouvelle échéance, jeton consommé aussitôt.
    pub fn renew(&self, caller: &Caller<'_>, generation: u64, now: u64) -> SyncResult<PairingInstance> {
        let mut state = self.lock();
        let Some(current) = state.instance.as_mut().filter(|i| i.hwnd == caller.hwnd && i.generation == generation) else {
            return fail(SyncCode::WrongWindow);
        };
        current.generation += 1;
        current.expires_at = now + PAIRING_VALIDITY_MS;
        current.token = false;
        Ok(*current)
    }

    /// Minuteur d'une génération : `true` (fenêtre à détruire) seulement si cette génération est encore la courante et échue.
    pub fn expire_if_due(&self, hwnd: isize, generation: u64, now: u64) -> bool {
        let state = self.lock();
        state.instance.is_some_and(|i| i.hwnd == hwnd && i.generation == generation && now >= i.expires_at)
    }

    /// Destruction de la fenêtre : jeton et instance effacés.
    pub fn clear(&self, hwnd: isize) {
        let mut state = self.lock();
        if state.instance.is_some_and(|i| i.hwnd == hwnd) {
            state.instance = None;
        }
    }
}
