import type { Repositories, SyncStateRow } from '../db/repositories';
import { CONFLICT_LOG_RETENTION_MONTHS, MAX_CONFLICT_LOG_ROWS, MAX_PARKED_OPS, MAX_UNKNOWN_BYTES, MAX_UNKNOWN_FIELDS, PAGE_ROWS, compareEpochs, isDeviceAck, type DeviceAck, type EpochId, type PublishedDeviceState, type SyncField, type SyncOp } from '../domain/sync/format';
import { canPurgeDeletion, purgeBefore, purgeHorizon, segmentPurgeable, activeReaders, type KnownDevice, type PurgeHorizon } from '../domain/sync/retention';
import { isStrictHlc } from '../domain/sync/format';
import { SYNC_TABLES, isPurgeable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import type { DeviceScan } from '../platform/sync/types';
import { applyOps } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { META, readJson, writeJson } from './meta';

/**
 * Entretien de fin de cycle (ADR 0011, sections 1.6, 5.3, 5.4, 9 et 10.2 étape 7 ; Y-02 critères 11 et 20, Y-09 critères 2, 3, 6 et 11) :
 * opérations mises de côté retentées, purge des lignes supprimées (traces sans contenu), purge de ses segments et anciennes époques,
 * plafonds de `sync_parked`, `sync_unknown` et `conflict_log`.
 */

/** Appareils connus (lignes de `sync_state`) sous la forme attendue par `retention.ts`. */
export function knownDevices(rows: readonly SyncStateRow[]): KnownDevice[] {
  return rows
    .filter((row) => !row.isSelf)
    .map((row) => {
      const acks = new Map<DeviceId, DeviceAck>();
      try {
        for (const [id, ack] of Object.entries(JSON.parse(row.lastAcks) as Record<string, unknown>)) if (isDeviceAck(ack)) acks.set(id as DeviceId, ack);
      } catch {
        // accusés illisibles : aucun
      }
      return { deviceId: row.deviceId as DeviceId, status: row.status, lastSeenHlc: row.lastSeenHlc, acks };
    });
}

/** Horizon de purge courant (Y-09) : `unbounded` sans autre appareil actif, donc sans synchro configurée. */
export async function currentPurgeHorizon(repos: Repositories, self: DeviceId, nowMs: number): Promise<PurgeHorizon> {
  return purgeHorizon(knownDevices(await repos.sync.getStates()), self, nowMs);
}

/**
 * Purge des lignes supprimées de toutes les tables publiées (sauf `settings` et espaces fixes) : sous garde, avec inscription des
 * identifiants dans `sync_tombstone` dans la même transaction. Renvoie le nombre de lignes purgées et le plus grand hlc de suppression purgé.
 */
export async function purgeDeleted(deps: Pick<SyncDeps, 'data' | 'logger'>, horizon: PurgeHorizon, nowMs: number): Promise<{ readonly count: number; readonly maxPurged: Hlc | null }> {
  let maxPurged: Hlc | null = null;
  const before = purgeBefore(nowMs);
  const purgedAt = new Date(nowMs).toISOString() as IsoDateTime;
  let total = 0;
  for (const t of [...SYNC_TABLES].reverse()) {
    if (!t.purgeable) continue;
    for (;;) {
      const candidates = (await deps.data.repos.sync.deletedRows(t, before, PAGE_ROWS)).filter((row) => isPurgeable(t.name, row.id) && isStrictHlc(row.deletedHlc) && canPurgeDeletion(row, horizon, nowMs));
      if (candidates.length === 0) break;
      await guarded(deps.data, async (repos) => {
        if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf(candidates.map((c) => c.id));
        await repos.sync.insertTombstones(candidates.map((c) => ({ table: t.name, rowId: c.id, deletedHlc: c.deletedHlc })), purgedAt);
        await repos.sync.deleteRows(t, candidates.map((c) => c.id));
      });
      for (const c of candidates) if (maxPurged === null || c.deletedHlc > maxPurged) maxPurged = c.deletedHlc;
      total += candidates.length;
      if (candidates.length < PAGE_ROWS) break;
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
}

export async function maintain(deps: SyncDeps, input: MaintenanceInput): Promise<void> {
  const { data, platform, logger } = deps;
  const nowMs = deps.clock.nowMs();
  const devices = knownDevices(input.rows);
  const horizon = purgeHorizon(devices, deps.deviceId, nowMs);

  // Lignes supprimées : 30 jours ET lues par tous les appareils actifs.
  const { maxPurged: purged } = await purgeDeleted(deps, horizon, nowMs);
  if (purged !== null) {
    const previous = await readJson<Hlc>(data.repos, META.purgeHorizon);
    if (previous === null || purged > previous) await writeJson(data.repos, META.purgeHorizon, purged);
  }

  // Ses segments : couverts par un instantané, accusés par tous, dernier enregistrement de plus de 30 jours.
  const snapshot = await readJson<{ epoch: EpochId; seq: number; endHlc: Hlc; coveredSegment?: number }>(data.repos, META.snapshot);
  const covered = Math.max(
    0,
    ...[...input.accepted.values()].filter((s) => s.epoch === input.epoch).map((s) => s.acks.get(deps.deviceId)?.segment ?? 0),
    snapshot?.epoch === input.epoch ? (snapshot.coveredSegment ?? 0) : 0,
  );
  const times = (await readJson<Record<string, number>>(data.repos, META.segments)) ?? {};
  const listed = input.ownScan?.epochs.find((e) => e.epoch === input.epoch)?.segments ?? [];
  const readers = activeReaders(devices, deps.deviceId, nowMs);
  const removable = listed.filter((n) =>
    segmentPurgeable(n, { headSegment: input.head.segment, coveredSegment: covered, readers, self: deps.deviceId, lastWriteMs: times[`${input.epoch}/${String(n)}`] ?? null, nowMs }),
  );
  if (removable.length > 0) {
    await platform.deleteOwn(removable.map((n) => ({ epoch: input.epoch, kind: 'j' as const, n }))).catch((error: unknown) => logger.log('delete-own-failed', { code: String((error as { code?: string }).code ?? 'io') }));
    logger.log('segments-purged', { count: removable.length });
  }

  // Anciennes époques : supprimées quand tous les appareils actifs annoncent l'époque courante.
  const older = (input.ownScan?.epochs ?? []).filter((e) => compareEpochs(e.epoch, input.epoch) < 0);
  const allMoved = readers.every((r) => input.accepted.get(r.deviceId)?.epoch === input.epoch);
  if (older.length > 0 && allMoved) {
    await platform.deleteOwn(older.map((e) => ({ epoch: e.epoch, kind: 'epoch' as const }))).catch(() => 0);
    logger.log('old-epochs-deleted', { count: older.length });
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
