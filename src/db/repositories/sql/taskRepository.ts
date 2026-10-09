import { decodeSeriesTemplate } from '../../../domain/recurrenceEdit';
import { parseIcon, type GoalProgress, type NewRecurrence, type NewTask, type Recurrence, type RecurrencePatch, type SeriesTemplate, type Task, type TaskPatch } from '../../../domain/model';
import {
  asEntityId,
  type ExternalEventId,
  type GoalId,
  type IsoDateTime,
  type LocalDate,
  type LocalTime,
  type ProjectId,
  type RecurrenceId,
  type SpaceFilter,
  type SpaceId,
  type TaskId,
} from '../../../domain/types';
import type { WriteStamper, WriteStamp } from '../../../domain/hlc';
import { addDays } from '../../../domain/localDate';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { RecurrenceRepository, TaskRepository } from '../taskRepository';
import { RepositoryError, type InstantRange, type ReadOptions, type SortOrderEntry } from '../common';
import { deletedClause, fromJson, fromJsonOrNull, inClause, readSyncMeta, requireMapped, requireRow, spaceFilterClause, toJson, type SyncRow } from './sqlHelpers';

interface TaskRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly note: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly status: string;
  readonly done_at: string | null;
  readonly sort_order: number;
  readonly carried_over: number;
  readonly recurrence_id: string | null;
  readonly series_index: number | null;
  readonly series_template: string | null;
  readonly goal_id: string | null;
  readonly icon: string | null;
  readonly someday: number;
  readonly source: string;
  readonly external_id: string | null;
  readonly apple_list_id: string | null;
  readonly apple_recurring: number;
  readonly external_event_id: string | null;
}

/** JSON de la colonne `series_template`, validé par le domaine ; illisible ou invalide : null (la série reprend les valeurs de l'occurrence). */
function parseSeriesTemplate(json: string | null): SeriesTemplate | null {
  if (json === null) return null;
  const decoded = decodeSeriesTemplate(json);
  return decoded.ok ? decoded.value : null;
}

function encodeSeriesTemplate(template: SeriesTemplate | null): string | null {
  return template === null ? null : JSON.stringify({ ...template, icon: template.icon ? encodeIconValue(template.icon) : null });
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id as TaskId,
    spaceId: row.space_id as SpaceId,
    projectId: row.project_id as ProjectId | null,
    title: row.title,
    note: row.note,
    date: row.date as LocalDate | null,
    time: row.time as LocalTime | null,
    status: row.status as Task['status'],
    doneAt: row.done_at as IsoDateTime | null,
    sortOrder: row.sort_order,
    carriedOver: row.carried_over === 1,
    recurrenceId: row.recurrence_id as RecurrenceId | null,
    seriesIndex: row.series_index,
    seriesTemplate: parseSeriesTemplate(row.series_template),
    goalId: row.goal_id as GoalId | null,
    icon: parseIcon(row.icon),
    someday: row.someday === 1,
    source: row.source as Task['source'],
    externalId: row.external_id,
    appleListId: row.apple_list_id,
    appleRecurring: row.apple_recurring === 1,
    externalEventId: row.external_event_id as ExternalEventId | null,
    ...readSyncMeta(row),
  };
}

function taskFromNew(input: NewTask, stamp: WriteStamp): Task {
  return {
    ...input,
    createdAt: stamp.at,
    updatedAt: stamp.at,
    deletedAt: null,
    deviceId: stamp.deviceId,
    hlc: stamp.hlc,
  };
}

const TASK_COLUMNS =
  'id, space_id, project_id, title, note, date, time, status, done_at, sort_order, carried_over, recurrence_id, series_index, series_template, goal_id, icon, someday, source, external_id, external_event_id, apple_list_id, apple_recurring, created_at, updated_at, deleted_at, device_id, hlc';

export function createTaskRepository(db: SqlExecutor, stamper: WriteStamper): TaskRepository {
  async function fetchById(id: TaskId, options?: ReadOptions): Promise<TaskRow | undefined> {
    const rows = await db.select<TaskRow>(`SELECT * FROM task WHERE id = ? ${deletedClause(options)} LIMIT 1`, [id]);
    return rows[0];
  }

  async function fetchByIds(ids: readonly TaskId[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const { sql, params } = inClause(ids);
    const rows = await db.select<TaskRow>(`SELECT * FROM task WHERE id IN ${sql}`, params);
    const byId = new Map(rows.map((row) => [row.id, rowToTask(row)]));
    return ids.map((id) => requireRow(byId.get(id), 'task', id));
  }

  /** Applique un même jeu de colonnes à chaque id, un tampon distinct par ligne (règle commune n°3). */
  async function updateEach(ids: readonly TaskId[], setSql: string, extraParams: (id: TaskId) => SqlValue[]): Promise<Task[]> {
    for (const id of ids) {
      await db.execute(`UPDATE task SET ${setSql} WHERE id = ? AND deleted_at IS NULL`, [...extraParams(id), id]);
    }
    return fetchByIds(ids);
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToTask(row) : null;
    },

    async findByExternalEvent(eventId) {
      const rows = await db.select<TaskRow>('SELECT * FROM task WHERE external_event_id = ? AND deleted_at IS NULL AND discarded = 0 ORDER BY created_at, id LIMIT 1', [eventId]);
      return rows[0] ? rowToTask(rows[0]) : null;
    },

    async listAppleSourced() {
      const rows = await db.select<TaskRow>("SELECT * FROM task WHERE source = 'apple_reminders' AND deleted_at IS NULL AND discarded = 0 ORDER BY created_at, id");
      return rows.map(rowToTask);
    },

    async findByExternalId(externalId) {
      const rows = await db.select<TaskRow>("SELECT * FROM task WHERE source = 'apple_reminders' AND external_id = ? AND deleted_at IS NULL AND discarded = 0 ORDER BY created_at, id LIMIT 1", [externalId]);
      return rows[0] ? rowToTask(rows[0]) : null;
    },

    async setAppleLink(id, link) {
      const stamp = stamper.next();
      // Sans filtre sur la corbeille : le détachement d'une tâche supprimée (suppression envoyée vers Rappels) est une écriture normale.
      await db.execute('UPDATE task SET source = ?, external_id = ?, apple_list_id = ?, apple_recurring = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [
        link.source,
        link.externalId,
        link.appleListId,
        link.appleRecurring ? 1 : 0,
        stamp.at,
        stamp.deviceId,
        stamp.hlc,
        id,
      ]);
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'task', id, rowToTask);
    },

    async create(task: NewTask, options?: { readonly idempotent?: boolean }) {
      const stamp = stamper.next();
      const written = await db.execute(
        // Écriture idempotente (Q-05, option `idempotent`) : un id déjà présent est ignoré (« Réessayer » rejoue la même création).
        `INSERT INTO task (${TASK_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ${options?.idempotent ? 'ON CONFLICT(id) DO NOTHING' : ''}`,
        [
          task.id,
          task.spaceId,
          task.projectId,
          task.title,
          task.note,
          task.date,
          task.time,
          task.status,
          task.doneAt,
          task.sortOrder,
          task.carriedOver ? 1 : 0,
          task.recurrenceId,
          task.seriesIndex,
          encodeSeriesTemplate(task.seriesTemplate),
          task.goalId,
          task.icon ? encodeIconValue(task.icon) : null,
          task.someday ? 1 : 0,
          task.source,
          task.externalId,
          task.externalEventId,
          task.appleListId,
          task.appleRecurring ? 1 : 0,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      if (written.rowsAffected === 0) {
        // Jamais une tâche inventée : la ligne existante est rendue, sinon l'échec est dit.
        const existing = await this.getById(task.id);
        if (!existing) throw new RepositoryError('conflict', 'task', task.id);
        return existing;
      }
      return taskFromNew(task, stamp);
    },

    async createMany(tasks: readonly NewTask[]) {
      const created: Task[] = [];
      // Insertion par paquets (une instruction par paquet), un tampon distinct par ligne (règle commune n°3).
      for (let start = 0; start < tasks.length; start += 50) {
        const chunk = tasks.slice(start, start + 50);
        const params: SqlValue[] = [];
        const rows = chunk.map((task) => {
          const stamp = stamper.next();
          params.push(
            task.id,
            task.spaceId,
            task.projectId,
            task.title,
            task.note,
            task.date,
            task.time,
            task.status,
            task.doneAt,
            task.sortOrder,
            task.carriedOver ? 1 : 0,
            task.recurrenceId,
            task.seriesIndex,
            encodeSeriesTemplate(task.seriesTemplate),
            task.goalId,
            task.icon ? encodeIconValue(task.icon) : null,
            task.someday ? 1 : 0,
            task.source,
            task.externalId,
            task.externalEventId,
            task.appleListId,
            task.appleRecurring ? 1 : 0,
            stamp.at,
            stamp.at,
            stamp.deviceId,
            stamp.hlc,
          );
          created.push(taskFromNew(task, stamp));
          return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)';
        });
        await db.execute(`INSERT INTO task (${TASK_COLUMNS}) VALUES ${rows.join(', ')}`, params);
      }
      return created;
    },

    async update(id: TaskId, patch: TaskPatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.spaceId !== undefined) {
        sets.push('space_id = ?');
        params.push(patch.spaceId);
      }
      if (patch.projectId !== undefined) {
        sets.push('project_id = ?');
        params.push(patch.projectId);
      }
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.note !== undefined) {
        sets.push('note = ?');
        params.push(patch.note);
      }
      if (patch.date !== undefined) {
        sets.push('date = ?');
        params.push(patch.date);
      }
      if (patch.time !== undefined) {
        sets.push('time = ?');
        params.push(patch.time);
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.doneAt !== undefined) {
        sets.push('done_at = ?');
        params.push(patch.doneAt);
      }
      if (patch.sortOrder !== undefined) {
        sets.push('sort_order = ?');
        params.push(patch.sortOrder);
      }
      if (patch.carriedOver !== undefined) {
        sets.push('carried_over = ?');
        params.push(patch.carriedOver ? 1 : 0);
      }
      if (patch.recurrenceId !== undefined) {
        sets.push('recurrence_id = ?');
        params.push(patch.recurrenceId);
      }
      if (patch.seriesIndex !== undefined) {
        sets.push('series_index = ?');
        params.push(patch.seriesIndex);
      }
      if (patch.seriesTemplate !== undefined) {
        sets.push('series_template = ?');
        params.push(encodeSeriesTemplate(patch.seriesTemplate));
      }
      if (patch.goalId !== undefined) {
        sets.push('goal_id = ?');
        params.push(patch.goalId);
      }
      if (patch.icon !== undefined) {
        sets.push('icon = ?');
        params.push(patch.icon ? encodeIconValue(patch.icon) : null);
      }
      if (patch.someday !== undefined) {
        sets.push('someday = ?');
        params.push(patch.someday ? 1 : 0);
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(`UPDATE task SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
      return requireMapped(await fetchById(id), 'task', id, rowToTask);
    },

    async complete(id: TaskId, doneAt: IsoDateTime) {
      const stamp = stamper.next();
      await db.execute(
        "UPDATE task SET status = 'done', done_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL",
        [doneAt, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'task', id, rowToTask);
    },

    async reopen(id: TaskId) {
      const stamp = stamper.next();
      await db.execute(
        "UPDATE task SET status = 'todo', done_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL",
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'task', id, rowToTask);
    },

    async reschedule(ids: readonly TaskId[], date: LocalDate, time?: LocalTime | null) {
      const setTime = time !== undefined;
      return updateEach(
        ids,
        `date = ?${setTime ? ', time = ?' : ''}, someday = 0, carried_over = 0, updated_at = ?, device_id = ?, hlc = ?`,
        () => {
          const stamp = stamper.next();
          const values: SqlValue[] = [date];
          if (setTime) values.push(time ?? null);
          values.push(stamp.at, stamp.deviceId, stamp.hlc);
          return values;
        },
      );
    },

    async carryOver(ids: readonly TaskId[], date: LocalDate) {
      return updateEach(ids, 'date = ?, carried_over = 1, updated_at = ?, device_id = ?, hlc = ?', () => {
        const stamp = stamper.next();
        return [date, stamp.at, stamp.deviceId, stamp.hlc];
      });
    },

    async moveToSpace(ids: readonly TaskId[], spaceId: SpaceId, projectId: ProjectId | null) {
      return updateEach(ids, 'space_id = ?, project_id = ?, updated_at = ?, device_id = ?, hlc = ?', () => {
        const stamp = stamper.next();
        return [spaceId, projectId, stamp.at, stamp.deviceId, stamp.hlc];
      });
    },

    async setSortOrders(entries: readonly SortOrderEntry<TaskId>[]) {
      for (const entry of entries) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE task SET sort_order = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
          [entry.sortOrder, stamp.at, stamp.deviceId, stamp.hlc, entry.id],
        );
      }
    },

    async softDelete(ids: readonly TaskId[]) {
      for (const id of ids) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE task SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
          [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
        );
      }
      if (ids.length === 0) return [];
      const { sql, params } = inClause(ids);
      const rows = await db.select<TaskRow>(`SELECT * FROM task WHERE id IN ${sql}`, params);
      const byId = new Map(rows.map((row) => [row.id, rowToTask(row)]));
      return ids.map((id) => requireRow(byId.get(id), 'task', id));
    },

    async discard(ids: readonly TaskId[]) {
      for (const id of ids) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE task SET deleted_at = ?, discarded = 1, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
          [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
        );
      }
      return fetchByIds(ids);
    },

    async discardUnchanged(entries) {
      const discarded: TaskId[] = [];
      for (let start = 0; start < entries.length; start += 100) {
        const chunk = entries.slice(start, start + 100);
        const found = await db.select<{ id: string }>(
          `SELECT id FROM task WHERE deleted_at IS NULL AND (${chunk.map(() => '(id = ? AND hlc = ?)').join(' OR ')})`,
          chunk.flatMap((entry) => [entry.id, entry.hlc]),
        );
        if (found.length === 0) continue;
        const stamps = found.map((row) => ({ id: row.id, stamp: stamper.next() }));
        const cases = (pick: (stamp: WriteStamp) => string): { sql: string; params: SqlValue[] } => ({
          sql: `CASE id ${stamps.map(() => 'WHEN ? THEN ?').join(' ')} END`,
          params: stamps.flatMap((entry) => [entry.id, pick(entry.stamp)]),
        });
        const at = cases((stamp) => stamp.at);
        const hlc = cases((stamp) => stamp.hlc);
        await db.execute(
          `UPDATE task SET deleted_at = ${at.sql}, discarded = 1, updated_at = ${at.sql}, device_id = ?, hlc = ${hlc.sql} WHERE id IN (${stamps.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
          [...at.params, ...at.params, stamps[0]?.stamp.deviceId ?? '', ...hlc.params, ...stamps.map((entry) => entry.id)],
        );
        discarded.push(...stamps.map((entry) => entry.id as TaskId));
      }
      return discarded;
    },

    async restore(ids: readonly TaskId[]) {
      for (const id of ids) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE task SET deleted_at = NULL, discarded = 0, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL',
          [stamp.at, stamp.deviceId, stamp.hlc, id],
        );
      }
      return fetchByIds(ids);
    },

    async listByIds(ids: readonly TaskId[]) {
      const out: Task[] = [];
      for (let start = 0; start < ids.length; start += 200) {
        const chunk = ids.slice(start, start + 200);
        const rows = await db.select<TaskRow>(`SELECT * FROM task WHERE deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`, [...chunk]);
        out.push(...rows.map(rowToTask));
      }
      return out;
    },

    async listForDay(date: LocalDate, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<TaskRow>(
        `SELECT * FROM task WHERE deleted_at IS NULL AND date = ? ${f.sql} ORDER BY sort_order, id`,
        [date, ...f.params],
      );
      return rows.map(rowToTask);
    },

    async listForWeek(weekStart: LocalDate, filter: SpaceFilter) {
      const weekEnd = addDays(weekStart, 6);
      const f = spaceFilterClause(filter);
      const rows = await db.select<TaskRow>(
        `SELECT * FROM task WHERE deleted_at IS NULL AND date BETWEEN ? AND ? ${f.sql} ORDER BY date, sort_order, id`,
        [weekStart, weekEnd, ...f.params],
      );
      return rows.map(rowToTask);
    },

    async listSomeday(filter: SpaceFilter, projectId?: ProjectId) {
      const f = spaceFilterClause(filter);
      const params: SqlValue[] = [...f.params];
      let sql = `SELECT * FROM task WHERE deleted_at IS NULL AND someday = 1 ${f.sql}`;
      if (projectId !== undefined) {
        sql += ' AND project_id = ?';
        params.push(projectId);
      }
      sql += ' ORDER BY sort_order, id';
      const rows = await db.select<TaskRow>(sql, params);
      return rows.map(rowToTask);
    },

    async countSomeday(filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND someday = 1 ${f.sql}`,
        f.params,
      );
      return rows[0]?.n ?? 0;
    },

    async listUndoneBefore(date: LocalDate) {
      const rows = await db.select<TaskRow>(
        "SELECT * FROM task WHERE deleted_at IS NULL AND status = 'todo' AND date IS NOT NULL AND date < ? ORDER BY date, sort_order, id",
        [date],
      );
      return rows.map(rowToTask);
    },

    async listDone(range: InstantRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<TaskRow>(
        `SELECT * FROM task WHERE deleted_at IS NULL AND status = 'done' AND done_at >= ? AND done_at < ? ${f.sql} ORDER BY done_at, id`,
        [range.from, range.to, ...f.params],
      );
      return rows.map(rowToTask);
    },

    async listByGoal(goalId: GoalId) {
      const rows = await db.select<TaskRow>(
        'SELECT * FROM task WHERE deleted_at IS NULL AND goal_id = ? ORDER BY sort_order, id',
        [goalId],
      );
      return rows.map(rowToTask);
    },

    async progressByGoal(goalIds: readonly GoalId[]) {
      const result = new Map<GoalId, GoalProgress>(goalIds.map((id) => [id, { done: 0, total: 0 }]));
      if (goalIds.length === 0) return result;
      const { sql, params } = inClause(goalIds);
      const rows = await db.select<{ goal_id: string; status: string; n: number }>(
        `SELECT goal_id, status, COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND goal_id IN ${sql} GROUP BY goal_id, status`,
        params,
      );
      for (const row of rows) {
        const goalId = row.goal_id as GoalId;
        const current = result.get(goalId) ?? { done: 0, total: 0 };
        result.set(goalId, {
          done: current.done + (row.status === 'done' ? row.n : 0),
          total: current.total + row.n,
        });
      }
      return result;
    },

    async listByRecurrence(recurrenceId: RecurrenceId, options?: ReadOptions) {
      const rows = await db.select<TaskRow>(
        `SELECT * FROM task WHERE recurrence_id = ? ${deletedClause(options)} ORDER BY series_index, id`,
        [recurrenceId],
      );
      return rows.map(rowToTask);
    },

    async listTrash(since: IsoDateTime, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<TaskRow>(
        `SELECT * FROM task WHERE deleted_at IS NOT NULL AND deleted_at >= ? AND discarded = 0 AND (series_index IS NULL OR series_index >= 0) ${f.sql} ORDER BY deleted_at DESC`,
        [since, ...f.params],
      );
      return rows.map(rowToTask);
    },

    async existingTitleDates(keys) {
      const wanted = new Set(keys.map((key) => `${key.title}\u0000${key.date ?? ''}`));
      const titles = [...new Set(keys.map((key) => key.title))];
      const found = new Set<string>();
      // Titres par paquets de 200 : bien sous la limite de paramètres, une seule lecture de la table par paquet.
      for (let index = 0; index < titles.length; index += 200) {
        const chunk = titles.slice(index, index + 200);
        const rows = await db.select<{ title: string; date: string | null }>(
          `SELECT DISTINCT title, date FROM task WHERE deleted_at IS NULL AND title IN (${chunk.map(() => '?').join(', ')})`,
          chunk,
        );
        for (const row of rows) {
          const key = `${row.title}\u0000${row.date ?? ''}`;
          if (wanted.has(key)) found.add(key);
        }
      }
      return found;
    },

    async purgeDeletedBefore(before: IsoDateTime) {
      const expired = await db.select<{ id: string }>('SELECT id FROM task WHERE deleted_at IS NOT NULL AND deleted_at < ?', [before]);
      if (expired.length === 0) return 0;
      const { sql, params } = inClause(expired.map((row) => asEntityId<TaskId>(row.id)));
      // Sans synchro configurée (T-08, inchangée) : les horloges de champ et entrées de file des lignes purgées disparaissent avec elles
      // (ADR 0011 section 5.4 ; avec synchro, la purge passe par la règle des traces, src/sync/maintenance.ts).
      await db.execute(`DELETE FROM sync_field_clock WHERE table_name = 'reminder' AND row_id IN (SELECT id FROM reminder WHERE target_type = 'task' AND target_id IN ${sql})`, params);
      await db.execute(`DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id IN (SELECT id FROM reminder WHERE target_type = 'task' AND target_id IN ${sql})`, params);
      await db.execute(`DELETE FROM reminder WHERE target_type = 'task' AND target_id IN ${sql}`, params);
      await db.execute(`DELETE FROM sync_field_clock WHERE table_name = 'task' AND row_id IN ${sql}`, params);
      await db.execute(`DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id IN ${sql}`, params);
      await db.execute(`DELETE FROM task WHERE id IN ${sql}`, params);
      return expired.length;
    },
  };
}

/** Icône déjà validée côté domaine (`encodeIcon` lève si invalide) ; conversion locale. */
function encodeIconValue(icon: NonNullable<Task['icon']>): string {
  return icon.kind === 'lucide' ? `lucide:${icon.name}` : `emoji:${icon.value}`;
}

interface RecurrenceRow extends SqlRow, SyncRow {
  readonly freq: string;
  readonly interval: number;
  readonly weekdays: string;
  readonly month_day: number | null;
  readonly nth_weekday: string | null;
  readonly until: string | null;
  readonly count: number | null;
}

function rowToRecurrence(row: RecurrenceRow): Recurrence {
  return {
    id: row.id as RecurrenceId,
    freq: row.freq as Recurrence['freq'],
    interval: row.interval,
    weekdays: fromJson(row.weekdays, []),
    monthDay: row.month_day,
    nthWeekday: fromJsonOrNull(row.nth_weekday),
    until: row.until as LocalDate | null,
    count: row.count,
    ...readSyncMeta(row),
  };
}

export function createRecurrenceRepository(db: SqlExecutor, stamper: WriteStamper): RecurrenceRepository {
  async function fetchById(id: RecurrenceId, options?: ReadOptions): Promise<RecurrenceRow | undefined> {
    const rows = await db.select<RecurrenceRow>(
      `SELECT * FROM recurrence WHERE id = ? ${deletedClause(options)} LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToRecurrence(row) : null;
    },

    async create(recurrence: NewRecurrence) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO recurrence (id, freq, interval, weekdays, month_day, nth_weekday, until, count, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          recurrence.id,
          recurrence.freq,
          recurrence.interval,
          toJson(recurrence.weekdays),
          recurrence.monthDay,
          recurrence.nthWeekday ? toJson(recurrence.nthWeekday) : null,
          recurrence.until,
          recurrence.count,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      return requireMapped(await fetchById(recurrence.id), 'recurrence', recurrence.id, rowToRecurrence);
    },

    async update(id: RecurrenceId, patch: RecurrencePatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.freq !== undefined) {
        sets.push('freq = ?');
        params.push(patch.freq);
      }
      if (patch.interval !== undefined) {
        sets.push('interval = ?');
        params.push(patch.interval);
      }
      if (patch.weekdays !== undefined) {
        sets.push('weekdays = ?');
        params.push(toJson(patch.weekdays));
      }
      if (patch.monthDay !== undefined) {
        sets.push('month_day = ?');
        params.push(patch.monthDay);
      }
      if (patch.nthWeekday !== undefined) {
        sets.push('nth_weekday = ?');
        params.push(patch.nthWeekday ? toJson(patch.nthWeekday) : null);
      }
      if (patch.until !== undefined) {
        sets.push('until = ?');
        params.push(patch.until);
      }
      if (patch.count !== undefined) {
        sets.push('count = ?');
        params.push(patch.count);
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(`UPDATE recurrence SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
      return requireMapped(await fetchById(id), 'recurrence', id, rowToRecurrence);
    },

    async softDelete(id: RecurrenceId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE recurrence SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'recurrence', id, rowToRecurrence);
    },

    async restore(id: RecurrenceId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE recurrence SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL',
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'recurrence', id, rowToRecurrence);
    },
  };
}
