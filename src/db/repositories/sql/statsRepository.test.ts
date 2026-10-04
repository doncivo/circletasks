import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_ITEMS, type ItemFilter } from '../../../domain/itemFilter';
import type { DateInterval } from '../../../domain/routineSchedule';
import { buildMonthReport, countedRange, weeksOfMonth } from '../../../domain/monthReport';
import { asEntityId, type DeviceId, type LocalDate, type ProjectId, type RoutineId, type SpaceId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000a01');
const d = (value: string) => value as LocalDate;
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000b1');

describe('StatsRepository (SQL) : agrégats du rapport mensuel (H-01, H-02, ES-08)', () => {
  let db: TestDb;
  let counter = 0;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    counter = 0;
    await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Mission client', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [MISSION, SPACE_PRO_ID]);
  });
  afterEach(() => db.close());

  interface TaskSeed {
    readonly date: string | null;
    readonly status?: 'todo' | 'done';
    readonly space?: SpaceId;
    readonly project?: ProjectId | null;
    readonly someday?: boolean;
    readonly deleted?: boolean;
  }

  async function task(seed: TaskSeed): Promise<void> {
    counter += 1;
    await db.driver.execute(
      `INSERT INTO task (id, space_id, project_id, title, date, status, done_at, sort_order, someday, created_at, updated_at, deleted_at, device_id, hlc)
       VALUES (?, ?, ?, 'T', ?, ?, ?, 1, ?, 'z', 'z', ?, 'd', 'h')`,
      [
        `20000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
        seed.space ?? SPACE_PRO_ID,
        seed.project ?? null,
        seed.date,
        seed.status ?? 'todo',
        seed.status === 'done' ? '2026-09-10T08:00:00.000Z' : null,
        seed.someday ? 1 : 0,
        seed.deleted ? '2026-09-11T08:00:00.000Z' : null,
      ],
    );
  }

  const range = { from: d('2026-09-01'), to: d('2026-09-23') };
  const filter = (space: ItemFilter['space'], project: ItemFilter['project'] = null): ItemFilter => ({ space, project });

  it('compte, par semaine ISO, les tâches datées du mois et celles qui sont terminées', async () => {
    await task({ date: '2026-09-01', status: 'done' }); // mardi, S36 (lundi 31 août)
    await task({ date: '2026-09-06', status: 'todo' }); // dimanche, S36
    await task({ date: '2026-09-07', status: 'done' }); // lundi, S37
    await task({ date: '2026-09-13', status: 'done' }); // dimanche, S37
    await task({ date: '2026-09-23', status: 'todo' }); // mercredi, S39
    const rows = await db.data.repos.stats.taskCountsByWeek({ range, filter: ALL_ITEMS });
    expect(rows).toEqual([
      { weekStart: '2026-08-31', total: 2, done: 1 },
      { weekStart: '2026-09-07', total: 2, done: 2 },
      { weekStart: '2026-09-21', total: 1, done: 0 },
    ]);
  });

  it('exclut « Un jour », les tâches supprimées ou écartées, les dates hors plage et les tâches sans date', async () => {
    await task({ date: '2026-09-02', status: 'done' });
    await task({ date: '2026-09-02', status: 'done', someday: true });
    await task({ date: '2026-09-02', status: 'done', deleted: true });
    await task({ date: null });
    await task({ date: '2026-08-31' }); // avant le mois
    await task({ date: '2026-09-24' }); // futur par rapport à la borne
    const rows = await db.data.repos.stats.taskCountsByWeek({ range, filter: ALL_ITEMS });
    expect(rows).toEqual([{ weekStart: '2026-08-31', total: 1, done: 1 }]);
  });

  it('ES-08 : Pro ne compte que les tâches Pro, un projet que les tâches de ce projet, sans projet seulement sous « Tous les projets »', async () => {
    await task({ date: '2026-09-02', status: 'done', space: SPACE_PRO_ID, project: MISSION });
    await task({ date: '2026-09-03', status: 'done', space: SPACE_PRO_ID });
    await task({ date: '2026-09-03', status: 'todo', space: SPACE_PERSO_ID });
    const total = async (f: ItemFilter) => (await db.data.repos.stats.taskCountsByWeek({ range, filter: f })).reduce((sum, row) => sum + row.total, 0);
    expect(await total(ALL_ITEMS)).toBe(3);
    expect(await total(filter(SPACE_PRO_ID))).toBe(2);
    expect(await total(filter(SPACE_PERSO_ID))).toBe(1);
    expect(await total(filter(SPACE_PRO_ID, MISSION))).toBe(1);
    expect(await total(filter(SPACE_PERSO_ID, MISSION))).toBe(0);
  });

  it('H-01 critère 3 : 61 tâches datées de septembre dont 48 terminées donnent 48 / 61, somme des barres comprise', async () => {
    for (let i = 0; i < 61; i += 1) {
      const day = String((i % 23) + 1).padStart(2, '0');
      await task({ date: `2026-09-${day}`, status: i < 48 ? 'done' : 'todo' });
    }
    const weekCounts = await db.data.repos.stats.taskCountsByWeek({ range: countedRange({ year: 2026, month: 9 }, d('2026-09-23')) ?? range, filter: ALL_ITEMS });
    const report = buildMonthReport({
      month: { year: 2026, month: 9 },
      today: d('2026-09-23'),
      filter: ALL_ITEMS,
      firstWeekday: 'monday',
      weekCounts,
      routines: { routines: [], doneByRoutine: new Map<RoutineId, ReadonlySet<LocalDate>>(), pausesOf: new Map<RoutineId, readonly DateInterval[]>() },
      focus: { seconds: 0, sessions: 0 },
      goals: { achieved: 0, total: 0 },
    });
    expect(report.tasks).toEqual({ done: 48, total: 61, percent: 79 });
    expect(report.weeks).toHaveLength(weeksOfMonth({ year: 2026, month: 9 }, d('2026-09-23')).length);
  });

  async function goal(weekStart: string, status: 'open' | 'achieved' | 'closed', space: SpaceId = SPACE_PRO_ID, deleted = false): Promise<void> {
    counter += 1;
    await db.driver.execute(
      "INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, deleted_at, device_id, hlc) VALUES (?, ?, ?, 'G', ?, 'z', 'z', ?, 'd', 'h')",
      [`50000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, space, weekStart, status, deleted ? 'z' : null],
    );
  }

  it('H-01 critère 6 : objectifs dont la semaine commence dans le mois, atteints / total, supprimés exclus', async () => {
    await goal('2026-09-07', 'achieved');
    await goal('2026-09-14', 'achieved', SPACE_PERSO_ID);
    await goal('2026-09-21', 'open');
    await goal('2026-08-31', 'achieved'); // semaine commençant avant le mois
    await goal('2026-09-14', 'achieved', SPACE_PRO_ID, true);
    const query = { range: { from: d('2026-09-01'), to: d('2026-09-30') } };
    expect(await db.data.repos.stats.goalCounts({ ...query, filter: ALL_ITEMS })).toEqual({ achieved: 2, total: 3 });
    expect(await db.data.repos.stats.goalCounts({ ...query, filter: filter(SPACE_PRO_ID) })).toEqual({ achieved: 1, total: 2 });
    // Un objectif n'a pas de projet : sous un filtre de projet, aucun.
    expect(await db.data.repos.stats.goalCounts({ ...query, filter: filter(SPACE_PRO_ID, MISSION) })).toEqual({ achieved: 0, total: 0 });
  });

  it('plus ancienne donnée : tâche, validation, objectif ou session, la plus petite date', async () => {
    expect(await db.data.repos.stats.oldestActivity()).toBeNull();
    await task({ date: '2026-09-02' });
    expect(await db.data.repos.stats.oldestActivity()).toBe('2026-09-02');
    await task({ date: '2026-05-10', someday: true }); // « Un jour » ignorée
    await goal('2026-07-06', 'open');
    expect(await db.data.repos.stats.oldestActivity()).toBe('2026-07-06');
    await db.driver.execute(
      "INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES ('40000000-0000-4000-8000-000000000001', NULL, ?, 25, '2026-06-01T09:00:00.000Z', '2026-06-01T09:25:00.000Z', 0, 'z', 'z', 'd', 'h')",
      [SPACE_PRO_ID],
    );
    expect(await db.data.repos.stats.oldestActivity()).toBe('2026-06-01');
  });
});
