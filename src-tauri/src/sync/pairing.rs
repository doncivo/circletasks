//! Fenêtre dédiée `pairing` (ADR 0011 sections 2.1 et 10.3 ; Y-08 critères 12 et 13).
//!
//! La fenêtre n'est jamais déclarée dans `tauri.conf.json` : Rust la crée (`commands.rs`), masquée, avec l'URL fixe `pairing.html`,
//! lui applique `WDA_EXCLUDEFROMCAPTURE` avant de l'afficher et mémorise l'**instance** (HWND, mode, génération). Ce registre, sans
//! dépendance à Tauri, porte les règles testées :
//! - une instance n'est jamais réutilisée (`open` refuse un libellé occupé) ;
//! - chaque appel de la fenêtre est vérifié : libellé `pairing`, URL exacte, HWND de l'instance, sinon `wrong-window` ;
//! - le mode est lié à l'instance (`wrong-mode`) ;
//! - le jeton de consentement est à usage unique, lié à l'instance et à la génération ;
//! - un seul minuteur de 5 minutes par génération : celui d'une génération remplacée est sans effet ;
//! - arrivée de l'appareil associé (Y-06 critère 9) : l'appareil dont l'état authentifié porte `pairedBy` = ce PC et qui n'était pas
//!   déjà là au premier scan de l'instance `show` ferme la fenêtre.
//!
//! Les décisions prises par `commands.rs` autour de la vraie fenêtre (événements, surveillance, affinité d'affichage) sont des
//! fonctions pures de ce module (Y-06 critère 18 a), testées sans fenêtre.

use std::collections::BTreeSet;
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

/// La page `pairing.html` est-elle dans les actifs embarqués, sous ce nom exact ? On parcourt les clés des actifs, sans passer par le
/// résolveur (qui se replie sur `index.html`) ni comparer des octets (audit A2). Sans elle, `sync_pairing_open` refuse (`io`) avant
/// toute boîte et toute fenêtre : jamais l'application entière dans la fenêtre qui reçoit la clé.
pub fn pairing_page_listed<'a>(mut keys: impl Iterator<Item = &'a str>) -> bool {
    keys.any(|key| key.strip_prefix('/').unwrap_or(key) == PAIRING_PAGE)
}

/// Marqueur porté par `pairing.html` (`<html data-ct-page="pairing">`) et par aucune autre page : le serveur Vite répond `index.html`
/// (l'application entière) à une page absente, un code 200 ne prouve donc rien (Y-06 D2).
pub const PAIRING_PAGE_MARKER: &str = "data-ct-page=\"pairing\"";

/// Taille lue au plus dans la réponse du serveur de développement.
#[cfg(debug_assertions)]
const DEV_PAGE_MAX_BYTES: u64 = 512 * 1024;

/// Développement avec `devUrl` (dette « contrôle de `pairing.html` sauté en debug », soldée par Y-06) : `GET /pairing.html` au serveur
/// Vite local, réponse 200 qui contient le marqueur de la page exigée. Hôte de bouclage seulement ; aucune dépendance (requête HTTP/1.1
/// écrite à la main). Ce code n'existe pas en production, où seules les clés des actifs embarqués comptent.
#[cfg(debug_assertions)]
pub fn dev_page_has_marker(host: &str, port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    if !matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") {
        return false;
    }
    let target = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(addrs) = (target, port).to_socket_addrs() else { return false };
    for addr in addrs.filter(|a| a.ip().is_loopback()) {
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let request = format!("GET /{PAIRING_PAGE} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = Vec::new();
        let _ = stream.take(DEV_PAGE_MAX_BYTES).read_to_end(&mut response);
        return dev_response_is_pairing_page(&response);
    }
    false
}

/// Réponse HTTP du serveur de développement : statut 200 et marqueur de la page `pairing` dans le corps.
#[cfg(debug_assertions)]
pub fn dev_response_is_pairing_page(response: &[u8]) -> bool {
    let text = String::from_utf8_lossy(response);
    let Some((head, body)) = text.split_once("\r\n\r\n") else { return false };
    let status_ok = head.lines().next().is_some_and(|line| {
        let mut parts = line.split_whitespace();
        parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) && parts.next() == Some("200")
    });
    status_ok && body.contains(PAIRING_PAGE_MARKER)
}

// ------------------------------------------------------------------------------------------------------------------------------
// Décisions autour de la vraie fenêtre (Y-06 critère 18 a)
// ------------------------------------------------------------------------------------------------------------------------------

/// Événement de la fenêtre `pairing` vu par Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingWindowEvent {
    /// Croix de la barre de titre, Alt+F4.
    CloseRequested,
    /// Fenêtre détruite.
    Destroyed,
    /// Tout autre événement (focus, déplacement…).
    Other,
}

/// Réaction à un événement de la fenêtre.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingWindowAction {
    /// Fermeture native empêchée, puis **destruction** (jamais un simple masquage) : instance et jeton effacés.
    PreventAndDestroy,
    /// Instance et jeton effacés (la fenêtre n'existe plus).
    Clear,
    Ignore,
}

pub fn pairing_window_action(event: PairingWindowEvent) -> PairingWindowAction {
    match event {
        PairingWindowEvent::CloseRequested => PairingWindowAction::PreventAndDestroy,
        PairingWindowEvent::Destroyed => PairingWindowAction::Clear,
        PairingWindowEvent::Other => PairingWindowAction::Ignore,
    }
}

/// Après la création masquée : la fenêtre n'est affichée que si son HWND est connu et si `SetWindowDisplayAffinity` a réussi ; sinon
/// elle est détruite et rien n'est renvoyé (`io`).
pub fn affinity_outcome(hwnd: isize, excluded: bool) -> SyncResult<()> {
    if hwnd == 0 || !excluded {
        return fail(SyncCode::Io);
    }
    Ok(())
}

/// Ce que la surveillance (toutes les 500 ms) voit de `main` et de l'instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchInput {
    /// `main` existe, est visible et n'est pas réduite.
    pub main_shown: bool,
    /// La génération courante de l'instance est échue.
    pub expired: bool,
}

/// Décision de la surveillance : détruire la fenêtre (raison journalisée), ou continuer.
pub fn watch_decision(input: WatchInput) -> Option<&'static str> {
    if !input.main_shown {
        Some("main-hidden")
    } else if input.expired {
        Some("expired")
    } else {
        None
    }
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
    /// Appareils déjà associés par ce PC au premier scan de l'instance `show` (None : pas encore de scan). Un appareil déjà associé qui
    /// se synchronise pendant l'affichage ne ferme pas la fenêtre ; seul un nouvel arrivant la ferme.
    paired_baseline: Option<BTreeSet<String>>,
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
            return fail(SyncCode::AlreadyOpen);
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
        state.paired_baseline = None;
        instance
    }

    /// Référence d'arrivée (audit 2, QA 3) : identifiants listés dans `devices/` à l'ouverture de l'instance, quel que soit leur état
    /// (`state.ctx` dans le nuage, illisible…). Posée par `sync_pairing_open` avant l'affichage.
    pub fn set_arrival_baseline(&self, hwnd: isize, listed: Vec<String>) {
        let mut state = self.lock();
        if state.instance.is_some_and(|i| i.hwnd == hwnd) {
            state.paired_baseline = Some(listed.into_iter().collect());
        }
    }

    /// Scan du dossier pendant la vie d'une instance `show` (Y-06 critère 9) : `paired` = appareils dont l'état **authentifié** porte
    /// `pairedBy` = ce PC. Un appareil absent de la référence prise à l'ouverture est celui qui vient de s'associer : l'instance est
    /// effacée et son HWND renvoyé (fenêtre à détruire, une seule fois). Repli si la liste d'ouverture n'a pas pu être lue : le premier
    /// scan fixe la référence. Instance `import` ou absente : rien.
    pub fn observe_paired(&self, paired: &[String]) -> Option<isize> {
        let mut state = self.lock();
        let instance = state.instance.filter(|i| i.mode == PairingMode::Show)?;
        let arrived = match &state.paired_baseline {
            None => {
                state.paired_baseline = Some(paired.iter().cloned().collect());
                false
            }
            Some(baseline) => paired.iter().any(|id| !baseline.contains(id)),
        };
        if !arrived {
            return None;
        }
        state.instance = None;
        state.paired_baseline = None;
        super::log::event("pairing-arrival", "paired");
        Some(instance.hwnd)
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
            state.paired_baseline = None;
        }
    }
}
