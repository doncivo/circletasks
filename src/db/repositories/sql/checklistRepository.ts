import type { WriteStamper } from '../../../domain/hlc';
import { encodeIcon, parseIcon, type Checklist, type ChecklistItem, type ChecklistPatch, type ChecklistSummary, type NewChecklist, type NewChecklistItem } from '../../../domain/model';
import type { ChecklistId, ChecklistItemId, LocalDate, SpaceFilter, SpaceId } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { ChecklistItemRepository, ChecklistRepository } from '../checklistRepository';
import type { DateRange, ReadOptions, SortOrderEntry } from '../common';
import { deletedClause, inClause, readSyncMeta, requireMapped, requireRow, spaceFilterClause, type SyncRow } from './sqlHelpers';

interface ChecklistRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly date: string | null;
  readonly is_template: number;
}

interface SummaryRow extends ChecklistRow {
  readonly total: number;
  readonly checked: number;
}

interface ItemRow extends SqlRow, SyncRow {
  readonly checklist_id: string;
  readonly text: string;
  readonly checked: number;
  readonly sort_order: number;
}

function rowToChecklist(row: ChecklistRow): Checklist {
  return {
    id: row.id as ChecklistId,
    spaceId: row.space_id as SpaceId,
    title: row.title,
    icon: parseIcon(row.icon),
    date: row.date as LocalDate | null,
    isTemplate: row.is_template === 1,
    ...readSyncMeta(row),
  };
}

function rowToSummary(row: SummaryRow): ChecklistSummary {
  return { checklist: rowToChecklist(row), checked: row.checked, total: row.total };
}

function rowToItem(row: ItemRow): ChecklistItem {
  return {
    id: row.id as ChecklistItemId,
    checklistId: row.checklist_id as ChecklistId,
    text: row.text,
    checked: row.checked === 1,
    sortOrder: row.sort_order,
    ...readSyncMeta(row),
  };
}

const SUMMARY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM checklist_item ci WHERE ci.checklist_id = c.id AND ci.deleted_at IS NULL) AS total,
    (SELECT COUNT(*) FROM checklist_item ci WHERE ci.checklist_id = c.id AND ci.deleted_at IS NULL AND ci.checked = 1) AS checked
  FROM checklist c
`;

/** Insertions d'items par lots : 10 paramètres par ligne, bien sous la limite de variables de SQLite. */
const INSERT_BATCH = 50;

export function createChecklistRepository(db: SqlExecutor, stamper: WriteStamper): ChecklistRepository {
  async function fetchById(id: ChecklistId, options?: ReadOptions): Promise<ChecklistRow | undefined> {
    const rows = await db.select<ChecklistRow>(`SELECT * FROM checklist WHERE id = ? ${deletedClause(options)} LIMIT 1`, [id]);
    return rows[0];
  }

  async function insertChecklist(checklist: NewChecklist): Promise<void> {
    const stamp = stamper.next();
    await db.execute(
      `INSERT INTO checklist (id, space_id, title, icon, date, is_template, created_at, updated_at, deleted_at, device_id, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        checklist.id,
        checklist.spaceId,
        checklist.title,
        checklist.icon ? encodeIcon(checklist.icon) : null,
        checklist.date,
        checklist.isTemplate ? 1 : 0,
        stamp.at,
        stamp.at,
        stamp.deviceId,
        stamp.hlc,
      ],
    );
  }

  async function write(id: ChecklistId, sets: string[], params: SqlValue[], where: string): Promise<Checklist> {
    const stamp = stamper.next();
    await db.execute(`UPDATE checklist SET ${[...sets, 'updated_at = ?', 'device_id = ?', 'hlc = ?'].join(', ')} WHERE id = ? ${where}`, [
      ...params,
      stamp.at,
      stamp.deviceId,
      stamp.hlc,
      id,
    ]);
    return requireMapped(await fetchById(id, { includeDeleted: true }), 'checklist', id, rowToChecklist);
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToChecklist(row) : null;
    },

    async listSummaries(filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'c.space_id');
      const rows = await db.select<SummaryRow>(`${SUMMARY_SELECT} WHERE c.deleted_at IS NULL ${f.sql} ORDER BY c.title COLLATE NOCASE, c.id`, [...f.params]);
      return rows.map(rowToSummary);
    },

    async listSummariesForDay(date: LocalDate, filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'c.space_id');
      const rows = await db.select<SummaryRow>(`${SUMMARY_SELECT} WHERE c.deleted_at IS NULL AND c.date = ? ${f.sql} ORDER BY c.title, c.id`, [date, ...f.params]);
      return rows.map(rowToSummary);
    },

    async listSummariesForRange(range: DateRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'c.space_id');
      const rows = await db.select<SummaryRow>(
        `${SUMMARY_SELECT} WHERE c.deleted_at IS NULL AND c.date BETWEEN ? AND ? ${f.sql} ORDER BY c.date, c.title, c.id`,
        [range.from, range.to, ...f.params],
      );
      return rows.map(rowToSummary);
    },

    async create(checklist) {
      await insertChecklist(checklist);
      return requireMapped(await fetchById(checklist.id), 'checklist', checklist.id, rowToChecklist);
    },

    async createWithItems(checklist, items) {
      await insertChecklist(checklist);
      for (let start = 0; start < items.length; start += INSERT_BATCH) {
        const batch = items.slice(start, start + INSERT_BATCH);
        const params: SqlValue[] = [];
        for (const item of batch) {
          const stamp = stamper.next();
          params.push(item.id, item.checklistId, item.text, item.checked ? 1 : 0, item.sortOrder, stamp.at, stamp.at, stamp.deviceId, stamp.hlc);
        }
        await db.execute(
          `INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, device_id, hlc) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          params,
        );
      }
      const created = requireMapped(await fetchById(checklist.id), 'checklist', checklist.id, rowToChecklist);
      const rows = await db.select<ItemRow>('SELECT * FROM checklist_item WHERE checklist_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [checklist.id]);
      return { checklist: created, items: rows.map(rowToItem) };
    },

    async update(id, patch: ChecklistPatch) {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.icon !== undefined) {
        sets.push('icon = ?');
        params.push(patch.icon ? encodeIcon(patch.icon) : null);
      }
      if (patch.spaceId !== undefined) {
        sets.push('space_id = ?');
        params.push(patch.spaceId);
      }
      if (patch.isTemplate !== undefined) {
        sets.push('is_template = ?');
        params.push(patch.isTemplate ? 1 : 0);
      }
      requireRow(await fetchById(id), 'checklist', id);
      return write(id, sets, params, 'AND deleted_at IS NULL');
    },

    async setDate(id, date) {
      requireRow(await fetchById(id), 'checklist', id);
      return write(id, ['date = ?'], [date], 'AND deleted_at IS NULL');
    },

    async softDelete(id) {
      requireRow(await fetchById(id), 'checklist', id);
      const stamp = stamper.next();
      await db.execute('UPDATE checklist SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'checklist', id, rowToChecklist);
    },

    async restore(id) {
      requireRow(await fetchById(id, { includeDeleted: true }), 'checklist', id);
      return write(id, ['deleted_at = NULL'], [], 'AND deleted_at IS NOT NULL');
    },
  };
}

export function createChecklistItemRepository(db: SqlExecutor, stamper: WriteStamper): ChecklistItemRepository {
  async function fetchMany(ids: readonly ChecklistItemId[]): Promise<ChecklistItem[]> {
    if (ids.length === 0) return [];
    const { sql, params } = inClause(ids);
    const rows = await db.select<ItemRow>(`SELECT * FROM checklist_item WHERE id IN ${sql}`, params);
    const byId = new Map(rows.map((row) => [row.id, rowToItem(row)]));
    return ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  async function fetchOne(id: ChecklistItemId): Promise<ChecklistItem> {
    return requireRow((await fetchMany([id]))[0], 'checklist_item', id);
  }

  /** Une écriture par item, chacune avec son tampon ; l'item absent lève `not-found` avant toute écriture. */
  async function updateEach(ids: readonly ChecklistItemId[], sets: string, values: readonly SqlValue[], where: string): Promise<ChecklistItem[]> {
    const existing = await fetchMany(ids);
    for (const id of ids) requireRow(existing.find((item) => item.id === id), 'checklist_item', id);
    for (const id of ids) {
      const stamp = stamper.next();
      await db.execute(`UPDATE checklist_item SET ${sets}, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? ${where}`, [...values, stamp.at, stamp.deviceId, stamp.hlc, id]);
    }
    return fetchMany(ids);
  }

  return {
    async listForChecklist(checklistId) {
      const rows = await db.select<ItemRow>('SELECT * FROM checklist_item WHERE checklist_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [checklistId]);
      return rows.map(rowToItem);
    },

    getByIds: fetchMany,

    async add(item: NewChecklistItem) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [item.id, item.checklistId, item.text, item.checked ? 1 : 0, item.sortOrder, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return fetchOne(item.id);
    },

    async setChecked(id, checked) {
      const [item] = await updateEach([id], 'checked = ?', [checked ? 1 : 0], 'AND deleted_at IS NULL');
      return requireRow(item, 'checklist_item', id);
    },

    setCheckedMany: (ids, checked) => updateEach(ids, 'checked = ?', [checked ? 1 : 0], 'AND deleted_at IS NULL'),

    async rename(id, text) {
      const [item] = await updateEach([id], 'text = ?', [text], 'AND deleted_at IS NULL');
      return requireRow(item, 'checklist_item', id);
    },

    async setSortOrders(entries: readonly SortOrderEntry<ChecklistItemId>[]) {
      for (const entry of entries) {
        const stamp = stamper.next();
        await db.execute('UPDATE checklist_item SET sort_order = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [
          entry.sortOrder,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
          entry.id,
        ]);
      }
    },

    async softDelete(ids) {
      const existing = await fetchMany(ids);
      for (const id of ids) requireRow(existing.find((item) => item.id === id), 'checklist_item', id);
      for (const id of ids) {
        const stamp = stamper.next();
        await db.execute('UPDATE checklist_item SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
      }
      return fetchMany(ids);
    },

    restore: (ids) => updateEach(ids, 'deleted_at = NULL', [], 'AND deleted_at IS NOT NULL'),
  };
}
