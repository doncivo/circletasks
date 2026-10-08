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

/**
 * Fins lues, par plateforme (une session : un dossier, une clé) et par (appareil, époque, numéro, hlc de fin) : un instantané annoncé n'est
 * jamais réécrit sous le même numéro ; seules les fins lisibles sont gardées (troisième revue Y-10, point 1 : sans cela chaque cycle
 * redemandait la fin de chaque instantané annoncé).
 */
const endCache = new WeakMap<object, Map<string, SnapshotEnd>>();

/** Fin de l'instantané annoncé par `state` (`none` : aucun annoncé). Une erreur de lecture vaut `unreadable`, sauf l'attente d'iCloud. */
export async function readSnapshotEnd(deps: SyncDeps, state: PublishedDeviceState): Promise<SnapshotEndRead> {
  const announced = state.snapshot;
  if (announced === null) return 'none';
  const cache = endCache.get(deps.platform) ?? new Map<string, SnapshotEnd>();
  endCache.set(deps.platform, cache);
  const key = `${state.deviceId}|${state.epoch}|${String(announced.seq)}|${announced.endHlc}`;
  const cached = cache.get(key);
  if (cached) return cached;
  deps.deadline?.check('snapshot-read');
  try {
    const page = await deps.platform.readSnapshot({ deviceId: state.deviceId, epoch: state.epoch, seq: announced.seq, fromRecord: 0, tail: true });
    if (page.status === 'cloud-pending') return 'cloud-pending';
    if (page.status !== 'complete') return 'unreadable';
    const record = page.records[0] === undefined ? null : parseSnapshotRecord(page.records[0]);
    if (record === null || record.k !== 'snap-end' || record.epoch !== state.epoch) return 'unreadable';
    const end: SnapshotEnd = { author: state.deviceId, epoch: state.epoch, seq: announced.seq, endHlc: announced.endHlc, covers: record.covers };
    cache.set(key, end);
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
  // Le plus récent lu en dernier : Rust garde les octets du dernier instantané lu, souvent celui que la reprise lira ensuite par pages.
  const ordered = [...states].sort((a, b) => ((a.snapshot?.endHlc ?? '') < (b.snapshot?.endHlc ?? '') ? -1 : 1));
  for (const state of ordered) {
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
