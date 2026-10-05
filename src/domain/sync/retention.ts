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
import type { DeviceAck } from './format';
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

/** Horizon de purge : sans autre appareil actif (synchro non configurée, appareil seul), rien ne retient une trace. */
export type PurgeHorizon = { readonly kind: 'unbounded' } | { readonly kind: 'limited'; readonly readers: readonly KnownDevice[] };

export const UNBOUNDED: PurgeHorizon = { kind: 'unbounded' };

export function purgeHorizon(devices: readonly KnownDevice[], self: DeviceId, nowMs: number): PurgeHorizon {
  const readers = activeReaders(devices, self, nowMs);
  return readers.length === 0 ? UNBOUNDED : { kind: 'limited', readers };
}

/** Tous les appareils actifs ont-ils lu l'écriture `hlc` (accusé de son écrivain supérieur ou égal) ? */
export function readByAll(hlc: Hlc, horizon: PurgeHorizon): boolean {
  if (horizon.kind === 'unbounded') return true;
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
