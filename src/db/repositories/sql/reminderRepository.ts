import type { NewReminder, Reminder, ReminderTarget } from '../../../domain/model';
import type { Hlc, IsoDateTime, LocalDateTime, ReminderId } from '../../../domain/types';
import { compareHlc, type WriteStamp, type WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
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

/** Lignes par instruction des écritures en lot (bien sous la limite de paramètres de SQLite). */
const BATCH = 100;

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

    async createMany(reminders: readonly NewReminder[]) {
      for (let start = 0; start < reminders.length; start += BATCH) {
        const chunk = reminders.slice(start, start + BATCH);
        const params: SqlValue[] = [];
        const rows = chunk.map((input) => {
          const stamp = stamper.next();
          params.push(input.id, input.targetType, input.targetId, input.offsetMin, input.fireAt, stamp.at, stamp.at, stamp.deviceId, stamp.hlc);
          return '(?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)';
        });
        await db.execute(
          `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, deleted_at, device_id, hlc) VALUES ${rows.join(', ')}`,
          params,
        );
      }
      return reminders.length;
    },

    async softDeleteForTargets(targetType: ReminderTarget['type'], targetIds: readonly string[]) {
      let removed = 0;
      for (let start = 0; start < targetIds.length; start += BATCH) {
        const chunk = targetIds.slice(start, start + BATCH);
        const found = await db.select<{ id: string }>(
          `SELECT id FROM reminder WHERE deleted_at IS NULL AND target_type = ? AND target_id IN (${chunk.map(() => '?').join(', ')})`,
          [targetType, ...chunk],
        );
        if (found.length === 0) continue;
        // Un tampon distinct par ligne, dans une seule instruction (CASE par identifiant).
        const stamps = found.map((row) => ({ id: row.id, stamp: stamper.next() }));
        const cases = (pick: (stamp: WriteStamp) => string): { sql: string; params: SqlValue[] } => ({
          sql: `CASE id ${stamps.map(() => 'WHEN ? THEN ?').join(' ')} END`,
          params: stamps.flatMap((entry) => [entry.id, pick(entry.stamp)]),
        });
        const at = cases((stamp) => stamp.at);
        const hlc = cases((stamp) => stamp.hlc);
        await db.execute(
          `UPDATE reminder SET deleted_at = ${at.sql}, updated_at = ${at.sql}, device_id = ?, hlc = ${hlc.sql} WHERE id IN (${stamps.map(() => '?').join(', ')})`,
          [...at.params, ...at.params, stamps[0]?.stamp.deviceId ?? '', ...hlc.params, ...stamps.map((entry) => entry.id)],
        );
        removed += stamps.length;
      }
      return removed;
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

    async listLive() {
      const rows = await db.select<ReminderRow>('SELECT * FROM reminder WHERE deleted_at IS NULL ORDER BY id');
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
