//! Oubli d'un appareil (Y-10 ; ADR 0011 sections 1.1, 1.4, 11.1, 14.2 et 18).
//!
//! - `sync/forgotten.json` (dossier de configuration, `.tmp` + renommage) : déclarations faites **par cet appareil**, dans l'ordre où
//!   elles ont été confirmées ; Rust est le seul maître de la liste `forgotten` publiée (`sync_write_state` la compare). Le fichier est
//!   lié au dossier et à l'appareil (`folderId`, `deviceId`) : un fichier d'un autre dossier ou d'une autre identité est traité comme
//!   absent et la liste est reconstruite depuis son propre `state.ctx` **authentifié** (un oubli ne décroît jamais).
//! - `forget_order`, `cutoff`, `forgotten_delete_check` : fonctions pures, **mêmes règles que `retention.ts`** (`forgetOrder`, `cutoff`,
//!   `forgottenDeleteCheck`), vérifiées sur la même table de cas (`tests/fixtures/sync/forget-order.json`).
//! - `next_declaration_hlc` : hlc d'une déclaration, postérieur à tout hlc authentifié connu de Rust (une déclaration faite après avoir
//!   lu celle d'un autre appareil vient après elle dans l'ordre total).
//!
//! Journal technique : `forget-declared`, `forgotten-delete` (identifiants d'appareil, nombres), jamais de chemin ni de contenu.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::names::{is_strict_hlc, EpochId};
use super::state::{DeviceAck, ForgottenDevice, PublishedState};
use super::store::StateStatus;
use super::SyncCode;

/// Déclarations faites par cet appareil (dossier de configuration `sync/`).
pub const FORGOTTEN_FILE: &str = "forgotten.json";
/// Entrée du coffre réservée à la réinitialisation (Y-11, section 14.3) : sa présence signale une réinitialisation en cours.
pub const SYNC_NEXT_KEY_ACCOUNT: &str = "circletasks.sync.key.next";
/// Entrées supprimées au plus par appel de `sync_forgotten_delete` (le cycle suivant continue).
pub const MAX_FORGOTTEN_DELETE_ENTRIES: usize = 10_000;

/// `sync/forgotten.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgottenFile {
    pub folder_id: String,
    pub device_id: String,
    pub entries: Vec<ForgottenDevice>,
}

/// Oubli retenu par l'ordre total : auteur de la déclaration valide et son hlc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub by: String,
    pub at: String,
}

/// Déclaration lue dans l'état authentifié de `by`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    pub by: String,
    pub entry: ForgottenDevice,
}

/// Appareil d'un hlc strict (après le 21e caractère).
fn hlc_device(hlc: &str) -> &str {
    hlc.get(21..).unwrap_or("")
}

/// Ordre total des oublis (section 14.2) : tri par `at`, puis auteur, puis cible ; déclaration sans effet si son auteur ou sa cible
/// sont déjà oubliés, si elle vise son auteur ou si son hlc n'est pas celui de son auteur. Même fonction que `forgetOrder`.
pub fn forget_order(declarations: &[Declaration]) -> BTreeMap<String, Verdict> {
    let mut sorted: Vec<&Declaration> = declarations.iter().collect();
    sorted.sort_by(|a, b| a.entry.at.cmp(&b.entry.at).then_with(|| a.by.cmp(&b.by)).then_with(|| a.entry.device_id.cmp(&b.entry.device_id)));
    let mut forgotten: BTreeMap<String, Verdict> = BTreeMap::new();
    for d in sorted {
        if d.entry.device_id == d.by || !is_strict_hlc(&d.entry.at) || hlc_device(&d.entry.at) != d.by {
            continue;
        }
        if forgotten.contains_key(&d.by) || forgotten.contains_key(&d.entry.device_id) {
            continue;
        }
        forgotten.insert(d.entry.device_id.clone(), Verdict { by: d.by.clone(), at: d.entry.at.clone() });
    }
    forgotten
}

/// Ordre des positions d'accusé : époque (section 9), segment, enregistrement. Une époque illisible passe avant les autres.
pub fn compare_ack_positions(a: &DeviceAck, b: &DeviceAck) -> Ordering {
    EpochId::parse(&a.epoch).cmp(&EpochId::parse(&b.epoch)).then(a.segment.cmp(&b.segment)).then(a.record.cmp(&b.record))
}

fn compare_acks(a: &DeviceAck, b: &DeviceAck) -> Ordering {
    compare_ack_positions(a, b).then_with(|| a.hlc.cmp(&b.hlc)).then(a.state_seq.cmp(&b.state_seq))
}

/// Coupure d'un appareil oublié : maximum des accusés de `target` publiés par `ackers` (appareils actifs non oubliés). Même fonction
/// que `cutoff` de `retention.ts`.
pub fn cutoff<'a>(target: &str, ackers: impl IntoIterator<Item = (&'a str, &'a BTreeMap<String, DeviceAck>)>) -> Option<DeviceAck> {
    let mut best: Option<&DeviceAck> = None;
    for (id, acks) in ackers {
        if id == target {
            continue;
        }
        if let Some(ack) = acks.get(target) {
            if best.map_or(true, |b| compare_acks(ack, b) == Ordering::Greater) {
                best = Some(ack);
            }
        }
    }
    best.cloned()
}

/// Ce que la vérification retient d'un état authentifié.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownState {
    pub state_seq: u64,
    pub acks: BTreeMap<String, DeviceAck>,
    pub forgotten: Vec<ForgottenDevice>,
}

impl From<&PublishedState> for KnownState {
    fn from(state: &PublishedState) -> Self {
        Self { state_seq: state.state_seq, acks: state.acks.clone(), forgotten: state.forgotten.clone() }
    }
}

/// Appareil connu (dossier de `devices/`, appareil cité dans un accusé authentifié, cible d'une déclaration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownDevice {
    pub device_id: String,
    pub status: StateStatus,
    pub state: Option<KnownState>,
}

/// Résultat de `forgotten_delete_check` (même forme que `ForgottenDeleteCheck` de `retention.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteCheck {
    Ready { by: String, cutoff: Option<DeviceAck> },
    Waiting { device: String, code: SyncCode },
    Refused(SyncCode),
}

/// Conditions (d) à (f) de la suppression des fichiers de `target` (section 14.2) : déclaration valide selon l'ordre total, appareil
/// local non oublié, chaque actif (non oublié, `expired` compris) lisible, à jour de la coupure, et ayant accusé l'état de l'auteur.
pub fn forgotten_delete_check(target: &str, self_id: &str, known: &[KnownDevice]) -> DeleteCheck {
    if target == self_id {
        return DeleteCheck::Refused(SyncCode::BadName);
    }
    let mut devices: BTreeMap<&str, &KnownDevice> = BTreeMap::new();
    for d in known {
        devices.entry(d.device_id.as_str()).or_insert(d);
    }
    let missing_self = KnownDevice { device_id: self_id.to_owned(), status: StateStatus::Missing, state: None };
    devices.entry(self_id).or_insert(&missing_self);
    let mut declarations = Vec::new();
    for (id, d) in &devices {
        if let (StateStatus::Ok, Some(state)) = (d.status, &d.state) {
            declarations.extend(state.forgotten.iter().map(|entry| Declaration { by: (*id).to_owned(), entry: entry.clone() }));
        }
    }
    let order = forget_order(&declarations);
    let Some(verdict) = order.get(target) else { return DeleteCheck::Refused(SyncCode::StateMismatch) };
    if order.contains_key(self_id) {
        return DeleteCheck::Refused(SyncCode::StateMismatch);
    }
    let mut states: BTreeMap<&str, &KnownState> = BTreeMap::new();
    for (id, d) in devices.iter().filter(|(id, _)| !order.contains_key(**id)) {
        match (d.status, &d.state) {
            (StateStatus::Ok, Some(state)) => {
                states.insert(id, state);
            }
            (StateStatus::CloudPending, _) => return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::CloudPending },
            _ => return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch },
        }
    }
    let cut = cutoff(target, states.iter().map(|(id, s)| (*id, &s.acks)));
    if let Some(cut) = &cut {
        for (id, state) in &states {
            if state.acks.get(target).map_or(true, |ack| compare_ack_positions(ack, cut) == Ordering::Less) {
                return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch };
            }
        }
    }
    let Some(author) = states.get(verdict.by.as_str()) else { return DeleteCheck::Refused(SyncCode::StateMismatch) };
    for (id, state) in &states {
        if *id == verdict.by {
            continue;
        }
        if state.acks.get(&verdict.by).map_or(true, |ack| ack.state_seq < author.state_seq) {
            return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch };
        }
    }
    DeleteCheck::Ready { by: verdict.by.clone(), cutoff: cut }
}

/// Appareils oubliés selon les états authentifiés (`ok`) donnés.
pub fn forgotten_by_states<'a>(states: impl IntoIterator<Item = (&'a str, &'a PublishedState)>) -> BTreeMap<String, Verdict> {
    let declarations: Vec<Declaration> = states
        .into_iter()
        .flat_map(|(id, s)| s.forgotten.iter().map(move |entry| Declaration { by: id.to_owned(), entry: entry.clone() }))
        .collect();
    forget_order(&declarations)
}

fn split_hlc(hlc: &str) -> Option<(u64, u32)> {
    if !is_strict_hlc(hlc) {
        return None;
    }
    Some((hlc.get(..15)?.parse().ok()?, u32::from_str_radix(hlc.get(16..20)?, 16).ok()?))
}

/// hlc d'une nouvelle déclaration de `self_id` : après `now_ms` et après tout hlc de `seen` (règle d'envoi d'une horloge hybride).
pub fn next_declaration_hlc<'a>(now_ms: u64, seen: impl IntoIterator<Item = &'a str>, self_id: &str) -> String {
    let max = seen.into_iter().filter_map(split_hlc).max();
    let (ms, counter) = match max {
        Some((ms, counter)) if ms >= now_ms => {
            if counter >= 0xffff {
                (ms + 1, 0)
            } else {
                (ms, counter + 1)
            }
        }
        _ => (now_ms, 0),
    };
    format!("{ms:015}-{counter:04x}-{self_id}")
}

/// hlc connus d'un état authentifié (dernier cycle, tête, accusés, déclarations).
pub fn state_hlcs(state: &PublishedState) -> Vec<&str> {
    let mut out: Vec<&str> = vec![state.last_sync_hlc.as_str()];
    out.extend(state.head.hlc.as_deref());
    out.extend(state.acks.values().filter_map(|a| a.hlc.as_deref()));
    out.extend(state.forgotten.iter().map(|f| f.at.as_str()));
    out
}

/// Liste publiée par le moteur comparée à celle de Rust (section 1.4, lot Y4) : égale, ou **préfixe** de celle de Rust (déclarations
/// confirmées et pas encore publiées : Rust complète, comme `pairedBy`). Toute autre différence (entrée modifiée, retirée, ajoutée par la
/// WebView, ordre changé) : `None` (`state-mismatch`).
pub fn completed_forgotten(published: &[ForgottenDevice], master: &[ForgottenDevice]) -> Option<Vec<ForgottenDevice>> {
    (published.len() <= master.len() && master[..published.len()] == *published).then(|| master.to_vec())
}

/// Identifiants cités dans les accusés d'états authentifiés et cibles de leurs déclarations.
pub fn cited_devices<'a>(states: impl IntoIterator<Item = &'a PublishedState>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for s in states {
        out.extend(s.acks.keys().cloned());
        out.extend(s.forgotten.iter().map(|f| f.device_id.clone()));
    }
    out
}
