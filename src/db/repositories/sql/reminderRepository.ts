import type { NewReminder, Reminder, ReminderTarget } from '../../../domain/model';
import type { Hlc, IsoDateTime, LocalDateTime, ReminderId } from '../../../domain/types';
import { compareHlc, type WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { ReminderDeletionMark, ReminderRepository } from '../reminderRepository';
import { readSyncMeta, requireMapped, type SyncRow } from './sqlHelpers';

interface ReminderRow extends SqlRow, SyncRow {
  readonly target_type: string;
  readonly target_id: string;
  readonly offset_min: number;
  readonly fire_at: string;
  readonly delivered: number;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id as ReminderId,
    targetType: row.target_type as Reminder['targetType'],
    targetId: row.target_id as Reminder['targetId'],
    offsetMin: row.offset_min as Reminder['offsetMin'],
    fireAt: row.fire_at as LocalDateTime,
    delivered: row.delivered === 1,
    ...readSyncMeta(row),
  };
}

export function createReminderRepository(db: SqlExecutor, stamper: WriteStamper): ReminderRepository {
  async function fetchById(id: ReminderId): Promise<ReminderRow | undefined> {
    const rows = await db.select<ReminderRow>('SELECT * FROM reminder WHERE id = ? LIMIT 1', [id]);
    return rows[0];
  }

  async function fetchActiveForTarget(target: ReminderTarget): Promise<ReminderRow[]> {
    return db.select<ReminderRow>(
      'SELECT * FROM reminder WHERE deleted_at IS NULL AND target_type = ? AND target_id = ? ORDER BY fire_at',
      [target.type, target.id],
    );
  }

  return {
    async listForTarget(target: ReminderTarget) {
      const rows = await fetchActiveForTarget(target);
      return rows.map(rowToReminder);
    },

    async replaceForTarget(target: ReminderTarget, reminders: readonly NewReminder[]) {
      const existing = await fetchActiveForTarget(target);
      const existingByOffset = new Map(existing.map((row) => [row.offset_min, row]));
      const keepOffsets = new Set<number>(reminders.map((r) => r.offsetMin));

      for (const input of reminders) {
        const match = existingByOffset.get(input.offsetMin);
        const stamp = stamper.next();
        if (match) {
          await db.execute(
            'UPDATE reminder SET fire_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
            [input.fireAt, stamp.at, stamp.deviceId, stamp.hlc, match.id],
          );
        } else {
          await db.execute(
            `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, deleted_at, device_id, hlc)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
            [input.id, target.type, target.id, input.offsetMin, input.fireAt, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
          );
        }
      }
      for (const row of existing) {
        if (!keepOffsets.has(row.offset_min)) {
          const stamp = stamper.next();
          await db.execute(
            'UPDATE reminder SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
            [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, row.id],
          );
        }
      }
      return (await fetchActiveForTarget(target)).map(rowToReminder);
    },

    async softDeleteForTarget(target: ReminderTarget, deletedAt?: IsoDateTime) {
      const existing = await fetchActiveForTarget(target);
      const result: Reminder[] = [];
      for (const row of existing) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE reminder SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
          [deletedAt ?? stamp.at, stamp.at, stamp.deviceId, stamp.hlc, row.id],
        );
        result.push(requireMapped(await fetchById(row.id as ReminderId), 'reminder', row.id, rowToReminder));
      }
      return result;
    },

    async restoreForTarget(target: ReminderTarget, deletion: ReminderDeletionMark) {
      const all = await db.select<ReminderRow>(
        'SELECT * FROM reminder WHERE deleted_at IS NOT NULL AND target_type = ? AND target_id = ?',
        [target.type, target.id],
      );
      // Seulement les rappels supprimés avec l'élément (même deleted_at, hlc postérieur à celui de l'élément).
      const deleted = all.filter((row) => row.deleted_at === deletion.deletedAt && compareHlc(row.hlc as Hlc, deletion.hlc) > 0);
      const result: Reminder[] = [];
      for (const row of deleted) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE reminder SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
          [stamp.at, stamp.deviceId, stamp.hlc, row.id],
        );
        result.push(requireMapped(await fetchById(row.id as ReminderId), 'reminder', row.id, rowToReminder));
      }
      return result;
    },

    async listBetween(from: LocalDateTime, to: LocalDateTime) {
      const rows = await db.select<ReminderRow>(
        'SELECT * FROM reminder WHERE deleted_at IS NULL AND fire_at >= ? AND fire_at < ? ORDER BY fire_at',
        [from, to],
      );
      return rows.map(rowToReminder);
    },

    async markDelivered(id: ReminderId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE reminder SET delivered = 1, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'reminder', id, rowToReminder);
    },
  };
}
