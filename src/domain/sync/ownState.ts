import type { DeviceId, Hlc } from '../types';
import { SYNC_FORMAT_MAJOR, type DeviceAck, type PublishedDeviceState } from './format';
import { publishedStateToText } from './parse';

/**
 * Règles pures de l'état publié et du statut des appareils (Y-TECH-02, point 6 : déplacées de `src/sync/engine.ts` et `src/sync/join.ts`
 * sans changement de comportement) : comparaison « réécrit seulement s'il a changé » (section 1.4, Y-TECH-01), accusés attendus, statut
 * local d'un appareil d'après son `state.ctx` au scan, appareils dont le curseur est posé à la fin d'une reprise.
 */

/** Statut du `state.ctx` d'un appareil au scan (`sync_scan`, section 11.2). */
export type DeviceStateStatus = 'ok' | 'missing' | 'cloud-pending' | 'foreign' | 'corrupt' | 'rollback' | 'too-large' | 'newer-format';

const ZERO_HLC = '000000000000000-0000-00000000-0000-4000-8000-000000000000' as Hlc;

/**
 * Texte comparé par « réécrit seulement s'il a changé » (section 1.4, audit M1) : sans `stateSeq` (le sien, celui de sa tête **et celui
 * de chaque accusé**, Y-TECH-01) ni `lastSyncHlc`. Le `stateSeq` d'un accusé change à chaque réécriture de l'appareil lu : compté, il
 * faisait réécrire l'état à chaque cycle entre appareils actifs qui se lisent (chaque écriture de l'un change l'accusé de l'autre).
 * Positions, hlc lus, instantané, horizon, liste maître (`forgotten`, qui ne fait que grandir) et annonce y restent : leur changement
 * est publié au cycle même.
 */
export function comparableState(state: PublishedDeviceState): string {
  const acks = new Map<DeviceId, DeviceAck>([...state.acks].map(([id, ack]) => [id, { ...ack, stateSeq: 0 }]));
  return publishedStateToText({ ...state, stateSeq: 0, head: { ...state.head, stateSeq: 0 }, lastSyncHlc: ZERO_HLC, acks });
}

/** États d'un autre appareil qui attendent le `stateSeq` de nos accusés (jamais `cloud-pending` : transfert en cours, rien n'attend). */
export const AWAITING_ACK_SEQ: ReadonlySet<DeviceStateStatus> = new Set(['missing', 'foreign', 'corrupt', 'rollback', 'too-large']);

/**
 * Y-TECH-01 : un accusé dont le `stateSeq` a avancé depuis le dernier état publié, sur un appareil dont le `state.ctx` est absent,
 * étranger, illisible ou rejoué à ce scan (`awaiting`), est republié aussitôt. Cet appareil attend ce `stateSeq` : borne de la règle 1
 * (état reconstruit ou rejoué sous un `stateSeq` trop bas, refusé par les autres tant qu'il ne la dépasse pas) et condition (iii) de la
 * reconstruction de `forgotten.json` (§18 point 7). Sans boucle : la ligne de cet appareil ne change que lorsqu'un de ses états est
 * accepté, et l'accusé n'est republié qu'une fois.
 */
export function ackSeqAwaited(state: PublishedDeviceState, published: PublishedDeviceState | null, awaiting: ReadonlySet<DeviceId>): boolean {
  for (const [id, ack] of state.acks) {
    if (awaiting.has(id) && ack.stateSeq > (published?.acks.get(id)?.stateSeq ?? 0)) return true;
  }
  return false;
}

/** Statut local d'un appareil d'après le statut de son `state.ctx` au scan (un état invalide garde son dernier accusé connu). */
export function deviceStatusOf(scan: { readonly stateStatus: DeviceStateStatus; readonly state: { readonly sm: number } | null }, previous: string | undefined): string {
  switch (scan.stateStatus) {
    case 'foreign':
      return 'foreign';
    case 'corrupt':
    case 'too-large':
      return 'corrupt';
    case 'rollback':
      return 'rollback';
    case 'newer-format':
      return 'newer-major';
    case 'ok':
      return scan.state && scan.state.sm > SYNC_FORMAT_MAJOR ? 'newer-major' : previous === 'clock-ahead' ? 'clock-ahead' : 'active';
    case 'missing':
    case 'cloud-pending':
      return previous ?? 'active';
  }
}

/**
 * Appareils dont le curseur est posé à la fin d'une reprise : ceux dont l'état est accepté, soi, et chaque oublié retenu présent dans
 * `covers` de l'instantané (§18 point 11 : un appareil qui n'a jamais lu X publie l'accusé **hérité** de l'instantané dont il est parti).
 */
export function cursorIds(accepted: ReadonlyMap<DeviceId, unknown>, self: DeviceId, covers: ReadonlyMap<DeviceId, unknown>, forgotten: { has(id: DeviceId): boolean }): Set<string> {
  const ids = new Set<string>([...accepted.keys(), self]);
  for (const id of covers.keys()) if (forgotten.has(id)) ids.add(id);
  return ids;
}
