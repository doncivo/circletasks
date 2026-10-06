//! État publié d'un appareil (`state.ctx`, ADR 0011 section 1.4) et tête de ses propres ajouts (`own.json`).
//!
//! `PublishedState` est le texte clair de l'unique enregistrement de `state.ctx`, sous la forme canonique de
//! `publishedStateToJson` (`format.ts`) : clés dans un ordre fixe, accusés triés par `device_id`, `pairedBy` absent s'il n'est pas
//! connu. Analyse stricte : clés exactes (une clé facultative absente est refusée, sauf `pairedBy`), entiers non signés, noms et hlc
//! stricts, 64 accusés et 64 appareils oubliés au plus, tête dans l'époque annoncée.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::limits::{MAX_STATE_ACKS, MAX_STATE_CLOSED_SEGMENTS, MAX_STATE_FORGOTTEN};
use super::names::{is_app_version, is_epoch_id, is_file_number, is_kid, is_strict_hlc, is_uuid_v4};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn safe(n: u64) -> bool {
    n <= MAX_SAFE_INTEGER
}

/// Accusé de lecture (ou tête publiée).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceAck {
    pub epoch: String,
    pub segment: u64,
    pub record: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub hlc: Option<String>,
    pub state_seq: u64,
}

impl DeviceAck {
    pub fn is_valid(&self) -> bool {
        is_epoch_id(&self.epoch) && safe(self.segment) && safe(self.record) && safe(self.state_seq) && self.hlc.as_deref().map_or(true, is_strict_hlc)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRef {
    pub seq: u64,
    pub end_hlc: String,
}

/// Réservé (Y-10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgottenDevice {
    pub device_id: String,
    pub at: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub last_ack: Option<DeviceAck>,
}

/// Réservé (Y-11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetNotice {
    pub kid: String,
    pub epoch: String,
    pub at: String,
}

/// Y-TECH-02 (ADR 0011 §21 point 2) : segment clos de l'époque courante et nombre d'enregistrements que l'état en annonce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClosedSegment {
    pub segment: u64,
    pub records: u64,
}

/// `closed` valide pour une tête : segments strictement croissants, ≥ 1 et < `head_segment`, `records` ≥ 1, 1 024 au plus.
pub fn closed_is_valid(closed: &[ClosedSegment], head_segment: u64) -> bool {
    closed.len() <= MAX_STATE_CLOSED_SEGMENTS
        && closed.iter().all(|c| c.segment >= 1 && c.segment < head_segment && (1..=MAX_SAFE_INTEGER).contains(&c.records))
        && closed.windows(2).all(|w| w[0].segment < w[1].segment)
}

/// Texte clair de `state.ctx`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedState {
    pub device_id: String,
    pub platform: String,
    pub app_version: String,
    pub sm: u64,
    pub sv: u64,
    pub epoch: String,
    pub state_seq: u64,
    pub head: DeviceAck,
    pub acks: BTreeMap<String, DeviceAck>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub snapshot: Option<SnapshotRef>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub purge_horizon: Option<String>,
    pub last_sync_hlc: String,
    pub forgotten: Vec<ForgottenDevice>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub reset: Option<ResetNotice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_by: Option<String>,
    /// Y-TECH-02 (§21 point 2) : segments clos de `head.epoch` ; absent et `[]` valent liste vide, omis quand il est vide (dernière clé,
    /// même texte que `publishedStateToJson`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub closed: Vec<ClosedSegment>,
}

impl PublishedState {
    /// Analyse stricte d'un texte JSON ; `None` : état mal formé.
    pub fn parse(json: &str) -> Option<Self> {
        let state: PublishedState = serde_json::from_str(json).ok()?;
        state.is_valid().then_some(state)
    }

    /// Mêmes règles que `publishedStateFromJson` (`format.ts`).
    pub fn is_valid(&self) -> bool {
        is_uuid_v4(&self.device_id)
            && (self.platform == "windows" || self.platform == "ios")
            && is_app_version(&self.app_version)
            && (1..=MAX_SAFE_INTEGER).contains(&self.sm)
            && (1..=MAX_SAFE_INTEGER).contains(&self.sv)
            && is_epoch_id(&self.epoch)
            && (1..=MAX_SAFE_INTEGER).contains(&self.state_seq)
            && self.head.is_valid()
            && self.head.epoch == self.epoch
            && self.head.state_seq == self.state_seq
            && self.acks.len() <= MAX_STATE_ACKS
            && self.acks.iter().all(|(id, ack)| is_uuid_v4(id) && ack.is_valid())
            && self.snapshot.as_ref().map_or(true, |s| is_file_number(s.seq) && is_strict_hlc(&s.end_hlc))
            && self.purge_horizon.as_deref().map_or(true, is_strict_hlc)
            && is_strict_hlc(&self.last_sync_hlc)
            && self.paired_by.as_deref().map_or(true, is_uuid_v4)
            && self.forgotten.len() <= MAX_STATE_FORGOTTEN
            && self.forgotten.iter().all(|f| is_uuid_v4(&f.device_id) && is_strict_hlc(&f.at) && f.last_ack.as_ref().map_or(true, DeviceAck::is_valid))
            && self.reset.as_ref().map_or(true, |r| is_kid(&r.kid) && is_epoch_id(&r.epoch) && is_strict_hlc(&r.at))
            && closed_is_valid(&self.closed, self.head.segment)
    }

    /// Texte canonique (même texte que `JSON.stringify(publishedStateToJson(state))`).
    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// `own.json` (section 1.4) : tête de ses propres ajouts, maître des contrôles de `sync_write_state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnState {
    pub folder_id: String,
    pub kid: String,
    pub epoch: Option<String>,
    pub segment: u64,
    pub record: u64,
    pub max_hlc: Option<String>,
    pub state_seq: u64,
    pub paired_by: Option<String>,
    /// Y-TECH-02 (§21 point 2) : segments clos de `epoch` et ce que l'état a pu en annoncer (absent d'un `own.json` antérieur : vide).
    #[serde(default)]
    pub closed: Vec<ClosedSegment>,
}

impl OwnState {
    pub fn empty(folder_id: &str, kid: &str) -> Self {
        Self { folder_id: folder_id.to_owned(), kid: kid.to_owned(), epoch: None, segment: 0, record: 0, max_hlc: None, state_seq: 0, paired_by: None, closed: Vec::new() }
    }

    /// Ferme un segment (rotation dans la même époque) ; au-delà de 1 024 entrées, la plus ancienne est retirée (journal `closed-dropped`,
    /// numéro seulement : ce segment est alors lu selon la règle d'avant).
    pub fn close_segment(&mut self, segment: u64, records: u64) {
        self.closed.push(ClosedSegment { segment, records });
        while self.closed.len() > MAX_STATE_CLOSED_SEGMENTS {
            let dropped = self.closed.remove(0);
            super::log::event("closed-dropped", &dropped.segment.to_string());
        }
    }
}

/// `usage.json` : enregistrements scellés avec la clé (budget de nonces, audit B1).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub kid: String,
    pub sealed: u64,
}
