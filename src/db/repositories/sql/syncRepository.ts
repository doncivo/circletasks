import type { WriteStamper } from '../../../domain/hlc';
import type { SyncValue } from '../../../domain/sync/format';
import { childRelations, type SyncTable } from '../../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type {
  ConflictEntry,
  DeletedRow,
  DroppedItem,
  ExportedRow,
  FieldClock,
  OutboxEntry,
  ParkReason,
  ParkedOp,
  StoredConflict,
  StoredRow,
  SyncRepository,
  SyncStatePatch,
  SyncStateRow,
  Tombstone,
  UnknownField,
} from '../syncRepository';

/**
 * Implémentation SQL de `SyncRepository` (ADR 0011 ; Y-02, Y-05, Y-09). Les noms de tables et de colonnes sont ceux du catalogue
 * (`SyncTable.name`, `SyncTable.columns[].name`) : jamais une chaîne reçue d'un autre appareil (audit H5). Listes `IN` découpées par
 * paquets de 400 paramètres.
 */

const CHUNK = 400;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Colonne de clé et liste SQL des colonnes publiées, tirées du catalogue. */
const keyOf = (t: SyncTable): string => t.key;
const columnsOf = (t: SyncTable): string[] => t.columns.map((c) => c.name);

const STATE_COLUMNS: readonly (readonly [keyof SyncStatePatch, string])[] = [
  ['isSelf', 'is_self'],
  ['platform', 'platform'],
  ['appVersion', 'app_version'],
  ['epoch', 'epoch'],
  ['cursorSegment', 'cursor_segment'],
  ['cursorRecord', 'cursor_record'],
  ['ackHlc', 'ack_hlc'],
  ['headSegment', 'head_segment'],
  ['headRecord', 'head_record'],
  ['headHlc', 'head_hlc'],
  ['stateEpoch', 'state_epoch'],
  ['stateSeq', 'state_seq'],
  ['stateDigest', 'state_digest'],
  ['lastAcks', 'last_acks'],
  ['lastSeenHlc', 'last_seen_hlc'],
  ['lastSyncAt', 'last_sync_at'],
  ['schemaVersion', 'schema_version'],
  ['formatMajor', 'format_major'],
  ['kid', 'kid'],
  ['purgeHorizon', 'purge_horizon'],
  ['snapshotSeq', 'snapshot_seq'],
  ['snapshotHlc', 'snapshot_hlc'],
  ['status', 'status'],
];

function rowToState(row: SqlRow): SyncStateRow {
  return {
    deviceId: String(row['device_id']),
    isSelf: row['is_self'] === 1,
    platform: row['platform'] as string | null,
    appVersion: row['app_version'] as string | null,
    epoch: row['epoch'] as string | null,
    cursorSegment: Number(row['cursor_segment']),
    cursorRecord: Number(row['cursor_record']),
    ackHlc: row['ack_hlc'] as Hlc | null,
    headSegment: Number(row['head_segment']),
    headRecord: Number(row['head_record']),
    headHlc: row['head_hlc'] as Hlc | null,
    stateEpoch: row['state_epoch'] as string | null,
    stateSeq: Number(row['state_seq']),
    stateDigest: row['state_digest'] as string | null,
    lastAcks: String(row['last_acks']),
    lastSeenHlc: row['last_seen_hlc'] as Hlc | null,
    lastSyncAt: row['last_sync_at'] as IsoDateTime | null,
    schemaVersion: row['schema_version'] as number | null,
    formatMajor: row['format_major'] as number | null,
    kid: row['kid'] as string | null,
    purgeHorizon: row['purge_horizon'] as Hlc | null,
    snapshotSeq: row['snapshot_seq'] as number | null,
    snapshotHlc: row['snapshot_hlc'] as Hlc | null,
    status: String(row['status']),
  };
}

export function createSyncRepository(db: SqlExecutor, stamper: WriteStamper): SyncRepository {
  const readRows = async (t: SyncTable, ids: readonly string[]): Promise<Map<string, StoredRow>> => {
    const out = new Map<string, StoredRow>();
    const cols = columnsOf(t);
    for (const part of chunks([...new Set(ids)])) {
      const rows = await db.select(`SELECT ${keyOf(t)} AS row_key, hlc, updated_at, ${cols.join(', ')} FROM ${t.name} WHERE ${keyOf(t)} IN (${marks(part.length)})`, part);
      for (const row of rows) {
        const values = new Map<string, SyncValue>(cols.map((col) => [col, row[col] ?? null]));
        out.set(String(row['row_key']), { id: String(row['row_key']), values, hlc: row['hlc'] as Hlc, updatedAt: row['updated_at'] as IsoDateTime });
      }
    }
    return out;
  };

  const readClocks = async (t: SyncTable, ids: readonly string[]): Promise<Map<string, Map<string, FieldClock>>> => {
    const out = new Map<string, Map<string, FieldClock>>();
    for (const part of chunks([...new Set(ids)])) {
      const rows = await db.select<{ row_id: string; field: string; hlc: string; base_hlc: string | null }>(
        `SELECT row_id, field, hlc, base_hlc FROM sync_field_clock WHERE table_name = ? AND row_id IN (${marks(part.length)})`,
        [t.name, ...part],
      );
      for (const row of rows) {
        let map = out.get(row.row_id);
        if (!map) {
          map = new Map();
          out.set(row.row_id, map);
        }
        map.set(row.field, { hlc: row.hlc as Hlc, base: row.base_hlc as Hlc | null });
      }
    }
    return out;
  };

  const upsertClocks = async (t: SyncTable, id: string, clocks: readonly { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }[]): Promise<void> => {
    for (const clock of clocks) {
      await db.execute(
        `INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc`,
        [t.name, id, clock.field, clock.hlc, clock.base],
      );
    }
  };

  return {
    // --- garde ----------------------------------------------------------------------------------------------------------------------
    async setGuard() {
      await db.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
    },
    async clearGuard() {
      await db.execute('DELETE FROM sync_guard');
    },
    async assertGuardEmpty() {
      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_guard');
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) await db.execute('DELETE FROM sync_guard');
      return n;
    },

    // --- file d'envoi ---------------------------------------------------------------------------------------------------------------
    async readOutbox(limit = 1_000_000) {
      const rows = await db.select<{ seq: number; table_name: string; row_id: string; field: string }>(
        'SELECT seq, table_name, row_id, field FROM sync_outbox ORDER BY seq LIMIT ?',
        [limit],
      );
      return rows.map((r): OutboxEntry => ({ seq: Number(r.seq), table: r.table_name, rowId: r.row_id, field: r.field }));
    },
    async outboxCount() {
      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox');
      return Number(rows[0]?.n ?? 0);
    },
    async clearPublished(entries) {
      for (const entry of entries) {
        await db.execute('DELETE FROM sync_outbox WHERE seq = ?', [entry.seq]);
        if (entry.field === '*') continue;
        // Champ réécrit depuis la lecture : sa prochaine publication remplace la valeur publiée, qui devient sa base.
        await db.execute(
          `UPDATE sync_field_clock SET base_hlc = ?
           WHERE table_name = ? AND row_id = ? AND field = ? AND hlc <> ?
             AND EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = ? AND row_id = ? AND field = ?)`,
          [entry.hlc, entry.table, entry.rowId, entry.field, entry.hlc, entry.table, entry.rowId, entry.field],
        );
      }
    },
    async dropOutbox(entries) {
      for (const e of entries) await db.execute('DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND field = ?', [e.table, e.rowId, e.field]);
    },
    async clearOutbox(uptoSeq) {
      if (uptoSeq === undefined) await db.execute('DELETE FROM sync_outbox');
      else await db.execute('DELETE FROM sync_outbox WHERE seq <= ?', [uptoSeq]);
    },
    async addOutbox(entries) {
      for (const e of entries) await db.execute('INSERT OR REPLACE INTO sync_outbox (table_name, row_id, field) VALUES (?, ?, ?)', [e.table, e.rowId, e.field]);
    },
    async maxOutboxSeq() {
      const rows = await db.select<{ n: number | null }>('SELECT MAX(seq) AS n FROM sync_outbox');
      return Number(rows[0]?.n ?? 0);
    },

    // --- lignes ---------------------------------------------------------------------------------------------------------------------
    readRows,
    readClocks,
    async pendingFields(t, ids) {
      const out = new Map<string, Set<string>>();
      for (const part of chunks([...new Set(ids)])) {
        const rows = await db.select<{ row_id: string; field: string }>(`SELECT row_id, field FROM sync_outbox WHERE table_name = ? AND row_id IN (${marks(part.length)})`, [t.name, ...part]);
        for (const row of rows) {
          const set = out.get(row.row_id) ?? new Set<string>();
          set.add(row.field);
          out.set(row.row_id, set);
        }
      }
      return out;
    },
    async existingIds(t, ids) {
      const out = new Set<string>();
      for (const part of chunks([...new Set(ids)])) {
        const rows = await db.select<{ k: string }>(`SELECT ${keyOf(t)} AS k FROM ${t.name} WHERE ${keyOf(t)} IN (${marks(part.length)})`, part);
        for (const row of rows) out.add(row.k);
      }
      return out;
    },
    async insertRow(t, id, values, meta) {
      const cols = columnsOf(t).filter((col) => values.has(col));
      const params: SqlValue[] = [id, ...cols.map((col) => values.get(col) ?? null), meta.updatedAt, meta.deviceId, meta.hlc];
      await db.execute(`INSERT INTO ${t.name} (${[keyOf(t), ...cols, 'updated_at', 'device_id', 'hlc'].join(', ')}) VALUES (${marks(params.length)})`, params);
    },
    async updateRow(t, id, values, meta) {
      const cols = columnsOf(t).filter((col) => values.has(col));
      const sets = [...cols.map((col) => `${col} = ?`), ...(meta ? ['updated_at = ?', 'device_id = ?', 'hlc = ?'] : [])];
      if (sets.length === 0) return;
      const params: SqlValue[] = [...cols.map((col) => values.get(col) ?? null), ...(meta ? [meta.updatedAt, meta.deviceId, meta.hlc] : []), id];
      await db.execute(`UPDATE ${t.name} SET ${sets.join(', ')} WHERE ${keyOf(t)} = ?`, params);
    },
    writeClocks: upsertClocks,
    async replaceClocks(t, id, clocks) {
      await db.execute('DELETE FROM sync_field_clock WHERE table_name = ? AND row_id = ?', [t.name, id]);
      await upsertClocks(t, id, clocks);
    },
    async exportRows(t, afterId, limit) {
      const cols = columnsOf(t);
      const rows = await db.select(
        `SELECT ${keyOf(t)} AS row_key, hlc, updated_at, ${cols.join(', ')} FROM ${t.name} ${afterId === null ? '' : `WHERE ${keyOf(t)} > ?`} ORDER BY ${keyOf(t)} LIMIT ?`,
        afterId === null ? [limit] : [afterId, limit],
      );
      const ids = rows.map((row) => String(row['row_key']));
      const clocks = await readClocks(t, ids);
      return rows.map((row): ExportedRow => {
        const id = String(row['row_key']);
        return {
          id,
          values: new Map<string, SyncValue>(cols.map((col) => [col, row[col] ?? null])),
          hlc: row['hlc'] as Hlc,
          updatedAt: row['updated_at'] as IsoDateTime,
          clocks: clocks.get(id) ?? new Map(),
        };
      });
    },
    async deleteRows(t, ids) {
      for (const part of chunks([...new Set(ids)])) {
        await db.execute(`DELETE FROM sync_field_clock WHERE table_name = ? AND row_id IN (${marks(part.length)})`, [t.name, ...part]);
        await db.execute(`DELETE FROM sync_outbox WHERE table_name = ? AND row_id IN (${marks(part.length)})`, [t.name, ...part]);
        await db.execute(`DELETE FROM ${t.name} WHERE ${keyOf(t)} IN (${marks(part.length)})`, part);
      }
    },
    async deletedRows(t, before, limit) {
      if (!t.columns.some((col) => col.name === 'deleted_at')) return [];
      const children = childRelations(t.name).map((rel) => `NOT EXISTS (SELECT 1 FROM ${rel.table.name} c WHERE c.${rel.column} = p.${keyOf(t)})`);
      const rows = await db.select<{ row_key: string; deleted_at: string; deleted_hlc: string }>(
        `SELECT p.${keyOf(t)} AS row_key, p.deleted_at,
                COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = ? AND row_id = p.${keyOf(t)} AND field = 'deleted_at'),
                         (SELECT hlc FROM sync_field_clock WHERE table_name = ? AND row_id = p.${keyOf(t)} AND field = '*'),
                         p.hlc) AS deleted_hlc
         FROM ${t.name} p
         WHERE p.deleted_at IS NOT NULL AND p.deleted_at < ? ${children.map((c) => `AND ${c}`).join(' ')}
         ORDER BY p.${keyOf(t)} LIMIT ?`,
        [t.name, t.name, before, limit],
      );
      return rows.map((r): DeletedRow => ({ id: r.row_key, deletedAt: r.deleted_at as IsoDateTime, deletedHlc: r.deleted_hlc as Hlc }));
    },
    async maxRowHlc() {
      const rows = await db.select<{ hlc: string | null }>('SELECT MAX(hlc) AS hlc FROM sync_field_clock');
      return (rows[0]?.hlc ?? null) as Hlc | null;
    },

    // --- état -----------------------------------------------------------------------------------------------------------------------
    async getStates() {
      return (await db.select('SELECT * FROM sync_state ORDER BY device_id')).map(rowToState);
    },
    async saveState(deviceId, patch) {
      await db.execute('INSERT OR IGNORE INTO sync_state (device_id) VALUES (?)', [deviceId]);
      const entries = STATE_COLUMNS.filter(([key]) => patch[key] !== undefined);
      if (entries.length === 0) return;
      const params = entries.map(([key]) => {
        const value = patch[key];
        return typeof value === 'boolean' ? (value ? 1 : 0) : (value as SqlValue);
      });
      await db.execute(`UPDATE sync_state SET ${entries.map(([, col]) => `${col} = ?`).join(', ')} WHERE device_id = ?`, [...params, deviceId]);
    },
    async getMeta(key) {
      const rows = await db.select<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
      return rows[0]?.value ?? null;
    },
    async setMeta(key, value) {
      if (value === null) await db.execute('DELETE FROM sync_meta WHERE key = ?', [key]);
      else await db.execute('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    },

    // --- conflits -------------------------------------------------------------------------------------------------------------------
    async insertConflicts(conflicts: readonly ConflictEntry[], detectedAt) {
      for (const c of conflicts) {
        await db.execute(
          `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.table, c.rowId, c.field, JSON.stringify(c.keptValue), JSON.stringify(c.discardedValue), c.keptDevice, c.discardedDevice, c.keptHlc, c.discardedHlc, detectedAt],
        );
      }
    },
    async countConflictsSince(since) {
      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM conflict_log WHERE detected_at >= ?', [since]);
      return Number(rows[0]?.n ?? 0);
    },
    async listConflicts(since, limit) {
      const rows = await db.select('SELECT * FROM conflict_log WHERE detected_at >= ? ORDER BY id DESC LIMIT ?', [since, limit]);
      return rows.map(
        (r): StoredConflict => ({
          id: Number(r['id']),
          table: String(r['table_name']),
          rowId: String(r['row_id']),
          field: String(r['field']),
          keptValue: JSON.parse(String(r['kept_value'])) as SyncValue,
          discardedValue: JSON.parse(String(r['discarded_value'])) as SyncValue,
          keptDevice: String(r['kept_device']),
          discardedDevice: String(r['discarded_device']),
          keptHlc: r['kept_hlc'] as Hlc,
          discardedHlc: r['discarded_hlc'] as Hlc,
          detectedAt: r['detected_at'] as IsoDateTime,
          resolvedAt: r['resolved_at'] as IsoDateTime | null,
          restored: r['restored'] === 1,
        }),
      );
    },

    // --- traces ---------------------------------------------------------------------------------------------------------------------
    async tombstones(table, ids) {
      const out = new Map<string, Hlc>();
      for (const part of chunks([...new Set(ids)])) {
        const rows = await db.select<{ row_id: string; deleted_hlc: string }>(`SELECT row_id, deleted_hlc FROM sync_tombstone WHERE table_name = ? AND row_id IN (${marks(part.length)})`, [table, ...part]);
        for (const row of rows) out.set(row.row_id, row.deleted_hlc as Hlc);
      }
      return out;
    },
    async insertTombstones(items: readonly Tombstone[], purgedAt) {
      for (const item of items) {
        await db.execute(
          `INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (table_name, row_id) DO UPDATE SET deleted_hlc = MAX(deleted_hlc, excluded.deleted_hlc)`,
          [item.table, item.rowId, item.deletedHlc, purgedAt],
        );
      }
    },
    async removeTombstone(table, rowId) {
      await db.execute('DELETE FROM sync_tombstone WHERE table_name = ? AND row_id = ?', [table, rowId]);
    },
    async exportTombstones(after, limit) {
      const rows = await db.select<{ table_name: string; row_id: string; deleted_hlc: string }>(
        after === null
          ? 'SELECT table_name, row_id, deleted_hlc FROM sync_tombstone ORDER BY table_name, row_id LIMIT ?'
          : 'SELECT table_name, row_id, deleted_hlc FROM sync_tombstone WHERE (table_name, row_id) > (?, ?) ORDER BY table_name, row_id LIMIT ?',
        after === null ? [limit] : [after.table, after.rowId, limit],
      );
      return rows.map((r): Tombstone => ({ table: r.table_name, rowId: r.row_id, deletedHlc: r.deleted_hlc as Hlc }));
    },
    async tombstoneCount() {
      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_tombstone');
      return Number(rows[0]?.n ?? 0);
    },
    async clearTombstones() {
      await db.execute('DELETE FROM sync_tombstone');
    },

    // --- champs inconnus ------------------------------------------------------------------------------------------------------------
    async putUnknown(f: UnknownField) {
      const existing = await db.select<{ hlc: string }>('SELECT hlc FROM sync_unknown WHERE table_name = ? AND row_id = ? AND field = ?', [f.table, f.rowId, f.field]);
      const current = existing[0]?.hlc;
      if (current !== undefined && current >= f.hlc) return false;
      await db.execute(
        `INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (table_name, row_id, field) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, base_hlc = excluded.base_hlc, sv = excluded.sv`,
        [f.table, f.rowId, f.field, JSON.stringify(f.value), f.hlc, f.base, f.sv],
      );
      return true;
    },
    async exportUnknown(afterRowid, limit) {
      const rows = await db.select('SELECT * FROM sync_unknown ORDER BY table_name, row_id, field LIMIT ? OFFSET ?', [limit, afterRowid]);
      return rows.map((r, i) => ({
        rowid: afterRowid + i + 1,
        table: String(r['table_name']),
        rowId: String(r['row_id']),
        field: String(r['field']),
        value: JSON.parse(String(r['value'])) as SyncValue,
        hlc: r['hlc'] as Hlc,
        base: r['base_hlc'] as Hlc | null,
        sv: Number(r['sv']),
      }));
    },
    async clearUnknown() {
      await db.execute('DELETE FROM sync_unknown');
    },

    // --- opérations mises de côté ---------------------------------------------------------------------------------------------------
    async park(reason, table, rowId, hlc, op, at) {
      await db.execute('INSERT INTO sync_parked (reason, table_name, row_id, hlc, op, parked_at) VALUES (?, ?, ?, ?, ?, ?)', [reason, table, rowId, hlc, op, at]);
    },
    async parked(reasons, afterId, limit) {
      if (reasons.length === 0) return [];
      const rows = await db.select(`SELECT id, reason, table_name, row_id, hlc, op FROM sync_parked WHERE reason IN (${marks(reasons.length)}) AND id > ? ORDER BY id LIMIT ?`, [...reasons, afterId, limit]);
      return rows.map((r): ParkedOp => ({ id: Number(r['id']), reason: r['reason'] as ParkReason, table: String(r['table_name']), rowId: String(r['row_id']), hlc: r['hlc'] as Hlc, op: String(r['op']) }));
    },
    async removeParked(ids) {
      for (const part of chunks(ids)) await db.execute(`DELETE FROM sync_parked WHERE id IN (${marks(part.length)})`, part);
    },
    async parkedCount(reasons) {
      if (reasons.length === 0) return 0;
      const rows = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_parked WHERE reason IN (${marks(reasons.length)})`, [...reasons]);
      return Number(rows[0]?.n ?? 0);
    },

    // --- plafonds -------------------------------------------------------------------------------------------------------------------
    async enforceCaps(caps) {
      const dropped: DroppedItem[] = [];
      // sync_parked : hors `epoch-carry` (jamais abandonné), les plus anciennes au-delà du plafond.
      const parkedOver = await db.select<{ id: number; table_name: string; row_id: string; reason: string }>(
        `SELECT id, table_name, row_id, reason FROM sync_parked WHERE reason <> 'epoch-carry' ORDER BY id DESC LIMIT -1 OFFSET ?`,
        [caps.parked],
      );
      for (const row of parkedOver) dropped.push({ kind: 'parked', table: row.table_name, rowId: row.row_id, reason: row.reason });
      for (const part of chunks(parkedOver.map((row) => Number(row.id)))) await db.execute(`DELETE FROM sync_parked WHERE id IN (${marks(part.length)})`, part);
      // sync_unknown : 50 000 champs ou 16 Mio, le plus ancien (hlc) d'abord.
      for (;;) {
        const stats = await db.select<{ n: number; bytes: number | null }>('SELECT COUNT(*) AS n, SUM(LENGTH(value)) AS bytes FROM sync_unknown');
        const n = Number(stats[0]?.n ?? 0);
        const bytes = Number(stats[0]?.bytes ?? 0);
        if (n <= caps.unknownFields && bytes <= caps.unknownBytes) break;
        const oldest = await db.select<{ table_name: string; row_id: string; field: string }>('SELECT table_name, row_id, field FROM sync_unknown ORDER BY hlc LIMIT ?', [Math.max(1, n - caps.unknownFields)]);
        if (oldest.length === 0) break;
        for (const row of oldest) {
          await db.execute('DELETE FROM sync_unknown WHERE table_name = ? AND row_id = ? AND field = ?', [row.table_name, row.row_id, row.field]);
          dropped.push({ kind: 'unknown', table: row.table_name, rowId: row.row_id, reason: 'cap' });
        }
      }
      // conflict_log : 12 mois, puis 10 000 lignes (résolues d'abord, puis les plus anciennes).
      const expired = await db.select<{ table_name: string; row_id: string }>('SELECT table_name, row_id FROM conflict_log WHERE detected_at < ?', [caps.conflictsBefore]);
      for (const row of expired) dropped.push({ kind: 'conflict', table: row.table_name, rowId: row.row_id, reason: 'age' });
      await db.execute('DELETE FROM conflict_log WHERE detected_at < ?', [caps.conflictsBefore]);
      const over = await db.select<{ id: number; table_name: string; row_id: string }>(
        'SELECT id, table_name, row_id FROM conflict_log ORDER BY (resolved_at IS NULL) DESC, id DESC LIMIT -1 OFFSET ?',
        [caps.conflicts],
      );
      for (const part of chunks(over.map((row) => Number(row.id)))) await db.execute(`DELETE FROM conflict_log WHERE id IN (${marks(part.length)})`, part);
      for (const row of over) dropped.push({ kind: 'conflict', table: row.table_name, rowId: row.row_id, reason: 'cap' });
      return dropped;
    },

    // --- réparations ----------------------------------------------------------------------------------------------------------------
    async routinePauses(routineIds) {
      const out = new Map<string, { toDate: string | null; deletedAt: string | null }[]>();
      for (const id of routineIds) out.set(id, []);
      for (const part of chunks([...new Set(routineIds)])) {
        const rows = await db.select<{ routine_id: string; to_date: string | null; deleted_at: string | null }>(
          `SELECT routine_id, to_date, deleted_at FROM routine_pause WHERE routine_id IN (${marks(part.length)})`,
          part,
        );
        for (const row of rows) out.get(row.routine_id)?.push({ toDate: row.to_date, deletedAt: row.deleted_at });
      }
      return out;
    },
    async setRoutinePaused(routineId, paused) {
      await db.execute('UPDATE routine SET paused = ? WHERE id = ? AND paused <> ?', [paused ? 1 : 0, routineId, paused ? 1 : 0]);
    },
    async openFocusSessions() {
      const rows = await db.select<{ id: string; started_at: string; hlc: string }>('SELECT id, started_at, hlc FROM focus_session WHERE ended_at IS NULL AND deleted_at IS NULL');
      return rows.map((r) => ({ id: r.id, startedAt: r.started_at as IsoDateTime, hlc: r.hlc as Hlc }));
    },
    async closeFocusSession(id, endedAt) {
      const stamp = stamper.next();
      await db.execute('UPDATE focus_session SET ended_at = ?, paused_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND ended_at IS NULL', [endedAt, stamp.at, stamp.deviceId, stamp.hlc, id]);
    },
    async deleteExternalEventsOf(accountIds) {
      for (const part of chunks([...new Set(accountIds)])) await db.execute(`DELETE FROM external_event WHERE account_id IN (${marks(part.length)})`, part);
    },
  };
}
