import type { EpochId } from '../domain/sync/format';
import { hlcDevice } from '../domain/sync/parse';
import { isCycleInterrupted } from './deadline';
import type { DeviceScan, FolderScan } from '../platform/sync/types';
import type { DeviceId } from '../domain/types';
import type { PublishedDeviceState } from '../domain/sync/format';
import { relistedOrphanEpochs } from '../domain/sync/orphanRelist';
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
 * son code (comme les autres suppressions de l'étape 7), retenté à chaque cycle ; ni la lecture ni la publication n'attendent. Seule voie de
 * suppression, aussi pour une orpheline dont le mémo perdu a été réarmé par le moteur (`orphan-epoch-relisted`, Y-IOS-02-FIX-02, §24 point 10).
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
    const deleted = await platform.deleteOwn([{ epoch: left.epoch, kind: 'epoch' }]);
    await writeJson(repos, META.orphanEpoch, null);
    // Revue Y-IOS-02-FIX-02, point 4 : `orphan-epoch-deleted` seulement si un fichier a été effacé ; sinon l'époque listée n'existait déjà
    // plus sur le disque (suppression locale pas encore propagée par iCloud) : `orphan-epoch-already-gone`, jamais un faux succès.
    if (deleted > 0) logger.log('orphan-epoch-deleted', { epoch: left.epoch });
    else logger.log('orphan-epoch-already-gone', { epoch: left.epoch.slice(0, 14) });
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    logger.log('orphan-epoch-delete-failed', { code: syncErrorCodeOf(error) });
  }
}

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : mémo `orphanEpoch` perdu (cause racine : substitut `.icloud` d'un fichier évincé que le plugin ne
 * supprimait pas) alors qu'une époque jamais annoncée ne garde que des instantanés dans son dossier : réarmé, puis supprimé par la voie unique
 * (`retryOrphanDeletion`). Jamais sans son propre état publié connu, jamais tant qu'un autre appareil non oublié a un état qui ne se lit pas
 * à ce scan (revue, point 2 : son annonce échapperait au contrôle, et `sync_delete_own` ne protège que l'époque courante) : illisible, dans
 * le nuage, en attente (`unreadable`), ou non accepté (étranger, rejoué, trop grand, version plus récente). Un dossier sans `state.ctx` ni
 * fichier n'annonce rien. Le moteur a déjà vérifié : aucune réinitialisation, mémo nul, au moins une époque candidate listée.
 */
export async function relistOrphanEpoch(
  deps: SyncDeps,
  input: {
    readonly scan: FolderScan;
    readonly ownScan: DeviceScan | null;
    readonly currentEpoch: EpochId;
    /** Son propre état publié (écrit dans ce cycle, sinon lu au scan). */
    readonly own: PublishedDeviceState | null;
    /** Époques des états acceptés des autres appareils et de leurs accusés sur soi. */
    readonly announced: readonly EpochId[];
    readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>;
    readonly forgotten: { has(id: DeviceId): boolean };
    /** Nombre d'appareils dont l'état ne se lit pas à ce scan (`unreadableDevices`). */
    readonly unreadable: number;
  },
): Promise<void> {
  const { data, logger, deviceId: self } = deps;
  const othersReadable =
    input.unreadable === 0 &&
    input.scan.devices.every((d) => d.deviceId === self || input.forgotten.has(d.deviceId) || input.accepted.has(d.deviceId) || (d.stateStatus === 'missing' && d.epochs.length === 0 && d.pending.length === 0));
  if (!othersReadable) return;
  const first = relistedOrphanEpochs({
    self,
    ownEpochs: input.ownScan?.epochs ?? [],
    currentEpoch: input.currentEpoch,
    localEpoch: await readJson<EpochId>(data.repos, META.epoch),
    ownAnnounced: input.own?.epoch ?? null,
    announced: input.announced,
  })[0];
  if (first === undefined) return;
  await writeJson(data.repos, META.orphanEpoch, { epoch: first });
  // Époque tronquée (numéro et 8 premiers caractères de l'ouvreur) : lisible dans l'export, jamais masquée comme un jeton.
  logger.log('orphan-epoch-relisted', { epoch: first.slice(0, 14) });
}
