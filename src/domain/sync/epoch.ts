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
import { compareEpochs, epochId, parseEpochId, type DeviceAck, type EpochId, type PublishedDeviceState, type RecordCursor } from './format';
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
 * l'appareil n'a jamais rien publié (aucun fichier listé, aucun accusé, aucune trace locale) — section 1.4.
 */
export function canPublish(src: { readonly ownStateOk: boolean; readonly acksOnSelf: number; readonly listedFiles: number; readonly localStateSeq: number }): boolean {
  if (src.ownStateOk || src.acksOnSelf > 0) return true;
  return src.listedFiles === 0 && src.localStateSeq === 0;
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
