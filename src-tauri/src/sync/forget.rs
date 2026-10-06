//! Oubli d'un appareil (Y-10 ; ADR 0011 sections 1.1, 1.4, 11.1, 14.2 et 18 points 3 à 10).
//!
//! - **Registre** `sync/forgotten.json` (dossier de configuration, `.tmp` + renommage), lié à `folderId` et `deviceId`, qui **ne fait que
//!   grandir** : `entries` (liste maître : ses déclarations et toutes les déclarations bien formées **retenues** lues dans un état
//!   authentifié, dans l'ordre d'apprentissage, 64 au plus), `accepted` (anti-rejeu persistant `(epoch, stateSeq, digest)` par appareil),
//!   `done` (appareils oubliés terminés). Chaque appareil republie la liste maître entière dans son `state.ctx`.
//! - Auteur d'une déclaration = appareil de son hlc `at`, jamais l'appareil qui la publie.
//! - `forget_order`, `learn_declarations`, `cutoff`, `forgotten_delete_check`, `completed_forgotten`, `next_declaration_hlc` : fonctions
//!   pures, **mêmes règles que `retention.ts`**, vérifiées sur la même table de cas (`tests/fixtures/sync/forget-order.json`).
//!
//! Journal technique : `forget-declared`, `forgotten-delete`, `forgotten-overflow`, `forgotten-delete-phantom` (identifiants d'appareil,
//! nombres), jamais de chemin ni de contenu.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::names::{is_epoch_id, is_strict_hlc, is_uuid_v4, EpochId};
use super::state::{DeviceAck, ForgottenDevice, PublishedState};
use super::store::StateStatus;
use super::SyncCode;

/// Registre de l'oubli (dossier de configuration `sync/`).
pub const FORGOTTEN_FILE: &str = "forgotten.json";
/// Entrée du coffre réservée à la réinitialisation (Y-11, section 14.3) : sa présence signale une réinitialisation en cours.
pub const SYNC_NEXT_KEY_ACCOUNT: &str = "circletasks.sync.key.next";
/// Déclarations gardées au plus dans la liste maître (borne de `forgotten`, section 1.6).
pub const MAX_FORGOTTEN_ENTRIES: usize = 64;
/// Une déclaration locale est refusée (`too-large`, avant la boîte) dès que la liste maître en compte autant (§18 point 5).
pub const FORGET_DECLARE_LIMIT: usize = 48;
/// Entrées supprimées au plus par appel de `sync_forgotten_delete` (revue Y-10, suggestion 13) : 1 000, bien sous la borne de 10 000 de
/// l'ADR, pour que le verrou du service ne soit jamais tenu plus de quelques secondes (suppressions iCloud lentes) ; le cycle suivant
/// continue (`complete: false`).
pub const MAX_FORGOTTEN_DELETE_ENTRIES: usize = 1_000;

/// Dernier état accepté d'un appareil, persisté (anti-rejeu de la section 1.4 qui survit au redémarrage, §18 point 8 b).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedRecord {
    pub epoch: String,
    pub state_seq: u64,
    pub digest: String,
}

/// `sync/forgotten.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgottenRegistry {
    pub folder_id: String,
    pub device_id: String,
    pub entries: Vec<ForgottenDevice>,
    #[serde(default)]
    pub accepted: BTreeMap<String, AcceptedRecord>,
    #[serde(default)]
    pub done: Vec<String>,
    /// Arrêt définitif (§18 point 12) : hlc de la déclaration qui a oublié cet appareil, posé au premier scan qui le constate ; ne
    /// s'efface jamais pour ce dossier et cette identité, même si le verdict change ensuite.
    #[serde(default)]
    pub self_forgotten: Option<String>,
}

impl ForgottenRegistry {
    pub fn empty(folder_id: &str, device_id: &str) -> Self {
        Self { folder_id: folder_id.to_owned(), device_id: device_id.to_owned(), entries: Vec::new(), accepted: BTreeMap::new(), done: Vec::new(), self_forgotten: None }
    }

    /// Pose `self_forgotten` si l'ordre total oublie cet appareil (jamais effacé) ; vrai s'il vient d'être posé.
    pub fn note_self_forgotten(&mut self) -> bool {
        if self.self_forgotten.is_some() {
            return false;
        }
        let Some(verdict) = forget_order(&self.entries).remove(&self.device_id) else { return false };
        self.self_forgotten = Some(verdict.at);
        true
    }

    /// Schéma : au plus 64 entrées, chacune au format de `state.rs` ; anti-rejeu et terminés bien formés. Sinon le registre est
    /// illisible (`io`), jamais traité comme absent (§18 point 7).
    pub fn is_valid(&self) -> bool {
        self.entries.len() <= MAX_FORGOTTEN_ENTRIES
            && self.entries.iter().all(|f| is_uuid_v4(&f.device_id) && is_strict_hlc(&f.at) && f.last_ack.as_ref().map_or(true, DeviceAck::is_valid))
            && self.accepted.iter().all(|(id, a)| is_uuid_v4(id) && is_epoch_id(&a.epoch) && a.digest.len() == 64 && a.digest.bytes().all(|b| b.is_ascii_hexdigit()))
            && self.done.iter().all(|id| is_uuid_v4(id))
            && self.self_forgotten.as_deref().map_or(true, is_strict_hlc)
    }

    /// Vue rendue par `sync_scan` (`FolderScan.forgotten`).
    pub fn view(&self, overflow: bool) -> ForgottenView {
        ForgottenView { entries: self.entries.clone(), done: self.done.clone(), overflow, accepted: self.accepted.keys().cloned().collect(), self_forgotten: self.self_forgotten.clone() }
    }
}

/// `FolderScan.forgotten` (`ForgottenRegistryView` de `types.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ForgottenView {
    pub entries: Vec<ForgottenDevice>,
    pub done: Vec<String>,
    pub overflow: bool,
    /// Identifiants de l'anti-rejeu du registre (identifiants seuls) : base de `seen_devices` chez le moteur (revue point 4).
    pub accepted: Vec<String>,
    /// Arrêt définitif de cet appareil (§18 point 12) : hlc de la déclaration constatée, jamais effacé.
    #[serde(rename = "selfForgotten")]
    pub self_forgotten: Option<String>,
}

/// Enregistrement de fin d'instantané (`snap-end`, section 5.1) : `covers` s'il est bien formé et de l'époque attendue.
pub fn parse_snapshot_end(json: &str, epoch: &str) -> Option<BTreeMap<String, DeviceAck>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct End {
        k: String,
        count: u64,
        covers: BTreeMap<String, DeviceAck>,
        epoch: String,
        sv: u64,
    }
    let end: End = serde_json::from_str(json).ok()?;
    let well_formed = end.k == "snap-end" && end.epoch == epoch && end.count <= MAX_SAFE_COUNT && end.sv > 0;
    (well_formed && end.covers.iter().all(|(id, a)| is_uuid_v4(id) && a.is_valid())).then_some(end.covers)
}

const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;

/// Oubli retenu par l'ordre total : auteur de la déclaration (appareil de son hlc) et son hlc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub by: String,
    pub at: String,
}

/// Auteur d'une déclaration : appareil du hlc `at` ; `None` si `at` n'est pas strict.
pub fn declaration_author(entry: &ForgottenDevice) -> Option<&str> {
    is_strict_hlc(&entry.at).then(|| entry.at.get(21..)).flatten()
}

/// Bien formée : `at` strict, cible au format strict, auteur différent de la cible.
pub fn is_well_formed(entry: &ForgottenDevice) -> bool {
    declaration_author(entry).is_some_and(|author| author != entry.device_id) && is_uuid_v4(&entry.device_id)
}

/// Ordre total des oublis (section 14.2) sur une liste de déclarations : tri par `at` puis cible ; sans effet si mal formée, si son
/// auteur ou sa cible est déjà oublié. Même fonction que `forgetOrder`.
pub fn forget_order(entries: &[ForgottenDevice]) -> BTreeMap<String, Verdict> {
    let mut sorted: Vec<&ForgottenDevice> = entries.iter().collect();
    sorted.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.device_id.cmp(&b.device_id)));
    let mut forgotten: BTreeMap<String, Verdict> = BTreeMap::new();
    for entry in sorted {
        if !is_well_formed(entry) {
            continue;
        }
        let by = declaration_author(entry).unwrap_or_default().to_owned();
        if forgotten.contains_key(&by) || forgotten.contains_key(&entry.device_id) {
            continue;
        }
        forgotten.insert(entry.device_id.clone(), Verdict { by, at: entry.at.clone() });
    }
    forgotten
}

/// Verdicts dans l'ordre total (par `at` puis cible) : ordre d'examen commun avec `retention.ts`.
fn verdicts_in_order(order: &BTreeMap<String, Verdict>) -> Vec<(&String, &Verdict)> {
    let mut list: Vec<(&String, &Verdict)> = order.iter().collect();
    list.sort_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)));
    list
}

/// Apprentissage dans la liste maître (§18 point 3) : déclarations bien formées, inconnues (même cible, même `at`) et retenues par
/// l'ordre total calculé sur la liste plus elles-mêmes, ajoutées à la fin ; candidates examinées par `at` puis cible ; au-delà de `cap`,
/// non apprises et `overflow` vrai. Même fonction que `learnDeclarations`.
pub fn learn_declarations(master: &[ForgottenDevice], candidates: &[ForgottenDevice], cap: usize) -> (Vec<ForgottenDevice>, bool) {
    let mut entries = master.to_vec();
    let mut known: BTreeSet<(String, String)> = entries.iter().map(|e| (e.device_id.clone(), e.at.clone())).collect();
    let mut overflow = false;
    let mut sorted: Vec<&ForgottenDevice> = candidates.iter().collect();
    sorted.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.device_id.cmp(&b.device_id)));
    for candidate in sorted {
        if !is_well_formed(candidate) || known.contains(&(candidate.device_id.clone(), candidate.at.clone())) {
            continue;
        }
        let mut trial = entries.clone();
        trial.push(candidate.clone());
        if forget_order(&trial).get(&candidate.device_id).map(|v| v.at.as_str()) != Some(candidate.at.as_str()) {
            continue;
        }
        if entries.len() >= cap {
            overflow = true;
            continue;
        }
        known.insert((candidate.device_id.clone(), candidate.at.clone()));
        entries.push(candidate.clone());
    }
    (entries, overflow)
}

/// Ordre des positions d'accusé : époque (section 9), segment, enregistrement. Une époque illisible passe avant les autres.
pub fn compare_ack_positions(a: &DeviceAck, b: &DeviceAck) -> Ordering {
    EpochId::parse(&a.epoch).cmp(&EpochId::parse(&b.epoch)).then(a.segment.cmp(&b.segment)).then(a.record.cmp(&b.record))
}

fn compare_acks(a: &DeviceAck, b: &DeviceAck) -> Ordering {
    compare_ack_positions(a, b).then_with(|| a.hlc.cmp(&b.hlc)).then(a.state_seq.cmp(&b.state_seq))
}

/// Coupure d'un appareil oublié : maximum des accusés de `target` publiés par `ackers` (actifs non oubliés). Même fonction que `cutoff`.
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

/// Appareils cités dans les accusés des états donnés (audit Y-10 c : l'appelant ne passe que les actifs non oubliés).
pub fn cited_devices<'a>(active_states: impl IntoIterator<Item = &'a PublishedState>) -> BTreeSet<String> {
    active_states.into_iter().flat_map(|s| s.acks.keys().cloned()).collect()
}

/// Appareils « vus » (seconde revue Y-10, point 4 ; même définition que `seenDevices` de retention.ts) : état déjà accepté par
/// l'anti-rejeu du registre, ou cité dans un accusé d'un état authentifié dont l'auteur n'est pas oublié par la liste maître.
pub fn seen_devices<'a>(
    accepted: impl IntoIterator<Item = &'a String>,
    states: impl IntoIterator<Item = (&'a str, &'a BTreeMap<String, DeviceAck>)>,
    master: &[ForgottenDevice],
) -> BTreeSet<String> {
    let order = forget_order(master);
    let mut out: BTreeSet<String> = accepted.into_iter().cloned().collect();
    for (id, acks) in states {
        if !order.contains_key(id) {
            out.extend(acks.keys().cloned());
        }
    }
    out
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

/// Appareil connu (section 14.2 (c)) ; `seen` : état déjà accepté, ou cité dans un accusé authentifié d'un actif non oublié.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownDevice {
    pub device_id: String,
    pub status: StateStatus,
    pub state: Option<KnownState>,
    pub seen: bool,
}

/// Raison d'une attente (§18 point 11, même vocabulaire que `ForgetWaitReason` de `retention.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReason {
    State,
    Cutoff,
    Declarations,
    Snapshot,
    Revived,
}

impl WaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Cutoff => "cutoff",
            Self::Declarations => "declarations",
            Self::Snapshot => "snapshot",
            Self::Revived => "revived",
        }
    }
}

/// Résultat de `forgotten_delete_check` (même forme que `ForgottenDeleteCheck` de `retention.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteCheck {
    Ready { by: String, cutoff: Option<DeviceAck> },
    Waiting { device: String, code: SyncCode, reason: WaitReason },
    Refused(SyncCode),
}

/// Fin d'un instantané annoncé (`SnapshotEnd` de `retention.ts`) : auteur, époque, numéro et `endHlc` de l'annonce, `covers` lu dans
/// `snap-end`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotEnd {
    pub author: String,
    pub epoch: String,
    pub seq: u64,
    pub end_hlc: String,
    pub covers: BTreeMap<String, DeviceAck>,
}

/// `SnapshotEndRead` : fin lue, aucun instantané annoncé dans l'époque courante, dans le nuage, illisible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotEndRead {
    End(SnapshotEnd),
    None,
    CloudPending,
    Unreadable,
}

/// `covers` couvre-t-il chaque oublié retenu (§18 point 11) ? Première cible retenue (ordre total) de coupure non nulle que `covers` ne
/// couvre pas ; `None` si tout est couvert. Coupure calculée sur les `ackers` non oubliés. Même fonction que `coversForgotten`.
pub fn covers_forgotten<'a>(
    covers: &BTreeMap<String, DeviceAck>,
    master: &[ForgottenDevice],
    ackers: impl IntoIterator<Item = (&'a str, &'a BTreeMap<String, DeviceAck>)>,
) -> Option<String> {
    let order = forget_order(master);
    let live: Vec<(&str, &BTreeMap<String, DeviceAck>)> = ackers.into_iter().filter(|(id, _)| !order.contains_key(*id)).collect();
    for (target, _) in verdicts_in_order(&order) {
        let Some(cut) = cutoff(target, live.iter().copied()) else { continue };
        if covers.get(target.as_str()).map_or(true, |c| compare_ack_positions(c, &cut) == Ordering::Less) {
            return Some(target.clone());
        }
    }
    None
}

/// Candidat à l'instantané éligible (`SnapshotCandidate`) : auteur, époque et annonce de son état, état `ok` ou non, fin lue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotCandidate {
    pub author: String,
    pub epoch: String,
    pub announced: Option<(u64, String)>,
    pub ok: bool,
    pub end: SnapshotEndRead,
}

/// Résultat de `eligible_snapshot` (`EligibleSnapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Eligible {
    Ok(SnapshotEnd),
    Waiting,
    None { uncovered: Option<String> },
}

/// Instantané éligible (§18 point 11) : même fonction que `eligibleSnapshot`.
pub fn eligible_snapshot<'a>(
    candidates: &[SnapshotCandidate],
    master: &[ForgottenDevice],
    ackers: impl IntoIterator<Item = (&'a str, &'a BTreeMap<String, DeviceAck>)>,
    epoch: &str,
) -> Eligible {
    let order = forget_order(master);
    let ackers: Vec<(&str, &BTreeMap<String, DeviceAck>)> = ackers.into_iter().collect();
    let mut best: Option<&SnapshotEnd> = None;
    let mut uncovered: Option<(String, &str)> = None;
    let mut cloud = false;
    for c in candidates {
        let Some((seq, end_hlc)) = &c.announced else { continue };
        if !c.ok || order.contains_key(&c.author) || c.epoch != epoch {
            continue;
        }
        let end = match &c.end {
            SnapshotEndRead::CloudPending => {
                cloud = true;
                continue;
            }
            SnapshotEndRead::None | SnapshotEndRead::Unreadable => continue,
            SnapshotEndRead::End(end) => end,
        };
        if end.author != c.author || end.epoch != epoch || end.seq != *seq || &end.end_hlc != end_hlc {
            continue;
        }
        if let Some(missing) = covers_forgotten(&end.covers, master, ackers.iter().copied()) {
            if uncovered.as_ref().map_or(true, |(_, h)| end.end_hlc.as_str() > *h) {
                uncovered = Some((missing, end.end_hlc.as_str()));
            }
            continue;
        }
        if best.map_or(true, |b| end.end_hlc > b.end_hlc) {
            best = Some(end);
        }
    }
    match best {
        Some(end) => Eligible::Ok(end.clone()),
        None if cloud => Eligible::Waiting,
        None => Eligible::None { uncovered: uncovered.map(|(t, _)| t) },
    }
}

/// Trous (§18 point 11) : même fonction que `forgetGaps`.
pub fn forget_gaps<'a>(
    master: &[ForgottenDevice],
    ackers: impl IntoIterator<Item = (&'a str, &'a BTreeMap<String, DeviceAck>)>,
    cursors: &BTreeMap<String, DeviceAck>,
    gone: &BTreeSet<String>,
) -> Vec<String> {
    let order = forget_order(master);
    let live: Vec<(&str, &BTreeMap<String, DeviceAck>)> = ackers.into_iter().filter(|(id, _)| !order.contains_key(*id)).collect();
    let mut out = Vec::new();
    for (target, _) in verdicts_in_order(&order) {
        if !gone.contains(target) {
            continue;
        }
        let Some(cut) = cutoff(target, live.iter().copied()) else { continue };
        if cursors.get(target.as_str()).map_or(true, |c| compare_ack_positions(c, &cut) == Ordering::Less) {
            out.push(target.clone());
        }
    }
    out
}

/// Terminés dont l'oubli est annulé (§18 point 12) : dans `done`, plus oubliés par l'ordre total ; triés.
pub fn revived_devices(master: &[ForgottenDevice], done: &[String]) -> Vec<String> {
    let order = forget_order(master);
    let set: BTreeSet<&String> = done.iter().filter(|id| !order.contains_key(*id)).collect();
    set.into_iter().cloned().collect()
}

/// Conditions (c) à (g) de la suppression des fichiers de `target` (section 14.2, §18 points 8 et 9). Même fonction que
/// `forgottenDeleteCheck`.
pub fn forgotten_delete_check(target: &str, self_id: &str, master: &[ForgottenDevice], done: &[String], known: &[KnownDevice], own_snapshot: &SnapshotEndRead) -> DeleteCheck {
    if target == self_id {
        return DeleteCheck::Refused(SyncCode::BadName);
    }
    let order = forget_order(master);
    let Some(verdict) = order.get(target) else { return DeleteCheck::Refused(SyncCode::StateMismatch) };
    if order.contains_key(self_id) {
        return DeleteCheck::Refused(SyncCode::StateMismatch);
    }
    let mut devices: BTreeMap<&str, &KnownDevice> = BTreeMap::new();
    for d in known {
        devices.entry(d.device_id.as_str()).or_insert(d);
    }
    let missing_self = KnownDevice { device_id: self_id.to_owned(), status: StateStatus::Missing, state: None, seen: true };
    devices.entry(self_id).or_insert(&missing_self);
    if devices.get(target).is_some_and(|d| d.status == StateStatus::CloudPending) {
        return DeleteCheck::Waiting { device: target.to_owned(), code: SyncCode::CloudPending, reason: WaitReason::State };
    }
    // (i) Terminé dont l'oubli est annulé : bloque toujours, quel que soit son état (§18 point 12).
    if let Some(revived) = revived_devices(master, done).into_iter().next() {
        return DeleteCheck::Waiting { device: revived, code: SyncCode::StateMismatch, reason: WaitReason::Revived };
    }
    let authors: BTreeSet<&str> = master.iter().filter_map(declaration_author).collect();
    let mut states: BTreeMap<&str, &KnownState> = BTreeMap::new();
    for (id, d) in &devices {
        if order.contains_key(*id) {
            continue;
        }
        let phantom = *id != self_id && d.status != StateStatus::Ok && !d.seen && !authors.contains(id);
        if phantom {
            continue;
        }
        match (d.status, &d.state) {
            (StateStatus::Ok, Some(state)) => {
                states.insert(id, state);
            }
            (StateStatus::CloudPending, _) => return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::CloudPending, reason: WaitReason::State },
            _ => return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch, reason: WaitReason::State },
        }
    }
    let finished = done.iter().any(|d| d == target);
    let cut = if finished { None } else { cutoff(target, states.iter().map(|(id, s)| (*id, &s.acks))) };
    if let Some(cut) = &cut {
        for (id, state) in &states {
            if state.acks.get(target).map_or(true, |ack| compare_ack_positions(ack, cut) == Ordering::Less) {
                return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch, reason: WaitReason::Cutoff };
            }
        }
    }
    let retained = verdicts_in_order(&order);
    for (id, state) in &states {
        for (t, v) in &retained {
            if !state.forgotten.iter().any(|f| &f.device_id == *t && f.at == v.at) {
                return DeleteCheck::Waiting { device: (*id).to_owned(), code: SyncCode::StateMismatch, reason: WaitReason::Declarations };
            }
        }
    }
    // (h) Son instantané annoncé couvre la cible jusqu'à la coupure (sans objet pour un terminé).
    if !finished {
        let snapshot_wait = |code| DeleteCheck::Waiting { device: self_id.to_owned(), code, reason: WaitReason::Snapshot };
        match own_snapshot {
            SnapshotEndRead::CloudPending => return snapshot_wait(SyncCode::CloudPending),
            SnapshotEndRead::None | SnapshotEndRead::Unreadable => return snapshot_wait(SyncCode::StateMismatch),
            SnapshotEndRead::End(end) => {
                if let Some(cut) = &cut {
                    if end.covers.get(target).map_or(true, |c| compare_ack_positions(c, cut) == Ordering::Less) {
                        return snapshot_wait(SyncCode::StateMismatch);
                    }
                }
            }
        }
    }
    DeleteCheck::Ready { by: verdict.by.clone(), cutoff: cut }
}

fn split_hlc(hlc: &str) -> Option<(u64, u32)> {
    if !is_strict_hlc(hlc) {
        return None;
    }
    Some((hlc.get(..15)?.parse().ok()?, u32::from_str_radix(hlc.get(16..20)?, 16).ok()?))
}

/// hlc d'une nouvelle déclaration (audit Y-10 d) : après `now_ms` et après chaque hlc de `seen` (états des actifs non oubliés autres que
/// la cible, choisis par l'appelant) ; un hlc au-delà de `now_ms + tolerance_ms` est ignoré ; `None` si le résultat n'est pas strict
/// (`hlc-order`). Même fonction que `declarationHlc`.
pub fn next_declaration_hlc<'a>(now_ms: u64, seen: impl IntoIterator<Item = &'a str>, self_id: &str, tolerance_ms: u64) -> Option<String> {
    let limit = now_ms.saturating_add(tolerance_ms);
    let best = seen.into_iter().filter_map(split_hlc).filter(|(ms, _)| *ms <= limit).max();
    let (ms, counter) = match best {
        Some((ms, counter)) if ms >= now_ms => {
            if counter >= 0xffff {
                (ms.saturating_add(1), 0)
            } else {
                (ms, counter + 1)
            }
        }
        _ => (now_ms, 0),
    };
    let out = format!("{ms:015}-{counter:04x}-{self_id}");
    is_strict_hlc(&out).then_some(out)
}

/// hlc connus d'un état authentifié (dernier cycle, tête, accusés, déclarations).
pub fn state_hlcs(state: &PublishedState) -> Vec<&str> {
    let mut out: Vec<&str> = vec![state.last_sync_hlc.as_str()];
    out.extend(state.head.hlc.as_deref());
    out.extend(state.acks.values().filter_map(|a| a.hlc.as_deref()));
    out.extend(state.forgotten.iter().map(|f| f.at.as_str()));
    out
}

/// Liste publiée par le moteur comparée à la liste maître (section 1.4) : égale, ou **préfixe** (Rust complète) ; toute autre
/// différence : `None` (`state-mismatch`).
pub fn completed_forgotten(published: &[ForgottenDevice], master: &[ForgottenDevice]) -> Option<Vec<ForgottenDevice>> {
    (published.len() <= master.len() && master[..published.len()] == *published).then(|| master.to_vec())
}

/// Détail de la boîte native (audit Y-10 e) : plateforme, dernière synchro et 8 premiers caractères de l'identifiant, lus par Rust
/// dans l'état authentifié de la cible (textes de `src/i18n/native/fr.json`, section `forgetDetail`).
pub fn forget_dialog_detail(device_id: &str, state: Option<&PublishedState>, local_offset_minutes: i64) -> String {
    let texts = super::consent::forget_detail_texts();
    let short: String = device_id.chars().take(8).collect();
    let Some(state) = state else { return texts.never.replace("{id}", &short) };
    let platform = if state.platform == "ios" { texts.ios.clone() } else { texts.windows.clone() };
    let ms = split_hlc(&state.last_sync_hlc).map_or(0, |(ms, _)| ms) as i64 + local_offset_minutes * 60_000;
    let (date, time) = local_date_time(ms);
    texts.detail.replace("{platform}", &platform).replace("{id}", &short).replace("{date}", &date).replace("{time}", &time)
}

/// Date (jj/mm/aaaa) et heure sur 24 h (hh:mm) d'un instant déjà décalé à l'heure locale (ms depuis 1970).
pub fn local_date_time(local_ms: i64) -> (String, String) {
    let days = local_ms.div_euclid(86_400_000);
    let minutes = local_ms.rem_euclid(86_400_000) / 60_000;
    // Jours depuis 1970 → date civile (algorithme de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (format!("{day:02}/{month:02}/{year:04}"), format!("{:02}:{:02}", minutes / 60, minutes % 60))
}

/// Décalage de l'heure locale (minutes) à l'instant donné (ms Unix) : fuseau du système sur Windows, UTC ailleurs.
pub fn local_offset_minutes(utc_ms: u64) -> i64 {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTime};
        let ticks = utc_ms.saturating_mul(10_000).saturating_add(116_444_736_000_000_000);
        let utc_ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
        let mut utc = SYSTEMTIME::default();
        let mut local = SYSTEMTIME::default();
        let mut local_ft = FILETIME::default();
        // SAFETY: structures locales valides pendant les appels ; fuseau courant (None).
        let ok = unsafe {
            FileTimeToSystemTime(&utc_ft, &mut utc).is_ok() && SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).is_ok() && SystemTimeToFileTime(&local, &mut local_ft).is_ok()
        };
        if !ok {
            return 0;
        }
        let local_ticks = (u64::from(local_ft.dwHighDateTime) << 32) | u64::from(local_ft.dwLowDateTime);
        (local_ticks as i64 - ticks as i64) / 600_000_000
    }
    #[cfg(not(windows))]
    {
        let _ = utc_ms;
        0
    }
}
