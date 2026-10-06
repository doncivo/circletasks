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
import { compareEpochs, type DeviceAck, type ForgottenDevice, type PublishedDeviceState } from './format';
import { DEVICE_EXPIRY_MS, SEGMENT_PURGE_AGE_MS, TOMBSTONE_GRACE_MS } from './limits';
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

export function purgeHorizon(devices: readonly KnownDevice[], self: DeviceId, nowMs: number): PurgeHorizon {
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
export function segmentPurgeable(segment: number, input: { readonly headSegment: number; readonly coveredSegment: number; readonly readers: readonly KnownDevice[]; readonly self: DeviceId; readonly lastWriteMs: number | null; readonly nowMs: number }): boolean {
  if (segment >= input.headSegment || segment >= input.coveredSegment) return false;
  if (input.lastWriteMs === null || input.nowMs - input.lastWriteMs < SEGMENT_PURGE_AGE_MS) return false;
  return input.readers.every((reader) => {
    const ack = reader.acks.get(input.self);
    return ack !== undefined && ack.segment > segment;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Y-10 : appareils oubliés (ADR 0011 sections 14.2, 11.2 et 18). Même table de cas que `forget.rs` (tests/fixtures/sync/forget-order.json).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Déclaration d'oubli lue dans le `state.ctx` **authentifié** de l'appareil `by` (une entrée de son `forgotten`). */
export interface ForgetDeclaration {
  readonly by: DeviceId;
  readonly entry: ForgottenDevice;
}

/** Oubli retenu par l'ordre total : auteur de la déclaration valide et son hlc. */
export interface ForgetVerdict {
  readonly by: DeviceId;
  readonly at: Hlc;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ordre total des déclarations : `at` (hlc), puis l'auteur, puis la cible (aucun ex aequo entre deux entrées distinctes). */
function compareDeclarations(a: ForgetDeclaration, b: ForgetDeclaration): number {
  return compareText(a.entry.at, b.entry.at) || compareText(a.by, b.by) || compareText(a.entry.deviceId, b.entry.deviceId);
}

/**
 * Ordre total des oublis (section 14.2, second audit point 7) : les déclarations sont triées par `at` (hlc ; l'auteur puis la cible
 * départagent) et appliquées dans cet ordre. Une déclaration est **sans effet** si son auteur est déjà oublié par une déclaration
 * antérieure, si sa cible l'est déjà, si elle vise son auteur, ou si son hlc n'est pas celui de son auteur (Rust date chaque
 * déclaration avec l'identifiant de l'appareil qui oublie). Deux appareils qui s'oublient l'un l'autre : seule la plus ancienne compte.
 * Le résultat ne dépend ni de l'ordre de lecture ni des doublons. Les déclarations doivent venir d'états **authentifiés** (D5 : un
 * `forgotten` lu dans un état `foreign`, `corrupt` ou `rollback` est ignoré par l'appelant).
 */
export function forgetOrder(declarations: readonly ForgetDeclaration[]): ReadonlyMap<DeviceId, ForgetVerdict> {
  const sorted = [...declarations].sort(compareDeclarations);
  const forgotten = new Map<DeviceId, ForgetVerdict>();
  for (const { by, entry } of sorted) {
    if (entry.deviceId === by || hlcDevice(entry.at) !== by) continue;
    if (forgotten.has(by) || forgotten.has(entry.deviceId)) continue;
    forgotten.set(entry.deviceId, { by, at: entry.at });
  }
  return forgotten;
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
 * appareils actifs non oubliés, et non le seul appareil qui oublie) ; null si aucun ne l'a jamais lu. Chaque appareil lit `target`
 * jusqu'à cette position, jamais au-delà : tous finissent avec les mêmes écritures de l'appareil oublié.
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

const sameEntry = (a: ForgottenDevice, b: ForgottenDevice): boolean =>
  a.deviceId === b.deviceId &&
  a.at === b.at &&
  (a.lastAck === b.lastAck ||
    (a.lastAck !== null && b.lastAck !== null && a.lastAck.epoch === b.lastAck.epoch && a.lastAck.segment === b.lastAck.segment && a.lastAck.record === b.lastAck.record && a.lastAck.hlc === b.lastAck.hlc && a.lastAck.stateSeq === b.lastAck.stateSeq));

/**
 * `sync_write_state` (section 1.4, lot Y4) : Rust est seul maître de `forgotten`. La liste publiée par le moteur doit être celle de
 * Rust (`master`, `sync/forgotten.json`) ou son **préfixe** (déclarations confirmées et pas encore publiées : Rust complète, comme
 * `pairedBy`) ; toute autre différence (entrée ajoutée, modifiée, retirée, ordre changé) : null (`state-mismatch`). Même fonction que
 * `completed_forgotten` de `forget.rs` ; utilisée par `memory.ts`.
 */
export function completedForgotten(published: readonly ForgottenDevice[], master: readonly ForgottenDevice[]): readonly ForgottenDevice[] | null {
  if (published.length > master.length) return null;
  return published.every((entry, i) => sameEntry(entry, master[i] as ForgottenDevice)) ? [...master] : null;
}

/** Statut de lecture d'un `state.ctx` (même vocabulaire que `DeviceScan.stateStatus`). */
export type ForgetStateStatus = 'ok' | 'missing' | 'cloud-pending' | 'foreign' | 'corrupt' | 'rollback' | 'too-large' | 'newer-format';

/** Appareil connu pour la suppression : dossier de `devices/`, appareil cité dans un accusé authentifié, ou cible d'une déclaration. */
export interface ForgetKnownDevice {
  readonly deviceId: DeviceId;
  readonly status: ForgetStateStatus;
  /** État authentifié (statut `ok`) ; null sinon. */
  readonly state: Pick<PublishedDeviceState, 'deviceId' | 'stateSeq' | 'acks' | 'forgotten'> | null;
}

/**
 * Peut-on supprimer les fichiers de `target` (section 14.2, « Suppression des fichiers d'un appareil oublié », conditions (d) à (f)) ?
 * - `refused` : cible = soi (`bad-name`), aucune déclaration valide, ou appareil local oublié (`state-mismatch`) ;
 * - `waiting` : un appareil actif (non oublié, `expired` compris) bloque : son état est dans le nuage (`cloud-pending`), illisible ou
 *   absent, ou il n'a pas encore accusé la coupure ou l'état qui porte la déclaration (`state-mismatch`) ; `device` est le premier
 *   bloquant dans l'ordre des identifiants (« suppression des fichiers en attente de {appareil} ») ;
 * - `ready` : les fichiers peuvent être supprimés.
 * Seules comptent les déclarations des états `ok` (publiées et authentifiées). Même fonction que `forgotten_delete_check` (`forget.rs`).
 */
export type ForgottenDeleteCheck =
  | { readonly kind: 'ready'; readonly by: DeviceId; readonly cutoff: DeviceAck | null }
  | { readonly kind: 'waiting'; readonly device: DeviceId; readonly code: 'cloud-pending' | 'state-mismatch' }
  | { readonly kind: 'refused'; readonly code: 'bad-name' | 'state-mismatch' };

export function forgottenDeleteCheck(target: DeviceId, self: DeviceId, known: readonly ForgetKnownDevice[]): ForgottenDeleteCheck {
  if (target === self) return { kind: 'refused', code: 'bad-name' };
  const byId = new Map<DeviceId, ForgetKnownDevice>();
  for (const d of known) if (!byId.has(d.deviceId)) byId.set(d.deviceId, d);
  if (!byId.has(self)) byId.set(self, { deviceId: self, status: 'missing', state: null });
  const devices = [...byId.values()].sort((a, b) => compareText(a.deviceId, b.deviceId));
  const declarations: ForgetDeclaration[] = [];
  for (const d of devices) if (d.status === 'ok' && d.state) for (const entry of d.state.forgotten) declarations.push({ by: d.deviceId, entry });
  const order = forgetOrder(declarations);
  const verdict = order.get(target);
  if (order.has(self) || verdict === undefined) return { kind: 'refused', code: 'state-mismatch' };
  const actives = devices.filter((d) => !order.has(d.deviceId));
  const states = new Map<DeviceId, NonNullable<ForgetKnownDevice['state']>>();
  for (const d of actives) {
    if (d.status !== 'ok' || !d.state) return { kind: 'waiting', device: d.deviceId, code: d.status === 'cloud-pending' ? 'cloud-pending' : 'state-mismatch' };
    states.set(d.deviceId, d.state);
  }
  const cut = cutoff(target, [...states.values()]);
  if (cut !== null) {
    for (const [id, state] of states) {
      const ack = state.acks.get(target);
      if (ack === undefined || compareAckPositions(ack, cut) < 0) return { kind: 'waiting', device: id, code: 'state-mismatch' };
    }
  }
  const author = states.get(verdict.by);
  if (!author) return { kind: 'refused', code: 'state-mismatch' };
  for (const [id, state] of states) {
    if (id === verdict.by) continue;
    const ack = state.acks.get(verdict.by);
    if (ack === undefined || ack.stateSeq < author.stateSeq) return { kind: 'waiting', device: id, code: 'state-mismatch' };
  }
  return { kind: 'ready', by: verdict.by, cutoff: cut };
}
