import { encodeSynced, parseSynced, type MergeField } from '../../../domain/appleReminders';
import type { Hlc, IsoDateTime, TaskId } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { AppleReminderLink, AppleReminderLinkRepository, TaskFieldClocks } from '../appleReminderLinkRepository';

interface LinkRow extends SqlRow {
  readonly task_id: string;
  readonly reminder_id: string | null;
  readonly external_ref: string | null;
  readonly list_id: string;
  readonly state: string;
  readonly synced: string | null;
  readonly apple_modified: string | null;
  readonly started_at: string | null;
}

function rowToLink(row: LinkRow): AppleReminderLink {
  return {
    taskId: row.task_id as TaskId,
    reminderId: row.reminder_id,
    externalRef: row.external_ref,
    listId: row.list_id,
    state: row.state as AppleReminderLink['state'],
    synced: parseSynced(row.synced),
    appleModified: row.apple_modified as IsoDateTime | null,
    startedAt: row.started_at as IsoDateTime | null,
  };
}

const CHUNK = 400;
const FIELDS: readonly MergeField[] = ['title', 'date', 'time', 'status'];

/**
 * Table locale `apple_reminder_link` (ADR 0008 §10.2) : aucune publication, aucune capture ; les horloges des champs d'une tâche sont lues
 * ici seulement pour départager un conflit avec Rappels (`sync_field_clock`, table `task`).
 */
export function createAppleReminderLinkRepository(db: SqlExecutor): AppleReminderLinkRepository {
  return {
    async listAll() {
      const rows = await db.select<LinkRow>('SELECT * FROM apple_reminder_link ORDER BY task_id');
      return rows.map(rowToLink);
    },

    async get(taskId) {
      const rows = await db.select<LinkRow>('SELECT * FROM apple_reminder_link WHERE task_id = ?', [taskId]);
      return rows[0] ? rowToLink(rows[0]) : null;
    },

    async findByReminderId(reminderId) {
      const rows = await db.select<LinkRow>('SELECT * FROM apple_reminder_link WHERE reminder_id = ?', [reminderId]);
      return rows[0] ? rowToLink(rows[0]) : null;
    },

    async upsert(link) {
      await db.execute(
        `INSERT INTO apple_reminder_link (task_id, reminder_id, external_ref, list_id, state, synced, apple_modified, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET reminder_id = excluded.reminder_id, external_ref = excluded.external_ref, list_id = excluded.list_id,
           state = excluded.state, synced = excluded.synced, apple_modified = excluded.apple_modified, started_at = excluded.started_at`,
        [link.taskId, link.reminderId, link.externalRef, link.listId, link.state, link.synced === null ? null : encodeSynced(link.synced), link.appleModified, link.startedAt],
      );
    },

    async remove(taskId) {
      await db.execute('DELETE FROM apple_reminder_link WHERE task_id = ?', [taskId]);
    },

    async fieldClocks(taskIds) {
      const result = new Map<TaskId, TaskFieldClocks>();
      for (let start = 0; start < taskIds.length; start += CHUNK) {
        const part = taskIds.slice(start, start + CHUNK);
        const marks = part.map(() => '?').join(', ');
        const tasks = await db.select<{ id: string; hlc: string }>(`SELECT id, hlc FROM task WHERE id IN (${marks})`, [...part]);
        const clocks = await db.select<{ row_id: string; field: string; hlc: string }>(
          `SELECT row_id, field, hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id IN (${marks}) AND field IN ('title', 'date', 'time', 'status', '*')`,
          [...part],
        );
        const byRow = new Map<string, Map<string, string>>();
        for (const clock of clocks) {
          const fields = byRow.get(clock.row_id) ?? new Map<string, string>();
          fields.set(clock.field, clock.hlc);
          byRow.set(clock.row_id, fields);
        }
        for (const task of tasks) {
          const fields = byRow.get(task.id);
          const entries = FIELDS.map((field) => [field, (fields?.get(field) ?? fields?.get('*') ?? task.hlc) as Hlc] as const);
          result.set(task.id as TaskId, Object.fromEntries(entries) as TaskFieldClocks);
        }
      }
      return result;
    },
  };
}
