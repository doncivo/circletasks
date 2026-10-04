import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId, uuidGenerator } from '../../domain/id';
import { ALL_ITEMS } from '../../domain/itemFilter';
import { asEntityId, type DeviceId, type GoalId, type IsoDateTime, type LocalDate, type ProjectId, type RoutineId, type RoutineLogId, type RoutinePauseId } from '../../domain/types';
import { buildHistoryCsv, buildHistoryJson, type HistoryExportParams } from './exportHistory';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000a03');
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

describe('Export de l’historique : CSV et JSON (H-03 critères 2 à 4)', () => {
  let db: TestDb;
  let params: HistoryExportParams;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    params = { filter: ALL_ITEMS, period: 'all', month: { year: 2026, month: 9 }, exportedAt: '2026-10-04T10:00:00.000Z' as IsoDateTime, spaceName: null, projectName: null };
    const insert = (id: string, space: string, title: string, date: string | null, status: string, note = '') =>
      db.driver.execute(
        "INSERT INTO task (id, space_id, title, note, date, time, status, done_at, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, '09:30', ?, ?, 1, 'z', 'z', 'd', 'h')",
        [id, space, title, note, date, status, status === 'done' ? '2026-09-20T12:00:00.000Z' : null],
      );
    await insert('20000000-0000-4000-8000-000000000001', SPACE_PRO_ID, 'Réunion « équipe »', '2026-09-10', 'done', 'ligne 1\nligne "2"; fin');
    await insert('20000000-0000-4000-8000-000000000002', SPACE_PERSO_ID, 'Courses', '2026-10-02', 'todo');
    await insert('20000000-0000-4000-8000-000000000003', SPACE_PRO_ID, '=Formule', null, 'todo');
  });
  afterEach(() => db.close());

  it('CSV : octets EF BB BF, en-têtes, accents, guillemets doublés, retours à la ligne des notes conservés', async () => {
    const bytes = await buildHistoryCsv(db.data, params);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = decode(bytes);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('titre;date;heure;espace;projet;note;statut;termine_le;objectif;repetition');
    expect(lines[1]).toBe('Réunion « équipe »;2026-09-10;09:30;Pro;;"ligne 1\nligne ""2""; fin";fait;2026-09-20;;');
    expect(lines[2]).toBe('Courses;2026-10-02;09:30;Perso;;;à faire;;;');
    expect(lines[3]).toBe("'=Formule;;09:30;Pro;;;à faire;;;");
  });

  it('CSV : filtre Pro et période « mois affiché »', async () => {
    const pro = decode(await buildHistoryCsv(db.data, { ...params, filter: { space: SPACE_PRO_ID, project: null } }));
    expect(pro).toContain('Réunion');
    expect(pro).not.toContain('Courses');
    const month = decode(await buildHistoryCsv(db.data, { ...params, period: 'month' }));
    expect(month).toContain('Réunion');
    expect(month).not.toContain('Courses');
    expect(month).not.toContain('Formule');
  });

  it('JSON : schema_version, exported_at, filter, tasks, routines avec validations et pauses, focus_sessions, goals', async () => {
    const routine = await db.data.repos.routines.create({
      id: newEntityId<RoutineId>(uuidGenerator),
      spaceId: SPACE_PRO_ID,
      title: 'Sport',
      icon: null,
      scheduleType: 'daily',
      weekdays: [],
      timesPerWeek: null,
      interval: null,
      startDate: '2026-09-01' as LocalDate,
      time: null,
      paused: false,
      archived: false,
    });
    await db.data.repos.routineLogs.markDone(routine.id, '2026-09-02' as LocalDate, '2026-09-02T08:00:00.000Z' as IsoDateTime, newEntityId<RoutineLogId>(uuidGenerator));
    await db.data.repos.routines.createPause({ id: newEntityId<RoutinePauseId>(uuidGenerator), routineId: routine.id, fromDate: '2026-09-05' as LocalDate });
    await db.data.repos.goals.create({ id: newEntityId<GoalId>(uuidGenerator), spaceId: SPACE_PRO_ID, weekStart: '2026-09-07' as LocalDate, title: 'Finir', icon: null, pinned: false, status: 'open', carriedFromId: null });
    await db.driver.execute(
      "INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES ('40000000-0000-4000-8000-000000000001', NULL, ?, 25, '2026-09-10T08:00:00.000Z', '2026-09-10T08:25:00.000Z', 0, 'z', 'z', 'd', 'h')",
      [SPACE_PRO_ID],
    );
    const json = JSON.parse(decode(await buildHistoryJson(db.data, params))) as Record<string, unknown[] | unknown>;
    expect(Object.keys(json)).toEqual(['schema_version', 'exported_at', 'filter', 'tasks', 'routines', 'focus_sessions', 'goals']);
    expect(json['exported_at']).toBe('2026-10-04T10:00:00.000Z');
    expect((json['tasks'] as unknown[]).length).toBe(3);
    const routines = json['routines'] as { title: string; logs: unknown[]; pauses: unknown[] }[];
    expect(routines[0]).toMatchObject({ title: 'Sport' });
    expect(routines[0]?.logs).toHaveLength(1);
    expect(routines[0]?.pauses).toHaveLength(1);
    expect(json['focus_sessions']).toHaveLength(1);
    expect(json['goals']).toHaveLength(1);
  });

  it('JSON : sous Perso, seuls les éléments Perso ; sous un projet, ni routines ni objectifs', async () => {
    await db.data.repos.routines.create({ id: newEntityId<RoutineId>(uuidGenerator), spaceId: SPACE_PRO_ID, title: 'Sport Pro', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-09-01' as LocalDate, time: null, paused: false, archived: false });
    const perso = JSON.parse(decode(await buildHistoryJson(db.data, { ...params, filter: { space: SPACE_PERSO_ID, project: null }, spaceName: 'Perso' }))) as { tasks: { title: string }[]; routines: unknown[]; filter: { space: string } };
    expect(perso.tasks.map((task) => task.title)).toEqual(['Courses']);
    expect(perso.routines).toEqual([]);
    expect(perso.filter.space).toBe('Perso');
    const project = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000d1');
    const inProject = JSON.parse(decode(await buildHistoryJson(db.data, { ...params, filter: { space: SPACE_PRO_ID, project } }))) as { routines: unknown[]; goals: unknown[] };
    expect(inProject.routines).toEqual([]);
    expect(inProject.goals).toEqual([]);
  });
});
