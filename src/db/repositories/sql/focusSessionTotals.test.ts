import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusTotalMinutes, focusTotals, focusTotalsByTask, daySpan, monthSpan, type InstantSpan } from '../../../domain/focusTotals';
import { ALL_ITEMS, type ItemFilter } from '../../../domain/itemFilter';
import { asEntityId, type DeviceId, type FocusSessionId, type IsoDateTime, type LocalDate, type ProjectId, type SpaceId, type TaskId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000f03');
const d = (value: string) => value as LocalDate;
const sid = (n: number) => asEntityId<FocusSessionId>(`40000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const local = (y: number, m: number, day: number, h: number, min: number, sec = 0, ms = 0): IsoDateTime => new Date(y, m - 1, day, h, min, sec, ms).toISOString() as IsoDateTime;

describe('Totaux de concentration (SQL, F-03)', () => {
  let db: TestDb;
  let mission: ProjectId;
  let taskA: TaskId;
  let taskB: TaskId;
  let taskC: TaskId;
  let counter = 0;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    mission = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000a1');
    await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Mission client', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [mission, SPACE_PRO_ID]);
    const insertTask = async (n: number, projectId: ProjectId | null, space: SpaceId = SPACE_PRO_ID): Promise<TaskId> => {
      const id = asEntityId<TaskId>(`20000000-0000-4000-8000-00000000000${String(n)}`);
      await db.driver.execute("INSERT INTO task (id, space_id, project_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, '2026-10-04', 'todo', 1, 'z', 'z', 'd', 'h')", [id, space, projectId, `Tâche ${String(n)}`]);
      return id;
    };
    taskA = await insertTask(1, mission);
    taskB = await insertTask(2, null);
    taskC = await insertTask(3, mission);
    counter = 0;
  });
  afterEach(() => db.close());

  async function add(taskId: TaskId | null, space: SpaceId, startedAt: IsoDateTime, minutes: number | null, pausedSec = 0): Promise<FocusSessionId> {
    counter += 1;
    const id = sid(counter);
    await db.data.repos.focusSessions.create({ id, taskId, spaceId: space, plannedMin: 25, startedAt });
    if (minutes !== null) await db.data.repos.focusSessions.update(id, { endedAt: new Date(Date.parse(startedAt) + minutes * 60_000 + pausedSec * 1000).toISOString() as IsoDateTime, pausedSec });
    return id;
  }

  const filter = (space: ItemFilter['space'], project: ItemFilter['project'] = null): ItemFilter => ({ space, project });
  const today = (): InstantSpan => daySpan(d('2026-10-04'));

  it('critère 1 : 45 + 20 + 10 min aujourd’hui = 75 min en 3 sessions, toutes sessions confondues', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), 45);
    await add(taskB, SPACE_PRO_ID, local(2026, 10, 4, 11, 0), 20);
    await add(null, SPACE_PERSO_ID, local(2026, 10, 4, 15, 0), 10);
    const total = await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS });
    expect(total).toEqual({ seconds: 75 * 60, sessions: 3 });
  });

  it('critère 2 : aucune session aujourd’hui, zéro', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 3, 9, 0), 45);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS })).toEqual({ seconds: 0, sessions: 0 });
  });

  it('ni les sessions en cours, ni les sessions supprimées (moins d’une minute) ne comptent', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), null);
    const gone = await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 10, 0), 30);
    await db.data.repos.focusSessions.discard(gone);
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 11, 0), 15);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS })).toEqual({ seconds: 900, sessions: 1 });
  });

  it('les pauses sont retirées et le total est arrondi comme le calcul du domaine', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0, 0, 400), 25, 300);
    const total = await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS });
    expect(total.seconds).toBe(25 * 60);
  });

  it('D2 : la session qui franchit minuit compte au jour de son début', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 23, 40), 50);
    expect((await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS })).sessions).toBe(1);
    expect((await db.data.repos.focusSessions.totals({ span: daySpan(d('2026-10-05')), filter: ALL_ITEMS })).sessions).toBe(0);
  });

  it('critère 5 : filtre Pro puis projet « Mission client » ; une session sans projet n’est que dans « Tous les projets »', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), 25);
    await add(taskC, SPACE_PRO_ID, local(2026, 10, 4, 10, 0), 30);
    await add(taskB, SPACE_PRO_ID, local(2026, 10, 4, 11, 0), 20);
    await add(null, SPACE_PRO_ID, local(2026, 10, 4, 12, 0), 15);
    await add(taskA, SPACE_PERSO_ID, local(2026, 10, 4, 13, 0), 10);
    const minutes = async (f: ItemFilter) => focusTotalMinutes(await db.data.repos.focusSessions.totals({ span: today(), filter: f }));
    expect(await minutes(filter(SPACE_PRO_ID, mission))).toBe(55);
    expect(await minutes(filter(SPACE_PRO_ID))).toBe(90);
    expect(await minutes(filter(SPACE_PERSO_ID))).toBe(10);
    expect(await minutes(ALL_ITEMS)).toBe(100);
    expect(await minutes(filter('all', mission))).toBe(65); // projet seul (« Tout » n'applique le projet qu'à l'interface)
  });

  it('critère 8 : une tâche à la corbeille ne change aucun total ; la suppression définitive ne retire que le filtre par projet', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), 25);
    const before = await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS });
    await db.data.repos.tasks.softDelete([taskA]);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS })).toEqual(before);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: filter(SPACE_PRO_ID, mission) })).toEqual(before);
    await db.driver.execute('DELETE FROM task WHERE id = ?', [taskA]);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: ALL_ITEMS })).toEqual(before);
    expect(await db.data.repos.focusSessions.totals({ span: today(), filter: filter(SPACE_PRO_ID) })).toEqual(before);
  });

  it('critère 3 : total d’une tâche, toutes dates confondues : 50 min en 2 sessions', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 9, 20, 9, 0), 25);
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), 25);
    await add(taskB, SPACE_PRO_ID, local(2026, 10, 4, 11, 0), 20);
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 4, 12, 0), null);
    expect(await db.data.repos.focusSessions.totalsForTask(taskA)).toEqual({ seconds: 3000, sessions: 2 });
    expect(await db.data.repos.focusSessions.totalsForTask(taskC)).toEqual({ seconds: 0, sessions: 0 });
  });

  it('critère 4 : les tâches les plus travaillées du mois', async () => {
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 2, 9, 0), 75);
    await add(taskA, SPACE_PRO_ID, local(2026, 10, 3, 9, 0), 75);
    await add(taskC, SPACE_PRO_ID, local(2026, 10, 4, 9, 0), 100);
    await add(taskB, SPACE_PRO_ID, local(2026, 10, 4, 12, 0), 20);
    await add(null, SPACE_PRO_ID, local(2026, 10, 4, 14, 0), 500);
    await add(taskB, SPACE_PRO_ID, local(2026, 9, 30, 9, 0), 900);
    const top = await db.data.repos.focusSessions.totalsByTask({ span: monthSpan(d('2026-10-04')), filter: ALL_ITEMS }, 5);
    expect(top.map((entry) => [entry.taskId, focusTotalMinutes(entry), entry.sessions])).toEqual([
      [taskA, 150, 2],
      [taskC, 100, 1],
      [taskB, 20, 1],
    ]);
    expect(await db.data.repos.focusSessions.totalsByTask({ span: monthSpan(d('2026-10-04')), filter: ALL_ITEMS }, 2)).toHaveLength(2);
    const mine = await db.data.repos.focusSessions.totalsByTask({ span: monthSpan(d('2026-10-04')), filter: filter(SPACE_PRO_ID, mission) }, 5);
    expect(mine.map((entry) => entry.taskId)).toEqual([taskA, taskC]);
  });

  it('les requêtes SQL et le calcul du domaine donnent les mêmes totaux sur un jeu varié', async () => {
    const records: Parameters<typeof focusTotals>[0][number][] = [];
    const tasks = new Map<TaskId, { projectId: ProjectId | null }>([
      [taskA, { projectId: mission }],
      [taskB, { projectId: null }],
      [taskC, { projectId: mission }],
    ]);
    const pool = [taskA, taskB, taskC, null] as const;
    for (let i = 0; i < 60; i += 1) {
      const taskId = pool[i % 4] ?? null;
      const space = i % 3 === 0 ? SPACE_PERSO_ID : SPACE_PRO_ID;
      const startedAt = local(2026, 10, 1 + (i % 6), 8 + (i % 10), (i * 7) % 60, i % 60, (i * 37) % 1000);
      const minutes = 1 + ((i * 13) % 90);
      const paused = i % 5 === 0 ? 45 : 0;
      const id = await add(taskId, space, startedAt, i % 11 === 0 ? null : minutes, paused);
      const row = await db.data.repos.focusSessions.getById(id);
      if (row) records.push(row);
    }
    for (const f of [ALL_ITEMS, filter(SPACE_PRO_ID), filter(SPACE_PERSO_ID), filter(SPACE_PRO_ID, mission), filter('all', mission)]) {
      for (const span of [daySpan(d('2026-10-03')), monthSpan(d('2026-10-04')), { from: local(2026, 10, 2, 0, 0), to: local(2026, 10, 5, 12, 0) }]) {
        const sql = await db.data.repos.focusSessions.totals({ span, filter: f });
        expect(sql, JSON.stringify([f, span])).toEqual(focusTotals(records, tasks, f, span));
        const top = await db.data.repos.focusSessions.totalsByTask({ span, filter: f }, 10);
        expect(top.map((e) => [e.taskId, e.seconds, e.sessions])).toEqual(focusTotalsByTask(records, tasks, f, span, 10).map((e) => [e.taskId, e.seconds, e.sessions]));
      }
    }
  });
});
