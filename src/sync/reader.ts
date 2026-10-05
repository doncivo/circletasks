import { APPLY_BATCH_OPS, type EpochId, type JournalRecord, type RecordCursor } from '../domain/sync/format';
import { recordIsAhead, recordMaxHlc } from '../domain/sync/drift';
import { parseJournalRecord } from '../domain/sync/parse';
import type { DeviceId, Hlc } from '../domain/types';
import { syncErrorCodeOf } from '../platform/sync/types';
import { applyOps, mergeTouched, type ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { runRepairs } from './repair';

/**
 * Lecture du journal d'un appareil (ADR 0011, sections 1.2, 3.3, 3.4, 4.4 et 10.2 étape 4 ; Y-02 critère 6, Y-05 critères 5 et 7,
 * Y-09 critère 10).
 *
 * Jamais au-delà de la tête authentifiée (c'est la plateforme qui borne) ; analyse stricte de chaque enregistrement ; contrôle de dérive
 * **avant** `HlcClock.receive()` ; application par lots de 500 opérations au plus, une transaction gardée par lot (lignes, horloges,
 * conflits et curseur ensemble) ; un fichier ou un enregistrement qui manque donne « En attente d'iCloud », jamais un saut.
 */

export type ReadStatus = 'complete' | 'cloud-pending' | 'truncated' | 'clock-ahead' | 'newer-major' | 'foreign' | 'error';

export interface ReadOutcome {
  readonly status: ReadStatus;
  readonly cursor: RecordCursor;
  readonly ackHlc: Hlc | null;
  readonly records: number;
  readonly touched: Map<string, Set<string>>;
  readonly conflicts: number;
  readonly errorCode: string | null;
}

export interface ReadRequest {
  readonly deviceId: DeviceId;
  readonly epoch: EpochId;
  readonly cursor: RecordCursor;
  readonly ackHlc: Hlc | null;
  readonly knows: ApplyContext['knows'];
  /** Appelé après chaque lot appliqué (`onRemoteChanges`). */
  readonly onBatch?: (touched: ReadonlyMap<string, ReadonlySet<string>>) => void;
}

/** Positions (après chaque enregistrement) d'une page lue depuis `from` ; null quand elle ne peut pas être connue. */
export function recordPositions(from: RecordCursor, count: number, next: RecordCursor): (RecordCursor | null)[] {
  const start = from.segment === 0 ? { segment: 1, record: 0 } : from;
  if (next.segment === start.segment) return Array.from({ length: count }, (_, i) => ({ segment: start.segment, record: start.record + i + 1 }));
  const inLast = Math.min(count, next.record);
  const firstOfLast = count - inLast;
  return Array.from({ length: count }, (_, i) => {
    if (i >= firstOfLast) return { segment: next.segment, record: i - firstOfLast + 1 };
    return next.segment === start.segment + 1 ? { segment: start.segment, record: start.record + i + 1 } : null;
  });
}

export async function readDevice(deps: SyncDeps, request: ReadRequest): Promise<ReadOutcome> {
  const touched = new Map<string, Set<string>>();
  let cursor = request.cursor;
  let ackHlc = request.ackHlc;
  let records = 0;
  let conflicts = 0;
  const finish = (status: ReadStatus, errorCode: string | null = null): ReadOutcome => ({ status, cursor, ackHlc, records, touched, conflicts, errorCode });

  for (;;) {
    let page;
    try {
      page = await deps.platform.readJournal({ deviceId: request.deviceId, epoch: request.epoch, from: cursor });
    } catch (error) {
      const code = syncErrorCodeOf(error);
      deps.logger.log('read-failed', { device: request.deviceId, code });
      if (code === 'newer-format') return finish('newer-major', code);
      if (code === 'key-mismatch') return finish('foreign', code);
      if (code === 'cloud-pending') return finish('cloud-pending', code);
      return finish('error', code);
    }
    const positions = recordPositions(cursor, page.records.length, page.next);
    // Lots : enregistrements entiers, 500 opérations au plus (un enregistrement plus gros forme son lot).
    let batch: { record: JournalRecord; position: RecordCursor | null }[] = [];
    let batchOps = 0;
    let stop: ReadStatus | null = null;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const items = batch;
      batch = [];
      batchOps = 0;
      let maxHlc: Hlc | null = null;
      for (const item of items) {
        const h = recordMaxHlc(item.record);
        if (h !== null && (maxHlc === null || h > maxHlc)) maxHlc = h;
      }
      // Contrôle de dérive déjà fait : l'horloge locale peut intégrer ces hlc.
      if (maxHlc !== null) deps.hlc.receive(maxHlc);
      const position = [...items].reverse().find((item) => item.position !== null)?.position ?? null;
      const nextAck = maxHlc !== null && (ackHlc === null || maxHlc > ackHlc) ? maxHlc : ackHlc;
      const now = new Date(deps.clock.nowMs()).toISOString() as ApplyContext['now'];
      const result = await guarded(deps.data, async (repos) => {
        let applied = { touched: new Map<string, Set<string>>(), conflicts: 0 };
        for (const item of items) {
          const r = await applyOps(repos, item.record.ops, { localSv: deps.sv, remoteSv: item.record.sv, now, knows: request.knows, logger: deps.logger });
          mergeTouched(applied.touched, r.touched);
          applied = { touched: applied.touched, conflicts: applied.conflicts + r.conflicts };
        }
        if (position) await repos.sync.saveState(request.deviceId, { cursorSegment: position.segment, cursorRecord: position.record, ackHlc: nextAck });
        else if (nextAck !== ackHlc) await repos.sync.saveState(request.deviceId, { ackHlc: nextAck });
        return applied;
      });
      if (position) cursor = position;
      ackHlc = nextAck;
      records += items.length;
      conflicts += result.conflicts;
      mergeTouched(touched, result.touched);
      await runRepairs(deps, result.touched);
      request.onBatch?.(result.touched);
    };

    for (let i = 0; i < page.records.length; i += 1) {
      const record = parseJournalRecord(page.records[i] as string);
      if (!record) {
        // Enregistrement annoncé illisible : corruption, rien au-delà (reprise depuis l'instantané, section 5.5).
        stop = 'truncated';
        break;
      }
      if (recordIsAhead(record, deps.clock.nowMs())) {
        stop = 'clock-ahead';
        break;
      }
      if (batch.length > 0 && batchOps + record.ops.length > APPLY_BATCH_OPS) await flush();
      batch.push({ record, position: positions[i] ?? null });
      batchOps += record.ops.length;
    }
    await flush();
    if (stop) return finish(stop);
    if (page.status === 'complete') return finish('complete');
    if (page.status === 'cloud-pending') return finish('cloud-pending');
    if (page.status === 'truncated') return finish('truncated');
    if (page.records.length === 0) return finish('complete');
    cursor = page.next;
  }
}
