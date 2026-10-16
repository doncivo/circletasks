/**
 * Époques, règle 1 de l'ADR 0010 et choix après une restauration (ADR 0011, sections 1.4, 9 et 9.1 ; Y-02 critères 13 à 15).
 *
 * - Époque courante du dossier : la plus grande époque annoncée par un `state.ctx` authentifié (clé locale) et dotée d'un instantané
 *   complet (un appareil de cette époque annonce un instantané).
 * - Règle 1 : aucun numéro de segment, d'enregistrement ou de `stateSeq` publié n'est réutilisé ; maxima de la base locale, de son état
 *   publié, des accusés des autres appareils sur soi (et, pour le segment, des fichiers listés). Segment, enregistrement et hlc : époque
 *   courante seulement ; `stateSeq` : toutes époques confondues (avenant « Amorce »).
 * - Règle 4 : une sauvegarde plus ancienne qu'une suppression déjà purgée ailleurs ne peut qu'être appliquée partout.
 *
 * Module pur.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { compareEpochs, epochId, isEpochId, isKid, isStrictHlc, isSyncDeviceId, parseEpochId, type DeviceAck, type EpochId, type PublishedDeviceState, type RecordCursor, type ResetNotice } from './format';
import { compareAckPositions } from './retention';
import { hlcMs } from './parse';

export const compareCursors = (a: RecordCursor, b: RecordCursor): number => (a.segment !== b.segment ? a.segment - b.segment : a.record - b.record);

const maxHlc = (a: Hlc | null, b: Hlc | null): Hlc | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** Plus grande époque (ordre : numéro, puis UUID), ou null. */
export function maxEpoch(epochs: readonly (EpochId | null | undefined)[]): EpochId | null {
  let best: EpochId | null = null;
  for (const e of epochs) if (e && (best === null || compareEpochs(e, best) > 0)) best = e;
  return best;
}

/**
 * Époque courante du dossier : la plus grande annoncée par un état authentifié **avec** un instantané complet de cette époque
 * (annoncé par un des appareils qui y publient). null : aucune (dossier vide, premier appareil).
 */
export function folderEpoch(states: readonly PublishedDeviceState[]): EpochId | null {
  const withSnapshot = states.filter((s) => s.snapshot !== null).map((s) => s.epoch);
  return maxEpoch(withSnapshot);
}

/** Époque suivante ouverte par cet appareil (« Appliquer partout », époques concurrentes : la plus grande l'emporte). */
export function nextEpoch(current: EpochId | null, opener: DeviceId): EpochId {
  const n = current === null ? 0 : (parseEpochId(current)?.n ?? 0);
  return epochId(n + 1, opener);
}

/** Bornes de la règle 1 pour son propre appareil. */
export interface OwnBounds {
  /** Prochain `stateSeq` (strictement supérieur à tout `stateSeq` connu, toutes époques confondues). */
  readonly nextStateSeq: number;
  /** Tête connue dans l'époque courante (maximum des sources) ; segment 0 : rien publié dans cette époque. */
  readonly head: RecordCursor;
  /** Plus grand hlc publié dans l'époque courante. */
  readonly headHlc: Hlc | null;
  /** Plus grand numéro de segment connu dans l'époque courante (tête, accusés, fichiers listés). */
  readonly maxSegment: number;
}

export interface OwnSources {
  readonly epoch: EpochId;
  /** Ce que la base locale sait de sa propre publication. */
  readonly local: { readonly epoch: EpochId | null; readonly stateSeq: number; readonly head: DeviceAck | null };
  /** Son `state.ctx` authentifié (null : absent ou non authentifié). */
  readonly published: PublishedDeviceState | null;
  /** Accusés des autres appareils sur soi (`acks[self]` de leurs états authentifiés). */
  readonly acksOnSelf: readonly DeviceAck[];
  /** Plus grand numéro de segment listé dans son dossier pour l'époque courante. */
  readonly listedMaxSegment: number;
}

export function ownBounds(src: OwnSources): OwnBounds {
  const seqs = [src.local.stateSeq, src.published?.stateSeq ?? 0, ...src.acksOnSelf.map((a) => a.stateSeq)];
  const heads: DeviceAck[] = [
    ...(src.local.head && src.local.head.epoch === src.epoch ? [src.local.head] : []),
    ...(src.published && src.published.epoch === src.epoch ? [src.published.head] : []),
    ...src.acksOnSelf.filter((a) => a.epoch === src.epoch),
  ];
  let head: RecordCursor = { segment: 0, record: 0 };
  let headHlc: Hlc | null = null;
  for (const h of heads) {
    if (compareCursors(h, head) > 0) head = { segment: h.segment, record: h.record };
    headHlc = maxHlc(headHlc, h.hlc);
  }
  return { nextStateSeq: Math.max(...seqs) + 1, head, headHlc, maxSegment: Math.max(head.segment, src.listedMaxSegment) };
}

/**
 * Peut-on publier ? Oui si son propre état est authentifié, si un accusé d'un autre appareil sur soi fournit une borne, ou si
 * l'appareil n'a jamais rien publié (aucun fichier listé qui borne, aucun accusé, aucune trace locale) — section 1.4. `listedFiles` :
 * `listedFilesForPublish(...).counted` (Y-IOS-02-FIX-02, §24 point 10).
 */
export function canPublish(src: { readonly ownStateOk: boolean; readonly acksOnSelf: number; readonly listedFiles: number; readonly localStateSeq: number }): boolean {
  if (src.ownStateOk || src.acksOnSelf > 0) return true;
  return src.listedFiles === 0 && src.localStateSeq === 0;
}

/** Époque listée dans son propre dossier (forme du scan). */
export interface OwnEpochListing {
  readonly epoch: EpochId;
  readonly segments: readonly number[];
  readonly snapshots: readonly number[];
}

/** Sources qui disent si une époque de son dossier a été annoncée (états authentifiés, accusés) ou doit être ignorée. */
export interface ListedFilesContext {
  readonly currentEpoch: EpochId;
  /**
   * Époques annoncées par une source authentifiée : son propre état publié, les états acceptés des autres appareils, leurs accusés sur
   * soi. Une époque n'existe pour les autres appareils que par l'une d'elles.
   */
  readonly announced: readonly EpochId[];
  /** Époque orpheline déjà abandonnée (`sync_meta.orphanEpoch`) : aucun de ses fichiers ne compte, sauf si c'est l'époque courante. */
  readonly ignored?: EpochId | null;
}

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : nombre de fichiers listés de son propre dossier qui **bornent** la publication (`listedFiles`
 * de `canPublish`), et nombre d'instantanés ignorés (journal `publish-deferred`). Seule écriture de la règle ; le moteur ne fait que
 * l'appeler.
 * - Un segment compte toujours, dans n'importe quelle époque : il prouve un état publié (sa tête). Un état supprimé par un tiers avec
 *   une base restaurée garde ses segments listés : le refus de publier tient toujours.
 * - Un instantané compte s'il est dans l'époque courante (il prouve une publication antérieure, sauf à l'ouverture, déjà couverte par
 *   `openedHere`), dans une époque annoncée par une source authentifiée, ou dans une époque qui a un segment.
 * - Un instantané seul dans une époque non courante jamais annoncée ne borne rien : une époque n'existe pour les autres appareils que
 *   par un `state.ctx` authentifié qui l'annonce (`folderEpoch`), personne ne l'a donc acceptée (reste d'une orpheline, §24 point 4 (e)).
 * Même règle que Rust (`rebuild_own` ne retient que les époques listées qui ont un segment authentifié), qui reste maître de `stateSeq`
 * (`sync_write_state` refuse tout numéro non croissant). Table commune : `tests/fixtures/sync/publish-bound.json`.
 */
export function listedFilesForPublish(ownEpochs: readonly OwnEpochListing[], ctx: ListedFilesContext): { readonly counted: number; readonly ignoredSnapshots: number } {
  let counted = 0;
  let ignoredSnapshots = 0;
  for (const e of ownEpochs) {
    const current = e.epoch === ctx.currentEpoch;
    if (!current && e.epoch === (ctx.ignored ?? null)) {
      ignoredSnapshots += e.snapshots.length;
      continue;
    }
    counted += e.segments.length;
    if (current || e.segments.length > 0 || ctx.announced.includes(e.epoch)) counted += e.snapshots.length;
    else ignoredSnapshots += e.snapshots.length;
  }
  return { counted, ignoredSnapshots };
}

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : époques de son propre dossier à supprimer comme restes d'orpheline quand le mémo
 * `sync_meta.orphanEpoch` a été perdu (effacé sur un listing iCloud transitoire, suppression locale non propagée). Une époque l'est si :
 * ouverte par cet appareil, **plus grande** que l'époque courante, des instantanés et aucun segment, ni l'époque locale (`sync_meta.epoch`),
 * jamais annoncée (ni par son propre état publié, ni par un état ou un accusé d'un autre appareil). Son propre état publié doit être
 * **connu** (`ownAnnounced` non nul : écrit dans ce cycle ou lu au scan) : sinon rien n'est retenu. Triées, la plus petite d'abord.
 * Pourquoi « plus grande » : l'époque de `own.json` ne recule jamais (Rust refuse toute écriture dans une époque plus ancienne), sauf par
 * l'abandon d'une orpheline (preuve : aucun segment). Une époque plus grande que la courante n'a donc jamais reçu un segment de cet appareil,
 * même si un listing iCloud transitoire en cache une partie : sa suppression ne peut rien effacer de publié. Une orpheline plus petite que
 * l'époque courante ne borne déjà plus la publication (`listedFilesForPublish`) et part avec les anciennes époques (`maintain`).
 */
export function relistedOrphanEpochs(input: {
  readonly self: DeviceId;
  readonly ownEpochs: readonly OwnEpochListing[];
  readonly currentEpoch: EpochId;
  readonly localEpoch: EpochId | null;
  /** Époque annoncée par son propre état publié ; null : état inconnu. */
  readonly ownAnnounced: EpochId | null;
  /** Époques des états acceptés des autres appareils et de leurs accusés sur soi. */
  readonly announced: readonly EpochId[];
}): EpochId[] {
  if (input.ownAnnounced === null) return [];
  const out: EpochId[] = [];
  for (const e of input.ownEpochs) {
    if (e.segments.length > 0 || e.snapshots.length === 0) continue;
    if (parseEpochId(e.epoch)?.opener !== input.self || parseEpochId(input.currentEpoch) === null) continue;
    if (compareEpochs(e.epoch, input.currentEpoch) <= 0 || e.epoch === input.localEpoch || e.epoch === input.ownAnnounced || input.announced.includes(e.epoch)) continue;
    out.push(e.epoch);
  }
  return out.sort(compareEpochs);
}

/**
 * Y-IOS-02 (point de contrôle 0.2.3, étape 4) : époque **orpheline** = ouverte par cet appareil et jamais publiée. Preuve locale : l'époque
 * locale a un instantané enregistré localement (`storedSnapshot`), c'est le seul fichier listé dans le dossier de l'appareil (aucun segment,
 * aucune autre époque), `state.ctx` est absent (`missing` : ni illisible ni dans le nuage), `stateSeq` jamais écrit, et aucun autre appareil
 * n'a d'accusé sur lui. Une seule règle pour l'abandon de l'orpheline et pour la reprise de l'état jamais écrit.
 */
export function isOrphanEpoch(input: {
  readonly epoch: EpochId | null;
  readonly ownStateOk: boolean;
  readonly ownStateStatus: string | undefined;
  readonly acksOnSelf: number;
  readonly localStateSeq: number;
  readonly storedSnapshot: { readonly epoch: EpochId; readonly seq: number } | null;
  readonly ownEpochs: readonly OwnEpochListing[];
}): boolean {
  if (input.epoch === null || input.ownStateOk || input.ownStateStatus !== 'missing' || input.acksOnSelf !== 0 || input.localStateSeq !== 0) return false;
  if (input.storedSnapshot?.epoch !== input.epoch || input.ownEpochs.length !== 1) return false;
  const listed = input.ownEpochs[0];
  return listed !== undefined && listed.epoch === input.epoch && listed.segments.length === 0 && listed.snapshots.length === 1 && listed.snapshots[0] === input.storedSnapshot.seq;
}

/**
 * Y-IOS-02 (ADR 0011 §24 point 1) : appareils (hors soi et hors oubliés) dont l'état n'est pas encore lisible à ce scan : état dans le
 * nuage, fichiers en attente d'iCloud, époques listées sans `state.ctx` lisible (absent, illisible, trop gros), et tout appareil **connu**
 * (`expected` : celui par lequel on a été associé, ceux qui ont une ligne `sync_state`) dont aucun état `ok` n'est listé, même si son
 * dossier n'apparaît pas encore dans le scan (iCloud pas synchronisé). Tant qu'il en existe un, un appareil qui n'a suivi aucune époque
 * n'en ouvre pas : il ne sait pas encore s'il est le premier.
 */
export function unreadableDevices(
  devices: readonly { readonly deviceId: DeviceId; readonly stateStatus: string; readonly epochs: readonly unknown[]; readonly pending: readonly unknown[] }[],
  self: DeviceId,
  forgotten: { has(id: DeviceId): boolean },
  expected: readonly DeviceId[] = [],
): { readonly deviceId: DeviceId; readonly stateStatus: string }[] {
  const out = new Map<DeviceId, string>();
  for (const d of devices) {
    if (d.deviceId === self || forgotten.has(d.deviceId)) continue;
    if (d.stateStatus === 'cloud-pending' || d.pending.length > 0) out.set(d.deviceId, d.stateStatus);
    else if ((d.stateStatus === 'missing' || d.stateStatus === 'corrupt' || d.stateStatus === 'too-large') && d.epochs.length > 0) out.set(d.deviceId, d.stateStatus);
  }
  for (const id of expected) {
    if (id === self || forgotten.has(id) || out.has(id)) continue;
    const listed = devices.find((d) => d.deviceId === id);
    if (listed === undefined) out.set(id, 'absent');
    else if (listed.stateStatus === 'missing') out.set(id, 'missing');
  }
  return [...out].map(([deviceId, stateStatus]) => ({ deviceId, stateStatus }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Restauration (règles 3 et 4 ; section 9.1)
// ---------------------------------------------------------------------------------------------------------------------------------

export type RestoreOption = 'apply-everywhere' | 'keep-synced';

/** Options proposées après une restauration : seule « Appliquer partout » si la sauvegarde précède une suppression déjà purgée. */
export function restoreOptions(backupTakenAt: IsoDateTime, purgeHorizons: readonly (Hlc | null)[]): readonly RestoreOption[] {
  const taken = Date.parse(backupTakenAt);
  const purged = purgeHorizons.some((h) => h !== null && (Number.isNaN(taken) || hlcMs(h) > taken));
  return purged ? ['apply-everywhere'] : ['apply-everywhere', 'keep-synced'];
}

/**
 * `covers[B]` de l'instantané qui ouvre une époque après restauration : le **maximum** de ce que la base restaurée sait de B et de
 * l'accusé de B dans le dernier `state.ctx` publié avant la restauration (tout ce que cet appareil a vu de B est couvert).
 */
export function openingCover(restored: DeviceAck | null, published: DeviceAck | null): DeviceAck | null {
  if (!restored) return published;
  if (!published) return restored;
  if (restored.epoch !== published.epoch) return compareEpochs(restored.epoch, published.epoch) > 0 ? restored : published;
  const best = compareCursors(restored, published) >= 0 ? restored : published;
  return { ...best, hlc: maxHlc(restored.hlc, published.hlc), stateSeq: Math.max(restored.stateSeq, published.stateSeq) };
}

/** Champ à reporter dans la nouvelle époque (section 9.1 (a)) : écrit par soi, au-delà de ce que l'ouvreur avait lu de soi. */
export function mustCarry(fieldHlc: Hlc, self: DeviceId, cover: DeviceAck | null): boolean {
  if (fieldHlc.slice(21) !== self) return false;
  return cover === null || cover.hlc === null || fieldHlc > cover.hlc;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Réinitialisation avec une nouvelle clé (Y-11 ; ADR 0011 sections 14.3 et 18 point 2). Mêmes règles que `reset.rs`, même table de
// cas (`tests/fixtures/sync/reset-order.json`).
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Annonce lue dans un état authentifié : auteur (appareil dont l'état la porte), époque de cet état, annonce. `restore` (§18 point 16) :
 * époque ouverte sous l'ancienne clé (restauration), qui concourt avec les annonces ; `notice.epoch` est l'époque ouverte, `kid` et `at`
 * sont vides.
 */
export interface ResetCandidate {
  readonly by: DeviceId;
  readonly stateEpoch: EpochId;
  readonly notice: ResetNotice;
  readonly restore?: true;
}

/**
 * Validité d'une annonce : époque `e<m>-<auteur>` strictement supérieure à celle de l'état qui la porte ; `kid`, hlc, auteur stricts
 * (époque restaurée : ouvreur et époque seulement).
 */
export function validReset(c: ResetCandidate): boolean {
  if (!isSyncDeviceId(c.by) || !isEpochId(c.notice.epoch) || !isEpochId(c.stateEpoch)) return false;
  if (parseEpochId(c.notice.epoch)?.opener !== c.by) return false;
  return compareEpochs(c.notice.epoch, c.stateEpoch) > 0 && (c.restore === true || (isKid(c.notice.kid) && isStrictHlc(c.notice.at)));
}

/** État `ok` sous l'ancienne clé vu pour les époques restaurées : auteur, époque, instantané annoncé, annonce portée. */
export interface OpenedEpoch {
  readonly by: DeviceId;
  readonly epoch: EpochId;
  readonly snapshot: boolean;
  readonly notice: boolean;
}

/**
 * Époques ouvertes sous l'ancienne clé qui concourent avec les annonces (§18 point 16, complément 1) : état sans annonce, instantané
 * annoncé, ouvreur = auteur, époque supérieure à celle de l'état qui porte une annonce (la plus petite). Aucune annonce : aucune.
 */
export function restoreCandidates(states: readonly OpenedEpoch[], announcements: readonly ResetCandidate[]): ResetCandidate[] {
  let base: EpochId | null = null;
  for (const a of announcements) {
    if (a.restore || !validReset(a)) continue;
    if (base === null || compareEpochs(a.stateEpoch, base) < 0) base = a.stateEpoch;
  }
  if (base === null) return [];
  const from = base;
  return states
    .filter((s) => !s.notice && s.snapshot && isEpochId(s.epoch) && parseEpochId(s.epoch)?.opener === s.by && compareEpochs(s.epoch, from) > 0)
    .map((s) => ({ by: s.by, stateEpoch: from, notice: { kid: '', epoch: s.epoch, at: '' as ResetNotice['at'] }, restore: true as const }));
}

/**
 * Gagnant de réinitialisations simultanées : annonce valide d'un auteur non oublié dont l'époque est la plus grande (numéro, puis
 * UUID), sans autre critère (ni `kid` ni `at`) ; à époque égale, la première rencontrée (impossible après l'anti-rejeu).
 */
export function resetWinner(candidates: readonly ResetCandidate[], forgotten: ReadonlySet<DeviceId>): ResetCandidate | null {
  let best: ResetCandidate | null = null;
  for (const c of candidates) {
    if (!validReset(c) || forgotten.has(c.by)) continue;
    if (best === null || compareEpochs(c.notice.epoch, best.notice.epoch) > 0) best = c;
  }
  return best;
}

/** Appareil actif vu par la précondition (statut de son état, tête publiée, expiré à 180 jours, fantôme jamais vu). */
export interface ResetPreconditionDevice {
  readonly deviceId: DeviceId;
  readonly status: string;
  readonly head: DeviceAck | null;
  readonly expired: boolean;
  readonly phantom: boolean;
}

export type ResetLagReason = 'state' | 'head' | 'cutoff';

/**
 * Précondition (§14.3 étape 1) : chaque appareil actif (ni expiré, ni fantôme) a un état authentifié et ses accusés (`ownAcks`) atteignent
 * sa tête ; chaque oublié retenu est lu jusqu'à sa coupure (l'instantané d'ouverture le couvre, dette « changement d'époque »). Premier
 * appareil en retard (identifiants triés, actifs d'abord) ; null : la réinitialisation peut commencer.
 */
export function resetPrecondition(
  actives: readonly ResetPreconditionDevice[],
  forgotten: readonly { readonly deviceId: DeviceId; readonly cutoff: DeviceAck | null }[],
  ownAcks: ReadonlyMap<DeviceId, DeviceAck>,
): { readonly device: DeviceId; readonly reason: ResetLagReason } | null {
  for (const d of [...actives].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))) {
    if (d.expired || d.phantom) continue;
    if (d.status !== 'ok') return { device: d.deviceId, reason: 'state' };
    if (!d.head || (d.head.segment === 0 && d.head.record === 0)) continue;
    const ack = ownAcks.get(d.deviceId);
    if (!ack || ack.epoch !== d.head.epoch || compareAckPositions(ack, d.head) < 0) return { device: d.deviceId, reason: 'head' };
  }
  for (const f of [...forgotten].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))) {
    if (!f.cutoff) continue;
    const ack = ownAcks.get(f.deviceId);
    if (!ack || compareAckPositions(ack, f.cutoff) < 0) return { device: f.deviceId, reason: 'cutoff' };
  }
  return null;
}

/**
 * Appareil connu pendant la transition : statut, époque et `kid` de l'état présenté, vu (anti-rejeu, accusé d'un actif), auteur d'un
 * oubli.
 */
export interface ResetKnownDevice {
  readonly deviceId: DeviceId;
  readonly status: string;
  readonly epoch: EpochId | null;
  readonly kid: string | null;
  readonly seen: boolean;
  readonly author: boolean;
}

/**
 * Appareils pas encore réassociés (§14.3 étape 5) : connus, ni soi, ni oubliés, ni fantômes (jamais vus et illisibles), dont l'état
 * n'est pas un état authentifié de l'époque visée sous la nouvelle clé (`kid`, audit 4). Triés ; vide : la bascule peut se faire.
 */
export function resetWaiting(known: readonly ResetKnownDevice[], self: DeviceId, epoch: EpochId, kid: string, forgotten: ReadonlySet<DeviceId>): DeviceId[] {
  const out = new Set<DeviceId>();
  for (const d of known) {
    if (d.deviceId === self || forgotten.has(d.deviceId)) continue;
    if (d.status !== 'ok' && !d.seen && !d.author) continue;
    if (d.status === 'ok' && d.epoch === epoch && d.kid === kid) continue;
    out.add(d.deviceId);
  }
  return [...out].sort();
}
