//! Réinitialisation de la synchronisation avec une nouvelle clé (Y-11 ; ADR 0011 sections 2.2, 9, 9.1, 11.1, 14.3, 14.4 et 18 point 2).
//!
//! - **Registre** `sync/reset.json` (dossier de configuration, `.tmp` + renommage), local à Rust, lié à `folderId` et `deviceId` : rôle
//!   (`initiator` : cet appareil a lancé la réinitialisation ; `joined` : il a importé la nouvelle clé d'un autre), `kid` de la clé
//!   `circletasks.sync.key.next`, époque visée `e<n+1>-<auteur>`, annonce (`reset` publié sous l'ancienne clé, maître : Rust), position de
//!   l'époque `n` (`base`, pour revenir en arrière si la réinitialisation perd), perte constatée (`superseded`) et étape de la bascule.
//!   Jamais de clé : seulement des `kid`, des époques, des positions et des hlc.
//! - **Fonctions pures**, mêmes règles que `epoch.ts` et même table de cas (`tests/fixtures/sync/reset-order.json`) : validité d'une
//!   annonce (`valid_reset`), gagnant de deux réinitialisations simultanées (`reset_winner`), précondition « tout lu jusqu'à la tête »
//!   (`reset_precondition`), appareils pas encore réassociés (`reset_waiting`).
//!
//! Journal technique : `reset-*` (codes, étapes, identifiants d'appareil et d'époque), jamais de clé, de chemin ni de contenu.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::forget::compare_ack_positions;
use super::names::{is_epoch_id, is_kid, is_strict_hlc, is_uuid_v4, EpochId};
use super::state::{DeviceAck, ResetNotice};
use super::store::StateStatus;

/// Registre de la réinitialisation (dossier de configuration `sync/`).
pub const RESET_FILE: &str = "reset.json";
/// Budget de nonces de la nouvelle clé pendant la transition (§2 : la nouvelle clé repart de zéro) ; devient `usage.json` à la bascule.
pub const USAGE_NEXT_FILE: &str = "usage.next.json";

/// Rôle de cet appareil dans la réinitialisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResetRole {
    /// Cet appareil a lancé la réinitialisation (`sync_reset_key`).
    Initiator,
    /// Cet appareil a importé la nouvelle clé d'une réinitialisation lancée ailleurs (`sync_key_import` vers `.next`).
    Joined,
}

impl ResetRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initiator => "initiator",
            Self::Joined => "joined",
        }
    }
}

/// Étape de l'appareil qui réinitialise : clé créée, annonce publiée sous l'ancienne clé, époque `n+1` ouverte sous la nouvelle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResetStage {
    Created,
    Announced,
    Opened,
}

impl ResetStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Announced => "announced",
            Self::Opened => "opened",
        }
    }
}

/// Position de ses propres ajouts dans l'époque `n` (celle de l'annonce, ou de l'import) : `own.json` y revient si la réinitialisation perd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetBase {
    pub epoch: Option<String>,
    pub segment: u64,
    pub record: u64,
    pub max_hlc: Option<String>,
}

/// Perte constatée au scan (§18 point 2) : époque et auteur de l'annonce gagnante (aucune : annonce retirée ou sans effet) ; `done` :
/// les quatre étapes du perdant sont faites ; `restore` : le gagnant est une époque restaurée sous l'ancienne clé (§18 point 16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Superseded {
    pub epoch: Option<String>,
    pub by: Option<String>,
    pub done: bool,
    #[serde(default)]
    pub restore: bool,
}

/// État de l'auteur lu à l'import (seconde revue, point 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorSeen {
    pub state_seq: u64,
    pub epoch: String,
}

/// Dernier état écrit sous l'ancienne clé pendant la réinitialisation (audit 5) : seul état que l'anti-rejeu de soi peut reprendre
/// si la réinitialisation perd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KState {
    pub state_seq: u64,
    pub digest: String,
}

/// `sync/reset.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetRecord {
    pub folder_id: String,
    pub device_id: String,
    pub role: ResetRole,
    /// `kid` de la nouvelle clé (entrée `circletasks.sync.key.next`).
    pub kid: String,
    /// Époque visée `e<n+1>-<auteur>`.
    pub epoch: String,
    /// Auteur de l'annonce (appareil de l'époque visée).
    pub by: String,
    /// Annonce publiée sous l'ancienne clé (`reset` de `state.ctx`) : l'appareil qui réinitialise la fixe ; un appareil réassocié la garde
    /// s'il l'a lue (sinon null : l'auteur a déjà basculé).
    pub notice: Option<ResetNotice>,
    /// Époque de l'état qui porte l'annonce (`n`).
    pub notice_epoch: Option<String>,
    /// `stateSeq` de l'état qui porte l'annonce (revue 1) : un retrait n'est compté que sur un état strictement plus récent.
    #[serde(default)]
    pub notice_seq: Option<u64>,
    /// Dernier état écrit sous l'ancienne clé (audit 5).
    #[serde(default)]
    pub k_state: Option<KState>,
    /// Appareil réassocié : état de l'auteur lu sous l'ancienne clé à l'import (seconde revue, point 3) ; un état plus récent, ou d'une
    /// époque supérieure, sans cette annonce, prouve le retrait même si l'annonce n'a jamais été lue.
    #[serde(default)]
    pub author_at_import: Option<AuthorSeen>,
    pub stage: ResetStage,
    pub base: Option<ResetBase>,
    pub superseded: Option<Superseded>,
    /// Étape de la bascule faite (0 : pas commencée ; 6 : terminée, registre supprimé ensuite).
    #[serde(default)]
    pub switch_step: u8,
}

impl ResetRecord {
    /// Schéma : noms et formats stricts ; sinon le registre est illisible (`io`), jamais traité comme absent.
    pub fn is_valid(&self) -> bool {
        is_uuid_v4(&self.device_id)
            && is_kid(&self.kid)
            && EpochId::parse(&self.epoch).is_some_and(|e| e.opener == self.by)
            && is_uuid_v4(&self.by)
            && self.notice.as_ref().map_or(true, |n| is_kid(&n.kid) && is_epoch_id(&n.epoch) && is_strict_hlc(&n.at))
            && self.notice_epoch.as_deref().map_or(true, is_epoch_id)
            && self.k_state.as_ref().map_or(true, |k| k.digest.len() == 64 && k.digest.bytes().all(|b| b.is_ascii_hexdigit()))
            && self.author_at_import.as_ref().map_or(true, |a| is_epoch_id(&a.epoch))
            && self.base.as_ref().map_or(true, |b| b.epoch.as_deref().map_or(true, is_epoch_id) && b.max_hlc.as_deref().map_or(true, is_strict_hlc))
            && self.superseded.as_ref().map_or(true, |s| s.epoch.as_deref().map_or(true, is_epoch_id) && s.by.as_deref().map_or(true, is_uuid_v4))
            && self.switch_step <= 6
    }

    /// Réinitialisation en cours (ni perdue, ni terminée).
    pub fn active(&self) -> bool {
        self.superseded.is_none()
    }

    /// Candidat de cette réinitialisation pour le calcul du gagnant (annonce connue seulement).
    pub fn candidate(&self) -> Option<ResetCandidate> {
        Some(ResetCandidate { by: self.by.clone(), state_epoch: self.notice_epoch.clone()?, notice: self.notice.clone()?, restore: false })
    }
}

/// Annonce lue (§11.2 `ResetCandidate`) : auteur (appareil dont l'état la porte), époque de cet état, annonce. `restore` (§18 point
/// 16) : époque ouverte sous l'ancienne clé (restauration « Appliquer partout »), qui concourt avec les annonces ; `notice.epoch` est
/// alors l'époque ouverte, `notice.kid` et `notice.at` sont vides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCandidate {
    pub by: String,
    pub state_epoch: String,
    pub notice: ResetNotice,
    #[serde(default)]
    pub restore: bool,
}

/// Validité d'une annonce (§14.3) : époque `e<m>-<auteur>` strictement supérieure à l'époque de l'état qui la porte ; `kid`, hlc et
/// auteur bien formés (époque restaurée : ouvreur et époque seulement). Même fonction que `validReset`.
pub fn valid_reset(candidate: &ResetCandidate) -> bool {
    let (Some(target), Some(state)) = (EpochId::parse(&candidate.notice.epoch), EpochId::parse(&candidate.state_epoch)) else { return false };
    is_uuid_v4(&candidate.by) && target.opener == candidate.by && target > state && (candidate.restore || (is_kid(&candidate.notice.kid) && is_strict_hlc(&candidate.notice.at)))
}

/// État `ok` sous l'ancienne clé vu pour les époques restaurées (§18 point 16) : auteur, époque, instantané annoncé, annonce portée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedEpoch {
    pub by: String,
    pub epoch: String,
    pub snapshot: bool,
    pub notice: bool,
}

/// Époques ouvertes sous l'ancienne clé qui concourent avec les annonces (§18 point 16, complément 1) : état sans annonce, instantané
/// annoncé, ouvreur = auteur, époque supérieure à celle de l'état qui porte une annonce. Aucune annonce : aucune. Même fonction que
/// `restoreCandidates`.
pub fn restore_candidates(states: &[OpenedEpoch], announcements: &[ResetCandidate]) -> Vec<ResetCandidate> {
    let bases: Vec<EpochId> = announcements.iter().filter(|a| !a.restore && valid_reset(a)).filter_map(|a| EpochId::parse(&a.state_epoch)).collect();
    let Some(base) = bases.into_iter().min() else { return Vec::new() };
    states
        .iter()
        .filter(|s| !s.notice && s.snapshot)
        .filter(|s| EpochId::parse(&s.epoch).is_some_and(|e| e.opener == s.by && e > base))
        .map(|s| ResetCandidate { by: s.by.clone(), state_epoch: base.name(), notice: ResetNotice { kid: String::new(), epoch: s.epoch.clone(), at: String::new() }, restore: true })
        .collect()
}

/// Gagnant de réinitialisations simultanées (§18 point 2) : l'annonce valide d'un auteur non oublié dont l'époque est la plus grande (ordre
/// de la section 9 : numéro, puis UUID), sans autre critère (ni `kid` ni `at`) ; à époque égale, la première rencontrée (cas impossible
/// après l'anti-rejeu, gardé déterministe). Même fonction que `resetWinner`.
pub fn reset_winner<'a>(candidates: &'a [ResetCandidate], forgotten: &BTreeSet<String>) -> Option<&'a ResetCandidate> {
    let mut best: Option<(&ResetCandidate, EpochId)> = None;
    for candidate in candidates {
        if !valid_reset(candidate) || forgotten.contains(&candidate.by) {
            continue;
        }
        let Some(epoch) = EpochId::parse(&candidate.notice.epoch) else { continue };
        if best.as_ref().map_or(true, |(_, b)| epoch.cmp(b) == Ordering::Greater) {
            best = Some((candidate, epoch));
        }
    }
    best.map(|(c, _)| c)
}

/// Raison d'un refus de la précondition (« Synchronisez d'abord ») : état illisible, tête pas lue, oublié pas lu jusqu'à sa coupure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LagReason {
    State,
    Head,
    Cutoff,
}

impl LagReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Head => "head",
            Self::Cutoff => "cutoff",
        }
    }
}

/// Appareil actif vu par la précondition : statut de son état, tête publiée, expiré (180 jours), fantôme (jamais vu, Y-10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreconditionDevice {
    pub device_id: String,
    pub status: StateStatus,
    pub head: Option<DeviceAck>,
    pub expired: bool,
    pub phantom: bool,
}

/// Oublié retenu et sa coupure (Y-10) : l'ouvreur l'a lu jusque-là (dette « instantané d'ouverture », piste appliquée par Y-11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgottenCut {
    pub device_id: String,
    pub cutoff: Option<DeviceAck>,
}

/// Précondition de `sync_reset_key` (§14.3 étape 1, second audit point 1) : chaque appareil actif (ni expiré, ni oublié, ni fantôme) a un
/// état authentifié et ses accusés publiés par cet appareil (`own_acks`) atteignent sa tête ; chaque oublié retenu est lu jusqu'à sa
/// coupure. Premier appareil en retard (ordre des identifiants, actifs d'abord) ; `None` : la réinitialisation peut commencer. Même
/// fonction que `resetPrecondition`.
pub fn reset_precondition(actives: &[PreconditionDevice], forgotten: &[ForgottenCut], own_acks: &BTreeMap<String, DeviceAck>) -> Option<(String, LagReason)> {
    let mut sorted: Vec<&PreconditionDevice> = actives.iter().collect();
    sorted.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    for device in sorted {
        if device.expired || device.phantom {
            continue;
        }
        if device.status != StateStatus::Ok {
            return Some((device.device_id.clone(), LagReason::State));
        }
        let Some(head) = &device.head else { continue };
        if head.segment == 0 && head.record == 0 {
            continue;
        }
        let read = own_acks.get(&device.device_id).is_some_and(|ack| ack.epoch == head.epoch && compare_ack_positions(ack, head) != Ordering::Less);
        if !read {
            return Some((device.device_id.clone(), LagReason::Head));
        }
    }
    let mut cuts: Vec<&ForgottenCut> = forgotten.iter().collect();
    cuts.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    for cut in cuts {
        let Some(limit) = &cut.cutoff else { continue };
        if own_acks.get(&cut.device_id).map_or(true, |ack| compare_ack_positions(ack, limit) == Ordering::Less) {
            return Some((cut.device_id.clone(), LagReason::Cutoff));
        }
    }
    None
}

/// Appareil connu vu pendant la transition : statut et époque de l'état présenté, vu (anti-rejeu ou accusé d'un actif), auteur d'une
/// déclaration d'oubli.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetKnown {
    pub device_id: String,
    pub status: StateStatus,
    pub epoch: Option<String>,
    /// `kid` de l'en-tête de l'état présenté (audit 4) : seule la nouvelle clé compte.
    pub kid: Option<String>,
    pub seen: bool,
    pub author: bool,
}

/// Appareils pas encore réassociés (§14.3 étape 5) : connus, ni soi, ni oubliés, ni fantômes (Y-10 : jamais vus, état illisible), dont
/// l'état présenté n'est pas un état authentifié de l'époque visée sous la nouvelle clé (`kid`, audit 4). Triés. Vide : la bascule peut
/// se faire. Même fonction que `resetWaiting`.
pub fn reset_waiting(known: &[ResetKnown], self_id: &str, epoch: &str, kid: &str, forgotten: &BTreeSet<String>) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for device in known {
        if device.device_id == self_id || forgotten.contains(&device.device_id) {
            continue;
        }
        if device.status != StateStatus::Ok && !device.seen && !device.author {
            continue;
        }
        if device.status == StateStatus::Ok && device.epoch.as_deref() == Some(epoch) && device.kid.as_deref() == Some(kid) {
            continue;
        }
        out.insert(device.device_id.clone());
    }
    out.into_iter().collect()
}

/// Accusés sans objet (remarques finales ; même fonction que `withoutStaleAcks`, table `reset-order.json`) : un accusé sur une cible
/// situé après la plus récente époque d'un état lisible et accepté de cette cible ne désigne rien et ne compte dans aucune coupure.
pub fn without_stale_acks(ackers: &mut [(String, BTreeMap<String, DeviceAck>)], published: &BTreeMap<String, EpochId>) {
    for (_, acks) in ackers.iter_mut() {
        acks.retain(|target, ack| published.get(target).map_or(true, |last| EpochId::parse(&ack.epoch).map_or(true, |e| e <= *last)));
    }
}
