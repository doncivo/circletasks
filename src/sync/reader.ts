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

interface ReadItem {
  readonly record: JournalRecord;
  readonly position: RecordCursor | null;
  readonly hlc: Hlc | null;
}

/**
 * Lecture par pages. **Un groupe de même hlc n'est jamais coupé** (ADR 0011 §3.3 : une opération de plus de 256 Kio part en plusieurs
 * enregistrements au même hlc, tous dans le même appel d'ajout) : aucun lot n'est appliqué entre deux enregistrements de même hlc ; le
 * dernier groupe d'une page n'est appliqué (curseur et accusé avancés) que si la tête est atteinte ; sinon il passe à la page suivante,
 * ou, si la lecture s’arrête (fichier dans le nuage, enregistrement illisible, horloge en avance), il est appliqué sans avancer le curseur
 * ni l’accusé (il reste avant lui). Un accusé n'annonce donc jamais lu un hlc dont une partie manque (sinon le report d'époque, qui ne reprend que les
 * écritures au-delà de l'accusé, perdrait la partie manquante).
 */
export async function readDevice(deps: SyncDeps, request: ReadRequest): Promise<ReadOutcome> {
  const touched = new Map<string, Set<string>>();
  let cursor = request.cursor;
  let ackHlc = request.ackHlc;
  let records = 0;
  let conflicts = 0;
  const finish = (status: ReadStatus, errorCode: string | null = null): ReadOutcome => ({ status, cursor, ackHlc, records, touched, conflicts, errorCode });

  /**
   * Applique des enregistrements entiers dans une transaction gardée, avec le curseur et l'accusé du dernier ; `commit` faux : valeurs
   * appliquées (fusion idempotente, relues plus tard) mais curseur et accusé inchangés.
   */
  const flush = async (items: readonly ReadItem[], commit = true): Promise<void> => {
    if (items.length === 0) return;
    let maxHlc: Hlc | null = null;
    for (const item of items) if (item.hlc !== null && (maxHlc === null || item.hlc > maxHlc)) maxHlc = item.hlc;
    // Contrôle de dérive déjà fait : l'horloge locale peut intégrer ces hlc.
    if (maxHlc !== null) deps.hlc.receive(maxHlc);
    const position = commit ? ([...items].reverse().find((item) => item.position !== null)?.position ?? null) : null;
    const nextAck = commit && maxHlc !== null && (ackHlc === null || maxHlc > ackHlc) ? maxHlc : ackHlc;
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

  /** Enregistrements du dernier groupe (même hlc), reportés à la page suivante. */
  let carry: ReadItem[] = [];
  let from = cursor;
  for (;;) {
    let page;
    try {
      page = await deps.platform.readJournal({ deviceId: request.deviceId, epoch: request.epoch, from });
    } catch (error) {
      const code = syncErrorCodeOf(error);
      deps.logger.log('read-failed', { device: request.deviceId, code });
      if (code === 'newer-format') return finish('newer-major', code);
      if (code === 'key-mismatch') return finish('foreign', code);
      if (code === 'cloud-pending') return finish('cloud-pending', code);
      return finish('error', code);
    }
    const positions = recordPositions(from, page.records.length, page.next);
    // Lots : enregistrements entiers, 500 opérations au plus, jamais coupés au milieu d'un groupe de même hlc.
    let batch: ReadItem[] = carry;
    carry = [];
    let batchOps = batch.reduce((n, item) => n + item.record.ops.length, 0);
    let stop: ReadStatus | null = null;

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
      const hlc = recordMaxHlc(record);
      const last = batch.at(-1);
      if (last && batchOps + record.ops.length > APPLY_BATCH_OPS && last.hlc !== hlc) {
        await flush(batch);
        batch = [];
        batchOps = 0;
      }
      batch.push({ record, position: positions[i] ?? null, hlc });
      batchOps += record.ops.length;
    }
    // Fin de page : le dernier groupe n'est complet que si la tête est atteinte (un appel d'ajout se termine à la tête).
    const headReached = stop === null && (page.status === 'complete' || (page.status === 'more' && page.records.length === 0));
    if (headReached) {
      await flush(batch);
    } else {
      const lastHlc = batch.at(-1)?.hlc;
      let cut = batch.length;
      while (cut > 0 && (batch[cut - 1] as ReadItem).hlc === lastHlc) cut -= 1;
      await flush(batch.slice(0, cut));
      // Page suivante : le groupe y continue peut-être ; arrêt : ses enregistrements entiers sont appliqués, mais le curseur reste avant
      // le groupe et l'accusé n'avance pas (relu, sans effet, au cycle suivant).
      if (stop === null && page.status === 'more') carry = batch.slice(cut);
      else await flush(batch.slice(cut), false);
    }
    if (stop) return finish(stop);
    if (page.status === 'complete') return finish('complete');
    if (page.status === 'cloud-pending') return finish('cloud-pending');
    if (page.status === 'truncated') return finish('truncated');
    if (page.records.length === 0) return finish('complete');
    from = page.next;
  }
}
