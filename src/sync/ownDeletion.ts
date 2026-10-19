import type { Repositories } from '../db/repositories';
import { deletionStillListed, ownDeletionKey, parseOwnDeletionReceipts, type OwnDeleteFailure, type OwnDeletionReceipt } from '../domain/sync/ownDeletion';
import type { IsoDateTime } from '../domain/types';
import { SyncStateUnreadableError } from '../domain/sync/stored';
import { syncErrorCodeOf, type DeviceScan, type OwnFileRef, type SyncErrorCode } from '../platform/sync/types';
import { isCycleInterrupted } from './deadline';
import type { SyncDeps } from './deps';

// Clés persistées du contrat local (mêmes valeurs que META). Ce bloc ne doit pas importer les utilitaires du départ :
// un second consommateur à la demande les extrait du bloc principal et alourdit sa compression.
const RECEIPTS = 'ownDeletionReceipts';
const ORPHAN_FAILURE = 'orphanDeleteFailure';
const OWN_FAILURE = 'ownDeleteFailure';

/** Chargé uniquement quand une suppression est demandée ou qu'un suivi existe ; aucun accès iCloud supplémentaire. */
async function receipts(repos: Repositories): Promise<OwnDeletionReceipt[]> {
  const raw = await repos.sync.getMeta(RECEIPTS);
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new SyncStateUnreadableError('own-deletion.receipts'); }
  return parseOwnDeletionReceipts(value);
}

async function save(deps: Pick<SyncDeps, 'data'>, rows: readonly OwnDeletionReceipt[]): Promise<void> {
  await deps.data.transaction(async (repos) => {
    await repos.sync.setMeta(RECEIPTS, JSON.stringify(rows));
    const failed = rows.flatMap((r) => r.failure ? [r.failure] : []);
    const orphan = failed.find((f) => f.orphan);
    const own = failed.find((f) => !f.orphan);
    await repos.sync.setMeta(ORPHAN_FAILURE, orphan ? JSON.stringify(orphan) : null);
    await repos.sync.setMeta(OWN_FAILURE, own ? JSON.stringify(own) : null);
  });
}

/** L'absence confirme la résolution ; un reçu accepté puis listé de nouveau est une suppression non propagée. */
export async function observeOwnDeletions(deps: SyncDeps, own: DeviceScan | null, incomplete: boolean): Promise<void> {
  const rows = await receipts(deps.data.repos);
  const at = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
  const next = rows.map((row): OwnDeletionReceipt => {
    if (!deletionStillListed(row, own?.epochs ?? [])) return incomplete ? row : { ...row, failure: null };
    return row.accepted && !row.failure ? { ...row, failure: { epoch: row.epoch, kind: row.kind, orphan: row.orphan, code: 'cloud-pending', at } } : row;
  });
  if (JSON.stringify(next) !== JSON.stringify(rows)) await save(deps, next);
}

export async function readOwnDeleteFailures(repos: Repositories): Promise<readonly OwnDeleteFailure[]> {
  return (await receipts(repos)).flatMap((row) => row.failure ? [row.failure] : []);
}

export async function clearOrphanDeleteFailure(deps: SyncDeps, epoch: OwnFileRef['epoch']): Promise<void> {
  const rows = await receipts(deps.data.repos);
  const next = rows.map((row) => row.orphan && row.epoch === epoch ? { ...row, failure: null } : row);
  if (JSON.stringify(rows) !== JSON.stringify(next)) await save(deps, next);
}

/** Un bloc d'entretien qui ne charge pas reste visible, sans empêcher lecture ni publication déjà réalisées. */
export async function recordOwnDeleteFailure(deps: SyncDeps, file: OwnFileRef, code: SyncErrorCode, orphan: boolean): Promise<void> {
  const rows = await receipts(deps.data.repos);
  const key = ownDeletionKey(file);
  const previous = rows.find((row) => ownDeletionKey(row) === key);
  const failure: OwnDeleteFailure = { epoch: file.epoch, kind: file.kind, orphan, code, at: new Date(deps.clock.nowMs()).toISOString() as IsoDateTime };
  await save(deps, [...rows.filter((row) => ownDeletionKey(row) !== key), { ...file, orphan, accepted: previous?.accepted ?? false, failure }]);
}

/** Les écritures de mémo sont hors du catch transport : une erreur de base remonte au cycle. */
export async function deleteOwnTracked(deps: SyncDeps, files: readonly OwnFileRef[], orphan = false): Promise<{ readonly deleted: number; readonly code: SyncErrorCode | null }> {
  const previous = await receipts(deps.data.repos);
  const byKey = new Map(previous.map((r) => [ownDeletionKey(r), r]));
  for (const file of files) {
    const key = ownDeletionKey(file);
    if (!byKey.has(key)) byKey.set(key, { ...file, orphan, accepted: false, failure: null });
  }
  await save(deps, [...byKey.values()]);
  let deleted = 0;
  let code: SyncErrorCode | null = null;
  try {
    deleted = await deps.platform.deleteOwn(files);
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    code = syncErrorCodeOf(error);
  }
  const at = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
  for (const file of files) {
    const key = ownDeletionKey(file);
    const row = byKey.get(key) as OwnDeletionReceipt;
    // Zéro suppression avec un fichier listé, ou un retour déjà observé : attendre la confirmation d'absence au scan suivant.
    const failureCode = code ?? (deleted === 0 || (row.accepted && row.failure?.code === 'cloud-pending') ? 'cloud-pending' : null);
    byKey.set(key, { ...row, accepted: (code === null && deleted > 0) || row.accepted, failure: failureCode ? { epoch: row.epoch, kind: row.kind, orphan: row.orphan, code: failureCode, at } : null });
  }
  await save(deps, [...byKey.values()]);
  return { deleted, code };
}
