import type { EpochId } from '../domain/sync/format';
import { hlcDevice } from '../domain/sync/parse';
import { isCycleInterrupted } from './deadline';
import type { DeviceScan } from '../platform/sync/types';
import type { SyncDeps } from './deps';
import { queueOwnRowsForRepublish } from './epochSwitch';
import { META, readJson, writeJson } from './meta';
import { syncErrorCodeOf, type SyncErrorCode } from '../platform/sync/types';

/**
 * Abandon d'une époque orpheline (ADR 0011 §24 point 4, étapes (a) à (c)). Module chargé **à la demande** par le moteur (cas rare : taille du
 * bundle de départ). Étapes idempotentes, reprises à l'étape interrompue :
 * (a) lignes remises dans la file d'envoi, traces purgées mémorisées (garde `orphan-trace-hit`), intention `orphanEpoch` ;
 * (b) `own.json` sans époque (Rust recontrôle la preuve) : `state-mismatch` annule l'abandon (rien n'est écrit) ;
 * (c) transaction locale : l'appareil n'a plus d'époque suivie, la reprise en fusion suit.
 */
export type AbandonResult = { readonly kind: 'done'; readonly rows: number } | { readonly kind: 'refused' } | { readonly kind: 'failed'; readonly code: SyncErrorCode };

export async function abandonOrphan(deps: SyncDeps, orphan: EpochId): Promise<AbandonResult> {
  const { data, platform, logger, deviceId: self } = deps;
  const repos = data.repos;
  const queued = await queueOwnRowsForRepublish(deps);
  const traces: string[] = [];
  for (let after: { table: string; rowId: string } | null = null; ; ) {
    const page = await repos.sync.exportTombstones(after, 500);
    if (page.length === 0) break;
    const last = page[page.length - 1] as { table: string; rowId: string };
    after = { table: last.table, rowId: last.rowId };
    for (const tomb of page) if (hlcDevice(tomb.deletedHlc) === self) traces.push(`${tomb.table}|${tomb.rowId}`);
  }
  await writeJson(repos, META.orphanTraces, traces.length > 0 ? traces : null);
  await writeJson(repos, META.orphanEpoch, { epoch: orphan });
  deps.deadline?.check('append');
  try {
    await platform.abandonOrphanEpoch(orphan);
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    const code = syncErrorCodeOf(error);
    logger.log('orphan-epoch-abandon-failed', { code });
    if (code !== 'state-mismatch') return { kind: 'failed', code };
    await writeJson(repos, META.orphanEpoch, null);
    return { kind: 'refused' };
  }
  await data.transaction(async (tx) => {
    await writeJson(tx, META.epoch, null);
    await writeJson(tx, META.head, null);
    await writeJson(tx, META.snapshot, null);
    await writeJson(tx, META.lastState, null);
    await writeJson(tx, META.resume, true);
    await tx.sync.saveState(self, { epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
  logger.log('epoch-abandoned', { epoch: orphan, rows: queued });
  return { kind: 'done', rows: queued };
}

/**
 * Point 4 (e) : fichiers de l'orpheline abandonnée, supprimés au mieux par `sync_delete_own` (l'époque n'est plus courante). Échec : journal avec
 * son code (comme les autres suppressions de l'étape 7), retenté à chaque cycle ; ni la lecture ni la publication n'attendent.
 */
export async function retryOrphanDeletion(deps: SyncDeps, ownScan: DeviceScan | null, currentEpoch: EpochId): Promise<void> {
  const { data, platform, logger } = deps;
  const repos = data.repos;
  const left = await readJson<{ epoch: EpochId }>(repos, META.orphanEpoch);
  if (left === null || left.epoch === currentEpoch || (await readJson<EpochId>(repos, META.epoch)) === left.epoch) return;
  if (!ownScan?.epochs.some((e) => e.epoch === left.epoch)) {
    await writeJson(repos, META.orphanEpoch, null);
    logger.log('orphan-epoch-cleared', { epoch: left.epoch });
    return;
  }
  deps.deadline?.check('delete-own');
  try {
    await platform.deleteOwn([{ epoch: left.epoch, kind: 'epoch' }]);
    await writeJson(repos, META.orphanEpoch, null);
    logger.log('orphan-epoch-deleted', { epoch: left.epoch });
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    logger.log('orphan-epoch-delete-failed', { code: syncErrorCodeOf(error) });
  }
}
