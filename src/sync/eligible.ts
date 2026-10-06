import type { EpochId, ForgottenDevice, PublishedDeviceState } from '../domain/sync/format';
import { parseSnapshotRecord } from '../domain/sync/parse';
import { eligibleSnapshot, type EligibleSnapshot, type SnapshotCandidate, type SnapshotEnd, type SnapshotEndRead } from '../domain/sync/retention';
import type { DeviceId } from '../domain/types';
import { syncErrorCodeOf } from '../platform/sync/types';
import type { SyncDeps } from './deps';

/**
 * Instantané éligible (Y-10 ; ADR 0011 §14.2 et §18 point 11), partie moteur : fins d'instantané lues par `sync_read_snapshot` `tail`
 * (Rust garde chaque fin lue : un numéro n'est jamais réécrit) et choix par `eligibleSnapshot` (`retention.ts`). Seule source pour
 * rejoindre, reprendre, compter dans la règle des 7 jours et autoriser la purge d'un segment.
 */

/** Ce que l'appelant sait de la liste maître et des accusés (états `ok` des actifs, le sien compris). */
export interface ForgetCoverage {
  readonly master: readonly ForgottenDevice[];
  readonly ackers: readonly PublishedDeviceState[];
  /** Auteurs oubliés par l'ordre total : leurs fins ne sont jamais lues. */
  readonly forgotten: Pick<ReadonlySet<DeviceId>, 'has'>;
}

/** Fin de l'instantané annoncé par `state` (`none` : aucun annoncé). Une erreur de lecture vaut `unreadable`, sauf l'attente d'iCloud. */
export async function readSnapshotEnd(deps: SyncDeps, state: PublishedDeviceState): Promise<SnapshotEndRead> {
  const announced = state.snapshot;
  if (announced === null) return 'none';
  try {
    const page = await deps.platform.readSnapshot({ deviceId: state.deviceId, epoch: state.epoch, seq: announced.seq, fromRecord: 0, tail: true });
    if (page.status === 'cloud-pending') return 'cloud-pending';
    if (page.status !== 'complete') return 'unreadable';
    const record = page.records[0] === undefined ? null : parseSnapshotRecord(page.records[0]);
    if (record === null || record.k !== 'snap-end' || record.epoch !== state.epoch) return 'unreadable';
    const end: SnapshotEnd = { author: state.deviceId, epoch: state.epoch, seq: announced.seq, endHlc: announced.endHlc, covers: record.covers };
    return end;
  } catch (error) {
    const code = syncErrorCodeOf(error);
    deps.logger.log('snapshot-end-unread', { device: state.deviceId, code });
    return code === 'cloud-pending' ? 'cloud-pending' : 'unreadable';
  }
}

/** Candidats : instantané annoncé de chaque état `ok` donné (époque `epoch`, auteur non oublié), fin lue. */
export async function snapshotCandidates(deps: SyncDeps, epoch: EpochId, states: readonly PublishedDeviceState[], coverage: ForgetCoverage): Promise<SnapshotCandidate[]> {
  const out: SnapshotCandidate[] = [];
  for (const state of states) {
    if (state.epoch !== epoch || state.snapshot === null || coverage.forgotten.has(state.deviceId)) continue;
    out.push({ state, end: await readSnapshotEnd(deps, state) });
  }
  return out;
}

/** Choix parmi les candidats, en écartant les auteurs déjà essayés sans succès (`excluded`). */
export function pickEligible(candidates: readonly SnapshotCandidate[], coverage: ForgetCoverage, epoch: EpochId, excluded: ReadonlySet<DeviceId>): EligibleSnapshot {
  return eligibleSnapshot(
    candidates.filter((c) => !excluded.has(c.state.deviceId)),
    coverage.master,
    coverage.ackers,
    epoch,
  );
}
