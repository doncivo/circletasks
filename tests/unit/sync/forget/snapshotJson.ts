import type { DeviceAck, EpochId } from '../../../../src/domain/sync/format';
import type { SnapshotEndRead } from '../../../../src/domain/sync/retention';
import type { DeviceId, Hlc } from '../../../../src/domain/types';

/**
 * Forme JSON d'une fin d'instantané dans les tables de cas Y-10 (`forget-order.json`, `forget-order-random.json`) : chaîne (`none`,
 * `cloud-pending`, `unreadable`) ou objet `{ author, epoch, seq, endHlc, covers }` (accusés par appareil). Même lecture que `snapshot_of`
 * dans `sync_forget.rs`.
 */
export function snapshotReadOf(value: unknown): SnapshotEndRead {
  if (value === 'none' || value === 'cloud-pending' || value === 'unreadable') return value;
  const end = value as { author: string; epoch: string; seq: number; endHlc: string; covers: Record<string, DeviceAck> };
  return { author: end.author as DeviceId, epoch: end.epoch as EpochId, seq: end.seq, endHlc: end.endHlc as Hlc, covers: new Map(Object.entries(end.covers) as [DeviceId, DeviceAck][]) };
}

/** Fin d'instantané rendue en JSON (sortie d'`eligibleSnapshot` comparée à la table). */
export function snapshotEndJson(end: Exclude<SnapshotEndRead, string>): unknown {
  return { author: end.author, epoch: end.epoch, seq: end.seq, endHlc: end.endHlc, covers: Object.fromEntries(end.covers) };
}
