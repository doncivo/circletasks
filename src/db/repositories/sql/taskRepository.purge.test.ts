import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asIsoDateTime, asLocalDate, type DeviceId, type ReminderId, type TaskId } from '../../../domain/types';
import { SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { sampleTask } from '../../seed/sampleData';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000b8');
const DAY = asLocalDate('2026-10-05');
const tid = (n: number) => asEntityId<TaskId>(`71000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

describe('TaskRepository.purgeDeletedBefore (SQL) : purge de la corbeille (T-08)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-08-01T08:00:00.000Z');
  });
  afterEach(() => db.close());

  it('purge seulement les tâches supprimées avant la limite, avec leurs rappels', async () => {
    const { tasks, reminders } = db.data.repos;
    for (const n of [1, 2, 3]) await tasks.create(sampleTask({ id: tid(n), title: `Tâche ${String(n)}`, date: DAY, spaceId: SPACE_PRO_ID }));
    const reminderId = asEntityId<ReminderId>('72000000-0000-4000-8000-000000000001');
    await reminders.replaceForTarget({ type: 'task', id: tid(1) }, [
      { id: reminderId, targetType: 'task', targetId: tid(1), offsetMin: 0, fireAt: '2026-10-05T09:00' as never },
    ]);

    await tasks.softDelete([tid(1)]); // 1er août
    await reminders.softDeleteForTarget({ type: 'task', id: tid(1) });
    db.clock.set('2026-09-15T08:00:00.000Z');
    await tasks.softDelete([tid(2)]); // 15 sept.
    // tid(3) reste active

    const limit = asIsoDateTime('2026-09-01T00:00:00.000Z');
    expect(await tasks.purgeDeletedBefore(limit)).toBe(1);

    const rows = await db.driver.select<{ id: string }>('SELECT id FROM task ORDER BY id', []);
    expect(rows.map((r) => r.id)).toEqual([tid(2), tid(3)]);
    expect(await db.driver.select('SELECT id FROM reminder', [])).toEqual([]);
    expect(await tasks.purgeDeletedBefore(limit)).toBe(0);
  });
});
