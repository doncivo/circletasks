import type { DeletedRow, Repositories, SyncStateRow } from '../db/repositories';
import { parseStoredAcks, type StoredStateLog } from '../domain/sync/stored';
import { defaultSyncLogger } from './log';
import { CONFLICT_LOG_RETENTION_MONTHS, MAX_CONFLICT_LOG_ROWS, MAX_PARKED_OPS, MAX_UNKNOWN_BYTES, MAX_UNKNOWN_FIELDS, PAGE_ROWS, compareEpochs, isDeviceAck, type DeviceAck, type EpochId, type PublishedDeviceState, type SyncField, type SyncOp } from '../domain/sync/format';
import { BLOCKED, canPurgeDeletion, coversForgotten, publishedAllRead, purgeBefore, purgeHorizon, segmentPurgeable, activeReaders, type KnownDevice, type PurgeHorizon } from '../domain/sync/retention';
import type { ForgetCoverage } from './eligible';
import { revivedDone } from './forget';
import { isStrictHlc } from '../domain/sync/format';
import { SYNC_TABLES, isPurgeable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { syncErrorCodeOf, type DeviceScan } from '../platform/sync/types';
import { applyOps } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { META, readJson, writeJson } from './meta';
import { purgeRows } from './purge';

/**
 * Entretien de fin de cycle (ADR 0011, sections 1.6, 5.3, 5.4, 9 et 10.2 étape 7 ; Y-02 critères 11 et 20, Y-09 critères 2, 3, 6 et 11) :
 * opérations mises de côté retentées, purge des lignes supprimées (traces sans contenu), purge de ses segments et anciennes époques,
 * plafonds de `sync_parked`, `sync_unknown` et `conflict_log`.
 */

/** Appareils connus (lignes de `sync_state`) sous la forme attendue par `retention.ts`. */
export function knownDevices(rows: readonly SyncStateRow[], log: StoredStateLog): KnownDevice[] {
  // Accusés illisibles : `state-unreadable` (jamais « aucun » : une purge ne doit pas se fonder sur un accusé perdu).
  return rows.filter((row) => !row.isSelf).map((row) => ({ deviceId: row.deviceId as DeviceId, status: row.status, lastSeenHlc: row.lastSeenHlc, acks: parseStoredAcks(row.lastAcks, 'sync_state.last_acks', log) }));
}

/**
 * Horizon de purge courant hors cycle (corbeille au démarrage, Y-09) : `unbounded` sans autre appareil actif ; `blocked` tant qu'un
 * appareil actif a des écritures publiées non lues (curseur avant sa tête dans `sync_state`, état invalide) : une suppression lue par
 * tous peut avoir été suivie d'une restauration encore dans le nuage.
 */
export async function currentPurgeHorizon(repos: Repositories, self: DeviceId, nowMs: number, log: StoredStateLog = defaultSyncLogger): Promise<PurgeHorizon> {
  const rows = await repos.sync.getStates();
  // Y-10 (§18 point 12) : un terminé dont l'oubli est annulé bloque toute purge, au démarrage aussi.
  const horizon = purgeHorizon(knownDevices(rows, log), self, nowMs, await revivedDone(repos));
  if (horizon.kind !== 'limited') return horizon;
  const active = new Set<string>(horizon.readers.map((r) => r.deviceId));
  const unread = rows.some(
    (row) =>
      active.has(row.deviceId) &&
      !publishedAllRead({ status: row.status, epoch: row.epoch, stateEpoch: row.stateEpoch, cursor: { segment: row.cursorSegment, record: row.cursorRecord }, head: { segment: row.headSegment, record: row.headRecord } }),
  );
  return unread ? BLOCKED : horizon;
}

/**
 * Purge des lignes supprimées de toutes les tables publiées (sauf `settings` et espaces fixes), enfants d'abord : sous garde, avec
 * inscription des identifiants dans `sync_tombstone` et des rappels visés (T-08) dans la même transaction (`purge.ts`). La suppression
 * est **revérifiée dans la transaction gardée** (une restauration ou une nouvelle écriture entre la lecture et la purge l'emporte) ; les
 * pages sont parcourues par identifiant, une page entièrement retenue n'arrête pas le parcours. `sync_meta.purgeHorizon` (plus grand hlc
 * de suppression purgé, règle 4) est relevé dans la même transaction, quel que soit l'appelant (cycle ou corbeille T-08).
 */
export async function purgeDeleted(deps: Pick<SyncDeps, 'data' | 'logger'>, horizon: PurgeHorizon, nowMs: number): Promise<{ readonly count: number; readonly maxPurged: Hlc | null }> {
  let maxPurged: Hlc | null = null;
  const before = purgeBefore(nowMs);
  const purgedAt = new Date(nowMs).toISOString() as IsoDateTime;
  let total = 0;
  for (const t of [...SYNC_TABLES].reverse()) {
    if (!t.purgeable) continue;
    let after: string | null = null;
    for (;;) {
      const page = await deps.data.repos.sync.deletedRows(t, before, PAGE_ROWS, after);
      if (page.length === 0) break;
      after = (page.at(-1) as DeletedRow).id;
      const candidates = page.filter((row) => isPurgeable(t.name, row.id) && isStrictHlc(row.deletedHlc) && canPurgeDeletion(row, horizon, nowMs));
      if (candidates.length > 0) {
        const purged = await guarded(deps.data, async (repos) => {
          const ids = candidates.map((c) => c.id);
          const [rows, clocks] = await Promise.all([repos.sync.readRows(t, ids), repos.sync.readClocks(t, ids)]);
          const still = candidates.filter((c) => {
            const row = rows.get(c.id);
            if (!row || row.values.get('deleted_at') !== c.deletedAt) return false;
            const rowClocks = clocks.get(c.id);
            return (rowClocks?.get('deleted_at') ?? rowClocks?.get('*') ?? { hlc: row.hlc }).hlc === c.deletedHlc;
          });
          const done = (await purgeRows(repos, t, still, purgedAt, deps.logger)).purged;
          let pageMax: Hlc | null = null;
          for (const item of done) if (pageMax === null || item.deletedHlc > pageMax) pageMax = item.deletedHlc;
          if (pageMax !== null) {
            const previous = await readJson<Hlc>(repos, META.purgeHorizon);
            if (previous === null || pageMax > previous) await writeJson(repos, META.purgeHorizon, pageMax);
          }
          return { count: done.length, max: pageMax };
        });
        if (purged.max !== null && (maxPurged === null || purged.max > maxPurged)) maxPurged = purged.max;
        total += purged.count;
      }
      if (page.length < PAGE_ROWS) break;
    }
  }
  if (total > 0) deps.logger.log('purged', { rows: total, tombstones: await deps.data.repos.sync.tombstoneCount() });
  return { count: total, maxPurged };
}

/** Rejoue les opérations mises de côté (parent ou ligne absents) ; les retire si elles passent ou sont refusées. */
export async function retryParked(deps: SyncDeps): Promise<Map<string, Set<string>>> {
  const touched = new Map<string, Set<string>>();
  let after = 0;
  for (;;) {
    const parked = await deps.data.repos.sync.parked(['missing-parent', 'missing-row'], after, PAGE_ROWS);
    if (parked.length === 0) break;
    after = (parked.at(-1) as { id: number }).id;
    const ops: SyncOp[] = [];
    for (const p of parked) {
      const raw = JSON.parse(p.op) as { t: string; id: string; at: string; f: Record<string, SyncField> };
      ops.push({ t: raw.t, id: raw.id, at: raw.at as IsoDateTime, f: new Map(Object.entries(raw.f)) });
    }
    const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
    await guarded(deps.data, async (repos) => {
      const result = await applyOps(repos, ops, { localSv: deps.sv, remoteSv: deps.sv, now, knows: () => true, logger: deps.logger, noPark: true });
      const done = parked.filter((_, i) => result.outcomes[i] !== 'parked').map((p) => p.id);
      await repos.sync.removeParked(done);
      for (const [table, ids] of result.touched) touched.set(table, new Set([...(touched.get(table) ?? []), ...ids]));
    });
  }
  return touched;
}

export interface MaintenanceInput {
  readonly epoch: EpochId;
  readonly head: DeviceAck;
  readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>;
  readonly ownScan: DeviceScan | null;
  readonly rows: readonly SyncStateRow[];
  /** Y-10 (§18 point 11) : son instantané ne compte pour la purge des segments que s'il couvre chaque oublié retenu. */
  readonly coverage?: ForgetCoverage;
  /** Y-10 (§18 point 12) : terminés dont l'oubli est annulé (horizon `blocked`). */
  readonly revived?: readonly DeviceId[];
  /** Y-11 : réinitialisation en cours : anciennes époques gardées (supprimées par la bascule, ou relues si elle perd). */
  readonly keepOldEpochs?: boolean;
}

/** Son dernier instantané couvre-t-il chaque oublié retenu (§18 point 11, éligibilité) ? Sans oublié retenu : toujours. */
function ownSnapshotEligible(covers: Record<string, unknown> | undefined, coverage: ForgetCoverage | undefined): boolean {
  if (!coverage || coverage.master.length === 0) return true;
  if (covers === undefined) return false;
  const map = new Map<DeviceId, DeviceAck>();
  for (const [id, ack] of Object.entries(covers)) if (isDeviceAck(ack)) map.set(id as DeviceId, ack);
  return coversForgotten(map, coverage.master, coverage.ackers) === null;
}

export async function maintain(deps: SyncDeps, input: MaintenanceInput): Promise<void> {
  const { data, platform, logger } = deps;
  const nowMs = deps.clock.nowMs();
  const devices = knownDevices(input.rows, logger);
  const horizon = purgeHorizon(devices, deps.deviceId, nowMs, input.revived ?? []);

  // Lignes supprimées : 30 jours ET lues par tous les appareils actifs.
  await purgeDeleted(deps, horizon, nowMs);

  // Ses segments : couverts par un instantané, accusés par tous, dernier enregistrement de plus de 30 jours.
  const snapshot = await readJson<{ epoch: EpochId; seq: number; endHlc: Hlc; coveredSegment?: number; covers?: Record<string, unknown> }>(data.repos, META.snapshot);
  const covered = Math.max(
    0,
    ...[...input.accepted.values()].filter((s) => s.epoch === input.epoch).map((s) => s.acks.get(deps.deviceId)?.segment ?? 0),
    snapshot?.epoch === input.epoch && ownSnapshotEligible(snapshot.covers, input.coverage) ? (snapshot.coveredSegment ?? 0) : 0,
  );
  const times = (await readJson<Record<string, number>>(data.repos, META.segments)) ?? {};
  const listed = input.ownScan?.epochs.find((e) => e.epoch === input.epoch)?.segments ?? [];
  const readers = activeReaders(devices, deps.deviceId, nowMs);
  const removable = listed.filter((n) =>
    segmentPurgeable(n, { headSegment: input.head.segment, coveredSegment: covered, readers, self: deps.deviceId, lastWriteMs: times[`${input.epoch}/${String(n)}`] ?? null, nowMs }),
  );
  if (removable.length > 0) {
    try {
      await platform.deleteOwn(removable.map((n) => ({ epoch: input.epoch, kind: 'j' as const, n })));
      logger.log('segments-purged', { count: removable.length });
    } catch (error) {
      // Journalisé (aucun échec silencieux) ; retentée au cycle suivant.
      logger.log('delete-own-failed', { kind: 'j', code: syncErrorCodeOf(error) });
    }
  }

  // Anciennes époques : supprimées quand tous les appareils actifs annoncent l'époque courante.
  const older = (input.ownScan?.epochs ?? []).filter((e) => compareEpochs(e.epoch, input.epoch) < 0);
  const allMoved = readers.every((r) => input.accepted.get(r.deviceId)?.epoch === input.epoch);
  if (older.length > 0 && allMoved && input.keepOldEpochs !== true) {
    try {
      await platform.deleteOwn(older.map((e) => ({ epoch: e.epoch, kind: 'epoch' as const })));
      logger.log('old-epochs-deleted', { count: older.length });
    } catch (error) {
      // Journalisé (aucun échec silencieux) ; retentée au cycle suivant.
      logger.log('delete-own-failed', { kind: 'epoch', code: syncErrorCodeOf(error) });
    }
  }

  // Plafonds (section 1.6) ; abandons journalisés sans contenu.
  const before = new Date(nowMs);
  before.setUTCMonth(before.getUTCMonth() - CONFLICT_LOG_RETENTION_MONTHS);
  const dropped = await data.repos.sync.enforceCaps({
    parked: MAX_PARKED_OPS,
    unknownFields: MAX_UNKNOWN_FIELDS,
    unknownBytes: MAX_UNKNOWN_BYTES,
    conflicts: MAX_CONFLICT_LOG_ROWS,
    conflictsBefore: before.toISOString() as IsoDateTime,
  });
  for (const item of dropped) logger.log('cap-dropped', { kind: item.kind, table: item.table, id: item.rowId, reason: item.reason });
}
