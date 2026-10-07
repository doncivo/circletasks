/**
 * Rétention : purge des traces de suppression, des segments, appareils inactifs (ADR 0011, sections 3.4, 5.3 à 5.5 ; Y-09 critères 2
 * à 6, Y-02 critères 11 et 12).
 *
 * Règle validée par Ali (Y-09 D1) : une ligne supprimée n'est purgée physiquement que si **les deux** conditions sont vraies :
 * - la suppression a **au moins 30 jours** (comptés depuis `deleted_at`) ;
 * - **tous les appareils actifs** l'ont lue (accusé de l'écrivain de la suppression supérieur ou égal à son hlc).
 * Un appareil absent depuis plus de 180 jours est `expired` et ne compte plus ; un appareil sans état valide (`foreign`, `corrupt`,
 * `rollback`, état absent) garde son dernier accusé connu, qui ne débloque rien qu'il n'avait pas déjà accusé.
 *
 * Module pur.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { compareEpochs, isStrictHlc, isSyncDeviceId, type DeviceAck, type EpochId, type ForgottenDevice, type PublishedDeviceState } from './format';
import { DEVICE_EXPIRY_MS, MAX_STATE_FORGOTTEN, SEGMENT_PURGE_AGE_MS, TOMBSTONE_GRACE_MS } from './limits';
import { hlcDevice, hlcMs } from './parse';

/** Ce que la base locale sait d'un autre appareil (ligne de `sync_state`). */
export interface KnownDevice {
  readonly deviceId: DeviceId;
  readonly status: string;
  /** `lastSyncHlc` publié (dernier cycle complet de l'appareil). */
  readonly lastSeenHlc: Hlc | null;
  /** Derniers accusés connus de l'appareil (gardés si son état devient invalide). */
  readonly acks: ReadonlyMap<DeviceId, DeviceAck>;
}

/** Un appareil dont le dernier cycle a plus de 180 jours est `expired` (section 5.5). */
export function isExpired(lastSeenHlc: Hlc | null, nowMs: number): boolean {
  return lastSeenHlc !== null && hlcMs(lastSeenHlc) < nowMs - DEVICE_EXPIRY_MS;
}

/** Appareils qui comptent dans les accusés : tous sauf soi, les expirés et les oubliés (Y-10). */
export function activeReaders(devices: readonly KnownDevice[], self: DeviceId, nowMs: number): KnownDevice[] {
  return devices.filter((d) => d.deviceId !== self && d.status !== 'expired' && d.status !== 'forgotten' && !isExpired(d.lastSeenHlc, nowMs));
}

/**
 * Horizon de purge : sans autre appareil actif (synchro non configurée, appareil seul), rien ne retient une trace ; `blocked` : un appareil
 * actif a publié des écritures que cet appareil n'a pas encore lues (fichier dans le nuage, état illisible) : aucune purge (comme
 * l'étape 7 du cycle, réservée aux cycles qui ont tout lu).
 */
export type PurgeHorizon = { readonly kind: 'unbounded' } | { readonly kind: 'blocked' } | { readonly kind: 'limited'; readonly readers: readonly KnownDevice[] };

export const BLOCKED: PurgeHorizon = { kind: 'blocked' };

export const UNBOUNDED: PurgeHorizon = { kind: 'unbounded' };

export function purgeHorizon(devices: readonly KnownDevice[], self: DeviceId, nowMs: number, revived: readonly DeviceId[] = []): PurgeHorizon {
  // Y-10 (ADR 0011 §18 point 12) : un terminé dont l'oubli est annulé est un actif dont on ne lira plus rien : aucune purge.
  if (revived.length > 0) return BLOCKED;
  const readers = activeReaders(devices, self, nowMs);
  return readers.length === 0 ? UNBOUNDED : { kind: 'limited', readers };
}

/** Lecture d'un appareil connu (ligne de `sync_state`) : ce que cet appareil a lu de lui, ce qu'il a publié, son statut local. */
export interface DeviceReadState {
  readonly status: string;
  readonly epoch: string | null;
  readonly stateEpoch: string | null;
  readonly cursor: { readonly segment: number; readonly record: number };
  readonly head: { readonly segment: number; readonly record: number };
}

/**
 * Tout ce qu'un appareil a publié est-il lu (même condition que `allRead` du cycle, ADR 0011 section 10.2 étape 7) ? Faux si son état
 * est invalide (`foreign`, `corrupt`, `rollback`, `newer-major`), s'il annonce une autre époque que celle où il est lu, ou si le
 * curseur est avant sa tête annoncée.
 */
export function publishedAllRead(device: DeviceReadState): boolean {
  if (['foreign', 'corrupt', 'rollback', 'newer-major', 'clock-ahead'].includes(device.status)) return false;
  if (device.stateEpoch === null) return true;
  if (device.epoch !== device.stateEpoch) return false;
  return device.cursor.segment > device.head.segment || (device.cursor.segment === device.head.segment && device.cursor.record >= device.head.record);
}

/** Tous les appareils actifs ont-ils lu l'écriture `hlc` (accusé de son écrivain supérieur ou égal) ? */
export function readByAll(hlc: Hlc, horizon: PurgeHorizon): boolean {
  if (horizon.kind === 'unbounded') return true;
  if (horizon.kind === 'blocked') return false;
  const writer = hlcDevice(hlc);
  return horizon.readers.every((reader) => {
    if (reader.deviceId === writer) return true;
    const ack = reader.acks.get(writer);
    return ack !== undefined && ack.hlc !== null && ack.hlc >= hlc;
  });
}

/** Une ligne supprimée peut-elle être purgée : 30 jours écoulés depuis `deleted_at` **et** lue par tous les appareils actifs. */
export function canPurgeDeletion(deletion: { readonly deletedAt: IsoDateTime; readonly deletedHlc: Hlc }, horizon: PurgeHorizon, nowMs: number): boolean {
  const deletedMs = Date.parse(deletion.deletedAt);
  if (Number.isNaN(deletedMs) || nowMs - deletedMs < TOMBSTONE_GRACE_MS) return false;
  return readByAll(deletion.deletedHlc, horizon);
}

/** Limite de date pour la recherche des candidats (30 jours avant maintenant). */
export function purgeBefore(nowMs: number): IsoDateTime {
  return new Date(nowMs - TOMBSTONE_GRACE_MS).toISOString() as IsoDateTime;
}

/**
 * Un de ses propres segments peut-il être supprimé (section 5.3) ? Un instantané le couvre, tous les appareils actifs l'ont accusé
 * (position au-delà de sa fin), son dernier enregistrement a plus de 30 jours. Jamais le segment de tête.
 */
/**
 * Y-TECH-02 (QA) : un segment nécessaire absent de la liste du dossier peut-il avoir été purgé par son écrivain ? La purge
 * (`segmentPurgeable`) exige un instantané qui le couvre et un dernier enregistrement de plus de 30 jours ; or tout enregistrement de ce
 * segment est postérieur au dernier hlc lu de cet appareil (`ackHlc`, hlc strictement croissants). Sans instantané publié dans
 * l'époque, ou avec un hlc lu de moins de 30 jours, la purge est impossible : le fichier n'est pas encore arrivé (attente d'iCloud
 * visible), jamais une reprise depuis l'instantané à chaque cycle.
 */
export function purgeExplainsMissingSegment(
  writer: { readonly snapshot: unknown },
  ackHlc: Hlc | null,
  nowMs: number,
  own?: { readonly segment: number; readonly epoch: EpochId; readonly ownAck: DeviceAck | null; readonly ownActive: boolean },
): boolean {
  if (writer.snapshot === null) return false;
  // Seconde revue, point 7 : la purge d'un segment exige que chaque lecteur actif ait publié un accusé au-delà (`segmentPurgeable`) ;
  // notre propre accusé publié sur l'écrivain, dans cette époque et au plus sur ce segment, l'interdit tant que nous sommes actifs
  // pour lui (moins de 180 jours) : le fichier n'est pas encore arrivé, même si le dernier hlc lu est ancien.
  if (own && own.ownActive && own.ownAck !== null && own.ownAck.epoch === own.epoch && own.ownAck.segment <= own.segment) return false;
  return ackHlc === null || nowMs - hlcMs(ackHlc) >= SEGMENT_PURGE_AGE_MS;
}

export function segmentPurgeable(segment: number, input: { readonly headSegment: number; readonly coveredSegment: number; readonly readers: readonly KnownDevice[]; readonly self: DeviceId; readonly lastWriteMs: number | null; readonly nowMs: number }): boolean {
  if (segment >= input.headSegment || segment >= input.coveredSegment) return false;
  if (input.lastWriteMs === null || input.nowMs - input.lastWriteMs < SEGMENT_PURGE_AGE_MS) return false;
  return input.readers.every((reader) => {
    const ack = reader.acks.get(input.self);
    return ack !== undefined && ack.segment > segment;
  });
}


// ---------------------------------------------------------------------------------------------------------------------------------
// Y-10 : appareils oubliés (ADR 0011 sections 14.2, 11.2 et 18 points 3 à 10). Même table de cas que `forget.rs`
// (tests/fixtures/sync/forget-order.json).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Oubli retenu par l'ordre total : auteur de la déclaration (appareil de son hlc) et son hlc. */
export interface ForgetVerdict {
  readonly by: DeviceId;
  readonly at: Hlc;
}

/** Une nouvelle déclaration locale est refusée (`too-large`) à partir de ce nombre (16 places pour des déclarations concurrentes). */
export const FORGET_DECLARE_LIMIT = 48;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Auteur d'une déclaration (§18 point 3) : l'appareil de son hlc `at`, jamais l'appareil qui la publie ; null si `at` n'est pas strict. */
export function declarationAuthor(entry: ForgottenDevice): DeviceId | null {
  return isStrictHlc(entry.at) ? hlcDevice(entry.at) : null;
}

/** Bien formée : `at` strict, cible au format strict, auteur différent de la cible. */
function isWellFormedDeclaration(entry: ForgottenDevice): boolean {
  const author = declarationAuthor(entry);
  return author !== null && isSyncDeviceId(entry.deviceId) && author !== entry.deviceId;
}

/**
 * Ordre total des oublis (section 14.2) sur une liste de déclarations (liste maître de Rust, ou `FolderScan.forgotten.entries`) : tri
 * par `at` puis par cible ; une déclaration est **sans effet** si elle est mal formée, si son auteur (appareil de `at`) est déjà
 * oublié par une déclaration antérieure, ou si sa cible l'est déjà. Indépendant de l'ordre de la liste et des doublons.
 */
export function forgetOrder(entries: readonly ForgottenDevice[]): ReadonlyMap<DeviceId, ForgetVerdict> {
  const sorted = [...entries].sort((a, b) => compareText(a.at, b.at) || compareText(a.deviceId, b.deviceId));
  const forgotten = new Map<DeviceId, ForgetVerdict>();
  for (const entry of sorted) {
    if (!isWellFormedDeclaration(entry)) continue;
    const by = declarationAuthor(entry) as DeviceId;
    if (forgotten.has(by) || forgotten.has(entry.deviceId)) continue;
    forgotten.set(entry.deviceId, { by, at: entry.at });
  }
  return forgotten;
}

const declarationKey = (entry: ForgottenDevice): string => `${entry.deviceId}|${entry.at}`;

/**
 * Apprentissage dans la liste maître (registre de Rust, §18 point 3) : chaque déclaration bien formée lue dans un état authentifié,
 * pas encore connue (même cible, même `at`), et **retenue** par l'ordre total calculé sur la liste plus elle-même, est ajoutée à la
 * fin (ordre d'apprentissage, jamais retirée ni réordonnée). Candidates examinées par `at` puis cible. Au-delà de `cap` : non apprise,
 * `overflow` vrai (§18 point 5).
 */
export function learnDeclarations(master: readonly ForgottenDevice[], candidates: readonly ForgottenDevice[], cap = MAX_STATE_FORGOTTEN): { readonly entries: ForgottenDevice[]; readonly overflow: boolean } {
  const entries = [...master];
  const known = new Set(entries.map(declarationKey));
  let overflow = false;
  const sorted = [...candidates].sort((a, b) => compareText(a.at, b.at) || compareText(a.deviceId, b.deviceId));
  for (const candidate of sorted) {
    if (!isWellFormedDeclaration(candidate) || known.has(declarationKey(candidate))) continue;
    const verdict = forgetOrder([...entries, candidate]).get(candidate.deviceId);
    if (verdict?.at !== candidate.at) continue;
    if (entries.length >= cap) {
      overflow = true;
      continue;
    }
    entries.push(candidate);
    known.add(declarationKey(candidate));
  }
  return { entries, overflow };
}

/** Ordre des positions d'accusé : époque (section 9), puis segment, puis enregistrement. */
export function compareAckPositions(a: DeviceAck, b: DeviceAck): number {
  const byEpoch = compareEpochs(a.epoch, b.epoch);
  if (byEpoch !== 0) return byEpoch;
  if (a.segment !== b.segment) return a.segment - b.segment;
  return a.record - b.record;
}

/** Ordre complet d'un accusé (position, puis hlc, puis `stateSeq`) : maximum déterministe des deux côtés. */
function compareAcks(a: DeviceAck, b: DeviceAck): number {
  const byPosition = compareAckPositions(a, b);
  if (byPosition !== 0) return byPosition;
  if (a.hlc !== b.hlc) return a.hlc === null ? -1 : b.hlc === null ? 1 : compareText(a.hlc, b.hlc);
  return a.stateSeq - b.stateSeq;
}

/**
 * Coupure d'un appareil oublié (section 14.2) : **maximum des accusés de `target`** publiés par `ackers` (l'appelant passe tous les
 * appareils actifs non oubliés) ; null si aucun ne l'a jamais lu.
 */
export function cutoff(target: DeviceId, ackers: readonly Pick<PublishedDeviceState, 'deviceId' | 'acks'>[]): DeviceAck | null {
  let best: DeviceAck | null = null;
  for (const acker of ackers) {
    if (acker.deviceId === target) continue;
    const ack = acker.acks.get(target);
    if (ack !== undefined && (best === null || compareAcks(ack, best) > 0)) best = ack;
  }
  return best;
}

/** Appareils cités dans les accusés des états donnés (audit Y-10 c : l'appelant ne passe que les actifs non oubliés). */
export function citedDevices(activeStates: readonly Pick<PublishedDeviceState, 'acks'>[]): ReadonlySet<DeviceId> {
  const out = new Set<DeviceId>();
  for (const state of activeStates) for (const id of state.acks.keys()) out.add(id);
  return out;
}

/**
 * Appareils « vus » (seconde revue Y-10, point 4 ; même définition que `seen_devices` de forget.rs) : état déjà accepté par l'anti-rejeu
 * du registre (`FolderScan.forgotten.accepted`), ou cité dans un accusé d'un état authentifié dont l'auteur n'est pas oublié par la
 * liste maître. Un appareil jamais vu, sans état authentifié et sans déclaration, est un fantôme : il ne bloque pas une suppression.
 */
export function seenDevices(
  accepted: Iterable<DeviceId>,
  states: readonly Pick<PublishedDeviceState, 'deviceId' | 'acks'>[],
  master: readonly ForgottenDevice[],
): ReadonlySet<DeviceId> {
  const order = forgetOrder(master);
  const out = new Set<DeviceId>(accepted);
  for (const id of citedDevices(states.filter((s) => !order.has(s.deviceId)))) out.add(id);
  return out;
}

const sameEntry = (a: ForgottenDevice, b: ForgottenDevice): boolean =>
  a.deviceId === b.deviceId &&
  a.at === b.at &&
  (a.lastAck === b.lastAck ||
    (a.lastAck !== null && b.lastAck !== null && a.lastAck.epoch === b.lastAck.epoch && a.lastAck.segment === b.lastAck.segment && a.lastAck.record === b.lastAck.record && a.lastAck.hlc === b.lastAck.hlc && a.lastAck.stateSeq === b.lastAck.stateSeq));

/**
 * `sync_write_state` (section 1.4) : Rust est seul maître de `forgotten`. La liste publiée par le moteur doit être la liste maître ou
 * son **préfixe** (Rust complète) ; toute autre différence : null (`state-mismatch`). Même fonction que `completed_forgotten`.
 */
export function completedForgotten(published: readonly ForgottenDevice[], master: readonly ForgottenDevice[]): readonly ForgottenDevice[] | null {
  if (published.length > master.length) return null;
  return published.every((entry, i) => sameEntry(entry, master[i] as ForgottenDevice)) ? [...master] : null;
}

/**
 * hlc d'une nouvelle déclaration (audit Y-10 d) : postérieur à `nowMs` et à chaque hlc de `seen` (états des actifs non oubliés autres
 * que la cible, choisis par l'appelant) ; un hlc au-delà de `nowMs + toleranceMs` est ignoré ; null si le résultat n'est pas strict
 * (`hlc-order`). Même fonction que `next_declaration_hlc` de `forget.rs`.
 */
export function declarationHlc(nowMs: number, seen: readonly string[], self: DeviceId, toleranceMs: number): Hlc | null {
  let best: { ms: number; counter: number } | null = null;
  for (const hlc of seen) {
    if (!isStrictHlc(hlc)) continue;
    const ms = Number(hlc.slice(0, 15));
    if (ms > nowMs + toleranceMs) continue;
    const counter = parseInt(hlc.slice(16, 20), 16);
    if (best === null || ms > best.ms || (ms === best.ms && counter > best.counter)) best = { ms, counter };
  }
  let ms = nowMs;
  let counter = 0;
  if (best !== null && best.ms >= nowMs) {
    ms = best.counter >= 0xffff ? best.ms + 1 : best.ms;
    counter = best.counter >= 0xffff ? 0 : best.counter + 1;
  }
  const out = `${String(ms).padStart(15, '0')}-${counter.toString(16).padStart(4, '0')}-${self}`;
  return Number.isSafeInteger(ms) && ms >= 0 && isStrictHlc(out) ? out : null;
}

/** Statut de lecture d'un `state.ctx` (même vocabulaire que `DeviceScan.stateStatus`). */
export type ForgetStateStatus = 'ok' | 'missing' | 'cloud-pending' | 'foreign' | 'corrupt' | 'rollback' | 'too-large' | 'newer-format';

/** Appareil connu pour la suppression (section 14.2 (c)). */
export interface ForgetKnownDevice {
  readonly deviceId: DeviceId;
  readonly status: ForgetStateStatus;
  /** État authentifié (statut `ok`) ; null sinon. */
  readonly state: Pick<PublishedDeviceState, 'deviceId' | 'stateSeq' | 'acks' | 'forgotten'> | null;
  /** Vu actif : état déjà accepté (anti-rejeu), ou cité dans un accusé authentifié d'un actif non oublié. */
  readonly seen: boolean;
}

/**
 * Peut-on supprimer les fichiers de `target` (section 14.2, conditions (c) à (g), §18 points 8 et 9) ?
 * - `refused` : cible = soi (`bad-name`) ; cible non oubliée par la liste maître, ou appareil local oublié (`state-mismatch`) ;
 * - `waiting` : `state.ctx` de la cible dans le nuage (g) ; un actif (non oublié, `expired` compris, sauf **fantôme** jamais vu, auteur
 *   d'aucune déclaration et d'état non `ok`) bloque : état dans le nuage, illisible ou absent, en retard sur la coupure (sauf cible de
 *   `done`), ou ne republie pas toutes les déclarations retenues de la liste maître (f) ; `device` : le premier par identifiant ;
 * - `ready` : les fichiers peuvent être supprimés.
 * Même fonction que `forgotten_delete_check` (`forget.rs`).
 */
export type ForgottenDeleteCheck =
  | { readonly kind: 'ready'; readonly by: DeviceId; readonly cutoff: DeviceAck | null }
  | { readonly kind: 'waiting'; readonly device: DeviceId; readonly code: 'cloud-pending' | 'state-mismatch'; readonly reason: ForgetWaitReason }
  | { readonly kind: 'refused'; readonly code: 'bad-name' | 'state-mismatch' };

/**
 * Raison d'une attente (§18 point 11) : `state` (état d'un actif ou de la cible pas `ok`), `cutoff` (actif en retard sur la coupure),
 * `declarations` (déclaration retenue pas republiée), `snapshot` (condition (h) : son instantané annoncé ne couvre pas la cible ;
 * `device` = soi), `revived` (terminé dont l'oubli est annulé, §18 point 12).
 */
export type ForgetWaitReason = 'state' | 'cutoff' | 'declarations' | 'snapshot' | 'revived';

/**
 * Fin d'un instantané (`snap-end`, section 5.1) lue par `sync_read_snapshot` `tail` : `author`, `epoch`, `seq` et `endHlc` sont ceux
 * annoncés par `state.snapshot` de l'auteur ; `covers` vient de l'enregistrement de fin.
 */
export interface SnapshotEnd {
  readonly author: DeviceId;
  readonly epoch: EpochId;
  readonly seq: number;
  readonly endHlc: Hlc;
  readonly covers: ReadonlyMap<DeviceId, DeviceAck>;
}

/** `none` : aucun instantané annoncé dans l'époque courante ; `unreadable` : fin absente ou illisible. */
export type SnapshotEndRead = SnapshotEnd | 'none' | 'cloud-pending' | 'unreadable';

type Acker = Pick<PublishedDeviceState, 'deviceId' | 'acks'>;

/**
 * Condition (h) : seul un instantané de l'époque courante compte (troisième revue Y-10, point 2) ; une fin d'une autre époque vaut `none`.
 * Même fonction que `snapshot_in_epoch` (`forget.rs`), même table de cas (`ownSnapshotEpoch`).
 */
export function snapshotInEpoch(read: SnapshotEndRead, epoch: EpochId | null): SnapshotEndRead {
  if (typeof read === 'string') return read;
  return epoch !== null && read.epoch === epoch ? read : 'none';
}

/**
 * Un `covers` couvre-t-il chaque oublié retenu (§18 point 11) ? Pour chaque cible retenue (ordre total) dont la coupure (calculée sur les
 * `ackers` non oubliés, accusés figés compris) n'est pas nulle : `covers[X]` ≥ `cutoff(X)` (positions). Renvoie null si tout est
 * couvert, sinon la première cible non couverte. Même fonction que `covers_forgotten` (`forget.rs`).
 */
export function coversForgotten(covers: ReadonlyMap<DeviceId, DeviceAck>, master: readonly ForgottenDevice[], ackers: readonly Acker[]): DeviceId | null {
  const order = forgetOrder(master);
  const live = ackers.filter((a) => !order.has(a.deviceId));
  for (const target of order.keys()) {
    const cut = cutoff(target, live);
    if (cut === null) continue;
    const cover = covers.get(target);
    if (cover === undefined || compareAckPositions(cover, cut) < 0) return target;
  }
  return null;
}

/** Candidat à l'instantané éligible : état `ok` de son auteur (`ok` faux : état non authentifié, exclu) et fin lue. */
export interface SnapshotCandidate {
  readonly state: Pick<PublishedDeviceState, 'deviceId' | 'epoch' | 'snapshot'>;
  readonly end: SnapshotEndRead;
  readonly ok?: boolean;
}

export type EligibleSnapshot =
  | { readonly kind: 'ok'; readonly end: SnapshotEnd }
  | { readonly kind: 'waiting'; readonly code: 'cloud-pending' }
  | { readonly kind: 'none'; readonly uncovered: DeviceId | null };

/**
 * Instantané éligible (§18 point 11, section 14.2) : annoncé dans l'état `ok` de son auteur, époque courante, auteur non oublié, fin
 * valide (même auteur, époque et numéro que l'annonce), `coversForgotten` nul ; le plus récent par `endHlc` parmi les éligibles
 * seulement. Aucun éligible : `waiting` si un candidat qui pourrait l'être est dans le nuage, sinon `none` (avec la cible que le plus
 * récent des candidats lisibles ne couvre pas). Même fonction que `eligible_snapshot` (`forget.rs`).
 */
export function eligibleSnapshot(candidates: readonly SnapshotCandidate[], master: readonly ForgottenDevice[], ackers: readonly Acker[], epoch: EpochId): EligibleSnapshot {
  const order = forgetOrder(master);
  let best: SnapshotEnd | null = null;
  let uncovered: { readonly target: DeviceId; readonly endHlc: Hlc } | null = null;
  let cloud = false;
  for (const candidate of candidates) {
    const { state, end } = candidate;
    if (candidate.ok === false || order.has(state.deviceId) || state.epoch !== epoch || state.snapshot === null) continue;
    if (end === 'cloud-pending') {
      cloud = true;
      continue;
    }
    if (end === 'none' || end === 'unreadable') continue;
    if (end.author !== state.deviceId || end.epoch !== epoch || end.seq !== state.snapshot.seq || end.endHlc !== state.snapshot.endHlc) continue;
    const missing = coversForgotten(end.covers, master, ackers);
    if (missing !== null) {
      if (uncovered === null || compareText(end.endHlc, uncovered.endHlc) > 0) uncovered = { target: missing, endHlc: end.endHlc };
      continue;
    }
    if (best === null || compareText(end.endHlc, best.endHlc) > 0) best = end;
  }
  if (best !== null) return { kind: 'ok', end: best };
  if (cloud) return { kind: 'waiting', code: 'cloud-pending' };
  return { kind: 'none', uncovered: uncovered?.target ?? null };
}

/**
 * Trous (§18 point 11) : oubliés retenus dont la coupure n'est pas nulle, que le journal ne peut plus combler (`gone` : terminés, ou
 * `state.ctx` `missing`) et dont le curseur local est sous la coupure (ou absent). Non vide : reprise depuis un instantané éligible,
 * aucun instantané écrit avant. Ordre total.
 */
export function forgetGaps(master: readonly ForgottenDevice[], ackers: readonly Acker[], cursors: ReadonlyMap<DeviceId, DeviceAck>, gone: ReadonlySet<DeviceId>): readonly DeviceId[] {
  const order = forgetOrder(master);
  const live = ackers.filter((a) => !order.has(a.deviceId));
  const out: DeviceId[] = [];
  for (const target of order.keys()) {
    if (!gone.has(target)) continue;
    const cut = cutoff(target, live);
    if (cut === null) continue;
    const cursor = cursors.get(target);
    if (cursor === undefined || compareAckPositions(cursor, cut) < 0) out.push(target);
  }
  return out;
}

/** Terminés dont l'oubli est annulé (§18 point 12) : dans `done`, plus oubliés par l'ordre total. Triés. */
function revivedDevices(master: readonly ForgottenDevice[], done: readonly DeviceId[]): DeviceId[] {
  const order = forgetOrder(master);
  return [...new Set(done)].filter((id) => !order.has(id)).sort(compareText);
}

export function forgottenDeleteCheck(
  target: DeviceId,
  self: DeviceId,
  master: readonly ForgottenDevice[],
  done: readonly DeviceId[],
  known: readonly ForgetKnownDevice[],
  ownSnapshot: SnapshotEndRead,
): ForgottenDeleteCheck {
  if (target === self) return { kind: 'refused', code: 'bad-name' };
  const order = forgetOrder(master);
  const verdict = order.get(target);
  if (order.has(self) || verdict === undefined) return { kind: 'refused', code: 'state-mismatch' };
  const byId = new Map<DeviceId, ForgetKnownDevice>();
  for (const d of known) if (!byId.has(d.deviceId)) byId.set(d.deviceId, d);
  if (!byId.has(self)) byId.set(self, { deviceId: self, status: 'missing', state: null, seen: true });
  if (byId.get(target)?.status === 'cloud-pending') return { kind: 'waiting', device: target, code: 'cloud-pending', reason: 'state' };
  // (i) Terminé dont l'oubli est annulé : bloque toujours, quel que soit son état (§18 point 12).
  const revived = revivedDevices(master, done)[0];
  if (revived !== undefined) return { kind: 'waiting', device: revived, code: 'state-mismatch', reason: 'revived' };
  const authors = new Set(master.map(declarationAuthor).filter((a): a is DeviceId => a !== null));
  const actives = [...byId.values()]
    .filter((d) => !order.has(d.deviceId))
    .filter((d) => d.deviceId === self || d.status === 'ok' || d.seen || authors.has(d.deviceId))
    .sort((a, b) => compareText(a.deviceId, b.deviceId));
  const states = new Map<DeviceId, NonNullable<ForgetKnownDevice['state']>>();
  for (const d of actives) {
    if (d.status !== 'ok' || !d.state) return { kind: 'waiting', device: d.deviceId, code: d.status === 'cloud-pending' ? 'cloud-pending' : 'state-mismatch', reason: 'state' };
    states.set(d.deviceId, d.state);
  }
  const finished = done.includes(target);
  const cut = finished ? null : cutoff(target, [...states.values()]);
  if (cut !== null) {
    for (const [id, state] of states) {
      const ack = state.acks.get(target);
      if (ack === undefined || compareAckPositions(ack, cut) < 0) return { kind: 'waiting', device: id, code: 'state-mismatch', reason: 'cutoff' };
    }
  }
  for (const [id, state] of states) {
    for (const [t, v] of order) {
      if (!state.forgotten.some((f) => f.deviceId === t && f.at === v.at)) return { kind: 'waiting', device: id, code: 'state-mismatch', reason: 'declarations' };
    }
  }
  // (h) Son instantané annoncé couvre la cible jusqu'à la coupure (sans objet pour un terminé).
  if (!finished) {
    if (ownSnapshot === 'cloud-pending') return { kind: 'waiting', device: self, code: 'cloud-pending', reason: 'snapshot' };
    if (ownSnapshot === 'none' || ownSnapshot === 'unreadable') return { kind: 'waiting', device: self, code: 'state-mismatch', reason: 'snapshot' };
    const cover = ownSnapshot.covers.get(target);
    if (cut !== null && (cover === undefined || compareAckPositions(cover, cut) < 0)) return { kind: 'waiting', device: self, code: 'state-mismatch', reason: 'snapshot' };
  }
  return { kind: 'ready', by: verdict.by, cutoff: cut };
}

/**
 * Époque la plus récente d'un état lisible et accepté de chaque appareil (états donnés : acceptés par l'anti-rejeu, le sien compris).
 */
export function publishedEpochs(states: readonly Pick<PublishedDeviceState, 'deviceId' | 'epoch'>[]): Map<DeviceId, EpochId> {
  const out = new Map<DeviceId, EpochId>();
  for (const s of states) {
    const known = out.get(s.deviceId);
    if (known === undefined || compareEpochs(s.epoch, known) > 0) out.set(s.deviceId, s.epoch);
  }
  return out;
}

/**
 * Accusés sans objet (Y-11, remarques finales ; même filtre que `uncovered_forgotten` de Rust, table `reset-order.json`) : un accusé sur
 * une cible situé après la plus récente époque d'un état lisible et accepté de cette cible ne désigne rien (« début de l'époque visée »
 * sur un appareil qui n'y a rien publié) ; il est retiré avant toute coupure. Cible sans état connu : accusé gardé.
 */
export function withoutStaleAcks<T extends Pick<PublishedDeviceState, 'deviceId' | 'acks'>>(ackers: readonly T[], published: ReadonlyMap<DeviceId, EpochId>): T[] {
  return ackers.map((a) => {
    const kept = [...a.acks].filter(([target, ack]) => {
      const last = published.get(target);
      return last === undefined || compareEpochs(ack.epoch, last) <= 0;
    });
    return kept.length === a.acks.size ? a : { ...a, acks: new Map(kept) };
  });
}
