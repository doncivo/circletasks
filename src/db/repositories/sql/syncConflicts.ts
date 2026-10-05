import type { WriteStamper } from '../../../domain/hlc';
import type { SyncValue } from '../../../domain/sync/format';
import { syncColumn, syncTable, type SyncTable, type SyncTableName } from '../../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { ConflictFieldState, ConflictItemInfo, ConflictLogEntry, ConflictRowState, ConflictTarget, SyncConflictRepository } from '../syncConflictRepository';
import type { StoredConflict } from '../syncRepository';

/**
 * Implémentation SQL de `SyncConflictRepository` (ADR 0011, section 4.3 ; Y-04). Tables et colonnes : noms du catalogue
 * (`SyncTable.name`, `SyncColumn.name`) ou constantes de ce fichier vérifiées contre le catalogue ; jamais le texte d'une ligne de
 * `conflict_log`, qui n'est passé qu'en paramètre lié (audit H5).
 */

const CHUNK = 400;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** D'où vient le titre d'un élément : sa propre colonne, la ligne parente, la cible d'un rappel, ou rien (libellé du type d'élément). */
type TitleSource =
  | { readonly kind: 'own'; readonly column: string }
  | { readonly kind: 'parent'; readonly column: string; readonly table: SyncTableName }
  | { readonly kind: 'reminder' }
  | { readonly kind: 'none' };

/** Source du titre par table (colonnes contrôlées contre le catalogue par `syncConflicts.test.ts`). */
export const CONFLICT_TITLE_SOURCES: { readonly [K in SyncTableName]: TitleSource } = {
  space: { kind: 'own', column: 'name' },
  project: { kind: 'own', column: 'name' },
  recurrence: { kind: 'none' },
  goal: { kind: 'own', column: 'title' },
  task: { kind: 'own', column: 'title' },
  routine: { kind: 'own', column: 'title' },
  routine_log: { kind: 'parent', column: 'routine_id', table: 'routine' },
  routine_pause: { kind: 'parent', column: 'routine_id', table: 'routine' },
  reminder: { kind: 'reminder' },
  event: { kind: 'own', column: 'title' },
  checklist: { kind: 'own', column: 'title' },
  checklist_item: { kind: 'own', column: 'text' },
  focus_session: { kind: 'parent', column: 'task_id', table: 'task' },
  calendar_account: { kind: 'own', column: 'label' },
  holiday: { kind: 'own', column: 'name' },
  settings: { kind: 'none' },
};

/** Colonne publiée connue du catalogue, sinon erreur (programmation : la constante ci-dessus ne correspond plus au catalogue). */
function catalogueColumn(t: SyncTable, column: string): string {
  const col = syncColumn(t.name, column);
  if (!col) throw new Error(`colonne hors catalogue : ${t.name}.${column}`);
  return col.name;
}

const hasDeletedAt = (t: SyncTable): boolean => t.columns.some((c) => c.name === 'deleted_at');

function rowToConflict(r: SqlRow): StoredConflict {
  return {
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
  };
}

/** Conflit d'une ligne, ou null si son contenu est illisible (valeur JSON altérée). */
function readable(row: SqlRow): StoredConflict | null {
  try {
    return rowToConflict(row);
  } catch {
    return null;
  }
}

export function createSyncConflictRepository(db: SqlExecutor, stamper: WriteStamper): SyncConflictRepository {
  /** Identifiants purgés (traces) parmi ceux donnés. */
  const purged = async (t: SyncTable, ids: readonly string[]): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const part of chunks([...new Set(ids)])) {
      const rows = await db.select<{ row_id: string }>(`SELECT row_id FROM sync_tombstone WHERE table_name = ? AND row_id IN (${marks(part.length)})`, [t.name, ...part]);
      for (const row of rows) out.add(row.row_id);
    }
    return out;
  };

  /** Lignes existantes : état (vivante / supprimée) et valeurs des colonnes demandées (noms du catalogue). */
  const readLines = async (t: SyncTable, ids: readonly string[], columns: readonly string[]): Promise<Map<string, { deleted: boolean; values: SqlRow }>> => {
    const out = new Map<string, { deleted: boolean; values: SqlRow }>();
    const cols = [...new Set(columns.map((c) => catalogueColumn(t, c)))];
    const deleted = hasDeletedAt(t) ? 'deleted_at IS NOT NULL' : '0';
    for (const part of chunks([...new Set(ids)])) {
      const rows = await db.select(`SELECT ${t.key} AS row_key, ${deleted} AS is_deleted${cols.map((c) => `, ${c}`).join('')} FROM ${t.name} WHERE ${t.key} IN (${marks(part.length)})`, part);
      for (const row of rows) out.set(String(row['row_key']), { deleted: Number(row['is_deleted']) === 1, values: row });
    }
    return out;
  };

  const statesOf = async (t: SyncTable, ids: readonly string[], lines: ReadonlyMap<string, { deleted: boolean }>): Promise<Map<string, ConflictRowState>> => {
    const missing = ids.filter((id) => !lines.has(id));
    const gone = missing.length > 0 ? await purged(t, missing) : new Set<string>();
    return new Map(ids.map((id): [string, ConflictRowState] => {
      const line = lines.get(id);
      return [id, line ? (line.deleted ? 'deleted' : 'live') : gone.has(id) ? 'purged' : 'missing'];
    }));
  };

  /** Titres de lignes d'une table (colonne de titre propre), lignes supprimées comprises. */
  const ownTitles = async (t: SyncTable, ids: readonly string[]): Promise<Map<string, string>> => {
    const source = CONFLICT_TITLE_SOURCES[t.name];
    const out = new Map<string, string>();
    if (source.kind !== 'own' || ids.length === 0) return out;
    const lines = await readLines(t, ids, [source.column]);
    for (const [id, line] of lines) {
      const title = line.values[catalogueColumn(t, source.column)];
      if (typeof title === 'string' && title.length > 0) out.set(id, title);
    }
    return out;
  };

  return {
    async getConflict(id) {
      const rows = await db.select('SELECT * FROM conflict_log WHERE id = ?', [id]);
      if (!rows[0]) return null;
      return readable(rows[0]) ?? 'unreadable';
    },

    async listLog(since, limit) {
      const rows = await db.select('SELECT * FROM conflict_log WHERE detected_at >= ? ORDER BY id DESC LIMIT ?', [since, limit]);
      return rows.map((row): ConflictLogEntry => ({ id: Number(row['id']), conflict: readable(row) }));
    },

    async describe(targets: readonly ConflictTarget[]) {
      const out = new Map<string, ConflictItemInfo>();
      const byTable = new Map<SyncTable, string[]>();
      for (const target of targets) byTable.set(target.table, [...(byTable.get(target.table) ?? []), target.rowId]);
      for (const [t, ids] of byTable) {
        const source = CONFLICT_TITLE_SOURCES[t.name];
        const columns = source.kind === 'own' ? [source.column] : source.kind === 'parent' ? [source.column] : source.kind === 'reminder' ? ['target_type', 'target_id'] : [];
        const lines = await readLines(t, ids, columns);
        const states = await statesOf(t, ids, lines);
        const titles = new Map<string, string>();
        if (source.kind === 'own') {
          for (const [id, line] of lines) {
            const title = line.values[catalogueColumn(t, source.column)];
            if (typeof title === 'string' && title.length > 0) titles.set(id, title);
          }
        } else if (source.kind === 'parent') {
          const parentOf = new Map<string, string>();
          for (const [id, line] of lines) {
            const parent = line.values[catalogueColumn(t, source.column)];
            if (typeof parent === 'string') parentOf.set(id, parent);
          }
          const parentTable = syncTable(source.table);
          const parentTitles = parentTable ? await ownTitles(parentTable, [...new Set(parentOf.values())]) : new Map<string, string>();
          for (const [id, parent] of parentOf) {
            const title = parentTitles.get(parent);
            if (title !== undefined) titles.set(id, title);
          }
        } else if (source.kind === 'reminder') {
          // Cible d'un rappel : `target_type` est une valeur de la base, cherchée dans le catalogue (jamais composée telle quelle).
          const byTarget = new Map<SyncTable, Map<string, string>>();
          for (const [id, line] of lines) {
            const targetTable = syncTable(String(line.values['target_type']));
            const targetId = line.values['target_id'];
            if (!targetTable || typeof targetId !== 'string') continue;
            const map = byTarget.get(targetTable) ?? new Map<string, string>();
            map.set(id, targetId);
            byTarget.set(targetTable, map);
          }
          for (const [targetTable, map] of byTarget) {
            const targetTitles = await ownTitles(targetTable, [...new Set(map.values())]);
            for (const [id, targetId] of map) {
              const title = targetTitles.get(targetId);
              if (title !== undefined) titles.set(id, title);
            }
          }
        }
        for (const id of ids) out.set(`${t.name}|${id}`, { state: states.get(id) ?? 'missing', title: titles.get(id) ?? null });
      }
      return out;
    },

    async rowState(t, rowId) {
      const lines = await readLines(t, [rowId], []);
      return (await statesOf(t, [rowId], lines)).get(rowId) ?? 'missing';
    },

    async fieldState(t, column, rowId) {
      const col = catalogueColumn(t, column.name);
      const deleted = hasDeletedAt(t) ? 'p.deleted_at IS NOT NULL' : '0';
      const rows = await db.select(
        `SELECT p.${col} AS value, ${deleted} AS is_deleted,
                COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = ? AND row_id = p.${t.key} AND field = ?),
                         (SELECT hlc FROM sync_field_clock WHERE table_name = ? AND row_id = p.${t.key} AND field = '*'),
                         p.hlc) AS field_hlc
         FROM ${t.name} p WHERE p.${t.key} = ?`,
        [t.name, col, t.name, rowId],
      );
      const row = rows[0];
      if (!row) return { row: (await purged(t, [rowId])).has(rowId) ? 'purged' : 'missing', value: null, hlc: null } satisfies ConflictFieldState;
      return { row: Number(row['is_deleted']) === 1 ? 'deleted' : 'live', value: (row['value'] ?? null) as SyncValue, hlc: row['field_hlc'] as Hlc } satisfies ConflictFieldState;
    },

    async writeField(t, column, rowId, value) {
      const col = catalogueColumn(t, column.name);
      const stamp = stamper.next();
      await db.execute(`UPDATE ${t.name} SET ${col} = ?, updated_at = ?, device_id = ?, hlc = ? WHERE ${t.key} = ?`, [value, stamp.at, stamp.deviceId, stamp.hlc, rowId]);
      return stamp.hlc;
    },

    async markRestored(id, at) {
      await db.execute('UPDATE conflict_log SET restored = ?, resolved_at = ? WHERE id = ?', [at === null ? 0 : 1, at, id]);
    },
  };
}
