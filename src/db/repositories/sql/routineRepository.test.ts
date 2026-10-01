import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asLocalDate, type DeviceId, type RoutineId, type RoutineLogId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000003');
const routineId = asEntityId<RoutineId>('80000000-0000-4000-8000-000000000001');

describe('RoutineRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée, édite, met en pause, archive une routine (R-01, R-02, R-05)', async () => {
    const created = await db.data.repos.routines.create({
      id: routineId,
      spaceId: SPACE_PRO_ID,
      title: 'Revue des e-mails',
      icon: { kind: 'lucide', name: 'mail' },
      scheduleType: 'weekdays',
      weekdays: [1, 2, 3, 4, 5],
      timesPerWeek: null,
      interval: null,
      startDate: asLocalDate('2026-10-01'),
      time: '08:30' as never,
      paused: false,
      archived: false,
    });
    expect(created.icon).toEqual({ kind: 'lucide', name: 'mail' });

    const paused = await db.data.repos.routines.setPaused(routineId, true);
    expect(paused.paused).toBe(true);

    const archived = await db.data.repos.routines.setArchived(routineId, true);
    expect(archived.archived).toBe(true);

    const listed = await db.data.repos.routines.listForFilter('all');
    expect(listed).toEqual([]);
    expect(await db.data.repos.routines.listForFilter('all', { includeArchived: true })).toHaveLength(1);
  });

  it('listForFilter trie par heure puis titre et filtre par espace', async () => {
    await db.data.repos.routines.create({
      id: routineId,
      spaceId: SPACE_PRO_ID,
      title: 'Revue des e-mails',
      icon: null,
      scheduleType: 'daily',
      weekdays: [],
      timesPerWeek: null,
      interval: null,
      startDate: asLocalDate('2026-10-01'),
      time: '08:30' as never,
      paused: false,
      archived: false,
    });
    const other = asEntityId<RoutineId>('80000000-0000-4000-8000-000000000002');
    await db.data.repos.routines.create({
      id: other,
      spaceId: SPACE_PERSO_ID,
      title: 'Point hebdo',
      icon: null,
      scheduleType: 'x_per_week',
      weekdays: [],
      timesPerWeek: 1,
      interval: null,
      startDate: asLocalDate('2026-10-01'),
      time: null,
      paused: false,
      archived: false,
    });
    const all = await db.data.repos.routines.listForFilter('all');
    expect(all.map((r) => r.id)).toEqual([routineId, other]); // avec heure d'abord, puis sans heure
    expect(await db.data.repos.routines.listForFilter(SPACE_PRO_ID)).toHaveLength(1);
  });

  it('softDelete puis restore', async () => {
    await db.data.repos.routines.create({
      id: routineId,
      spaceId: SPACE_PRO_ID,
      title: 'Revue des e-mails',
      icon: null,
      scheduleType: 'daily',
      weekdays: [],
      timesPerWeek: null,
      interval: null,
      startDate: asLocalDate('2026-10-01'),
      time: null,
      paused: false,
      archived: false,
    });
    const deleted = await db.data.repos.routines.softDelete(routineId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await db.data.repos.routines.getById(routineId)).toBeNull();
    const restored = await db.data.repos.routines.restore(routineId);
    expect(restored.deletedAt).toBeNull();
  });
});

describe('RoutineLogRepository (SQL)', () => {
  let db: TestDb;
  const logId = asEntityId<RoutineLogId>('90000000-0000-4000-8000-000000000001');
  const day = asLocalDate('2026-10-05');

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    await db.data.repos.routines.create({
      id: routineId,
      spaceId: SPACE_PRO_ID,
      title: 'Revue des e-mails',
      icon: null,
      scheduleType: 'daily',
      weekdays: [],
      timesPerWeek: null,
      interval: null,
      startDate: asLocalDate('2026-10-01'),
      time: null,
      paused: false,
      archived: false,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('markDone crée une validation unique (routine_id, date) (R-03)', async () => {
    const log = await db.data.repos.routineLogs.markDone(routineId, day, '2026-10-05T08:00:00.000Z' as never, logId);
    expect(log.routineId).toBe(routineId);
    expect(log.date).toBe(day);

    const forRange = await db.data.repos.routineLogs.listForRange({ from: day, to: day }, 'all');
    expect(forRange).toHaveLength(1);
    const forRoutine = await db.data.repos.routineLogs.listForRoutine(routineId, { from: day, to: day });
    expect(forRoutine).toHaveLength(1);
  });

  it('unmark supprime logiquement, puis un nouveau markDone restaure la même ligne', async () => {
    const created = await db.data.repos.routineLogs.markDone(routineId, day, '2026-10-05T08:00:00.000Z' as never, logId);
    const unmarked = await db.data.repos.routineLogs.unmark(routineId, day);
    expect(unmarked?.deletedAt).not.toBeNull();
    expect(await db.data.repos.routineLogs.listForRange({ from: day, to: day }, 'all')).toEqual([]);

    db.clock.advance(1000);
    const restored = await db.data.repos.routineLogs.markDone(routineId, day, '2026-10-05T09:00:00.000Z' as never, logId);
    expect(restored.id).toBe(created.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.hlc > created.hlc).toBe(true);
  });

  it('unmark renvoie null si rien n’était validé', async () => {
    expect(await db.data.repos.routineLogs.unmark(routineId, day)).toBeNull();
  });

  it('listForRange filtre par espace via la routine', async () => {
    await db.data.repos.routineLogs.markDone(routineId, day, '2026-10-05T08:00:00.000Z' as never, logId);
    expect(await db.data.repos.routineLogs.listForRange({ from: day, to: day }, SPACE_PRO_ID)).toHaveLength(1);
    expect(await db.data.repos.routineLogs.listForRange({ from: day, to: day }, SPACE_PERSO_ID)).toEqual([]);
  });
});
