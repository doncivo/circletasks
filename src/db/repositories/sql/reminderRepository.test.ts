import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId, type ReminderId, type TaskId } from '../../../domain/types';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000004');
const taskId = asEntityId<TaskId>('a0000000-0000-4000-8000-000000000001');
const target = { type: 'task', id: taskId } as const;

describe('ReminderRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('replaceForTarget crée, conserve et retire des rappels (N-02)', async () => {
    const r1 = asEntityId<ReminderId>('b0000000-0000-4000-8000-000000000001');
    const r2 = asEntityId<ReminderId>('b0000000-0000-4000-8000-000000000002');

    const first = await db.data.repos.reminders.replaceForTarget(target, [
      { id: r1, targetType: 'task', targetId: taskId, offsetMin: 0, fireAt: '2026-10-05T09:00' as never },
      { id: r2, targetType: 'task', targetId: taskId, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    expect(first).toHaveLength(2);
    expect(await db.data.repos.reminders.listForTarget(target)).toHaveLength(2);

    // Remplace : offset 0 conservé (fire_at mis à jour), offset 15 retiré, offset 60 ajouté.
    const r3 = asEntityId<ReminderId>('b0000000-0000-4000-8000-000000000003');
    const second = await db.data.repos.reminders.replaceForTarget(target, [
      { id: r1, targetType: 'task', targetId: taskId, offsetMin: 0, fireAt: '2026-10-05T09:05' as never },
      { id: r3, targetType: 'task', targetId: taskId, offsetMin: 60, fireAt: '2026-10-05T08:00' as never },
    ]);
    expect(second.map((r) => r.offsetMin).sort()).toEqual([0, 60]);
    const kept = second.find((r) => r.offsetMin === 0);
    expect(kept?.id).toBe(r1); // ligne conservée, pas recréée
    expect(kept?.fireAt).toBe('2026-10-05T09:05');

    const active = await db.data.repos.reminders.listForTarget(target);
    expect(active.map((r) => r.offsetMin).sort()).toEqual([0, 60]);
  });

  it('softDeleteForTarget puis restoreForTarget (T-08)', async () => {
    const r1 = asEntityId<ReminderId>('b0000000-0000-4000-8000-000000000004');
    await db.data.repos.reminders.replaceForTarget(target, [
      { id: r1, targetType: 'task', targetId: taskId, offsetMin: 0, fireAt: '2026-10-05T09:00' as never },
    ]);
    const deleted = await db.data.repos.reminders.softDeleteForTarget(target);
    expect(deleted).toHaveLength(1);
    expect(await db.data.repos.reminders.listForTarget(target)).toEqual([]);

    const restored = await db.data.repos.reminders.restoreForTarget(target);
    expect(restored).toHaveLength(1);
    expect(await db.data.repos.reminders.listForTarget(target)).toHaveLength(1);
  });

  it('listBetween et markDelivered (ordre 5)', async () => {
    const r1 = asEntityId<ReminderId>('b0000000-0000-4000-8000-000000000005');
    await db.data.repos.reminders.replaceForTarget(target, [
      { id: r1, targetType: 'task', targetId: taskId, offsetMin: 0, fireAt: '2026-10-05T09:00' as never },
    ]);
    const between = await db.data.repos.reminders.listBetween('2026-10-05T00:00' as never, '2026-10-06T00:00' as never);
    expect(between).toHaveLength(1);
    expect(between[0]?.delivered).toBe(false);

    const delivered = await db.data.repos.reminders.markDelivered(r1);
    expect(delivered.delivered).toBe(true);
  });
});
