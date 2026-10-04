import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../../domain/itemFilter';
import { asEntityId, type DeviceId, type IsoDateTime, type LocalDate, type ProjectId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import type { ExportCursor } from '../statsRepository';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000a02');
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000c1');
const d = (value: string) => value as LocalDate;

describe('Lecture par blocs pour l’export (SQL, H-03)', () => {
  let db: TestDb;
  let counter = 0;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    counter = 0;
    await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Mission client', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [MISSION, SPACE_PRO_ID]);
  });
  afterEach(() => db.close());

  async function task(title: string, date: string | null, extra: { space?: string; project?: string | null; deleted?: boolean; note?: string } = {}): Promise<string> {
    counter += 1;
    const id = `20000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    await db.driver.execute(
      `INSERT INTO task (id, space_id, project_id, title, note, date, status, sort_order, someday, created_at, updated_at, deleted_at, device_id, hlc)
       VALUES (?, ?, ?, ?, ?, ?, 'todo', 1, ?, 'z', 'z', ?, 'd', 'h')`,
      [id, extra.space ?? SPACE_PRO_ID, extra.project ?? null, title, extra.note ?? '', date, date === null ? 1 : 0, extra.deleted ? 'z' : null],
    );
    return id;
  }

  async function allPages(limit: number, query: { filter?: typeof ALL_ITEMS; range?: { from: LocalDate; to: LocalDate } | null } = {}) {
    const titles: string[] = [];
    let after: ExportCursor | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof db.data.repos.stats.listTasksForExport>> = await db.data.repos.stats.listTasksForExport({ filter: query.filter ?? ALL_ITEMS, range: query.range ?? null, after, limit });
      titles.push(...page.tasks.map((item) => item.title));
      after = page.next;
      pages += 1;
    } while (after !== null);
    return { titles, pages };
  }

  it('lit toutes les tâches par pages, triées par date (sans date à la fin), sans doublon ni oubli', async () => {
    await task('c', '2026-09-03');
    await task('a', '2026-09-01');
    await task('sans date', null);
    await task('b', '2026-09-01');
    await task('supprimée', '2026-09-02', { deleted: true });
    const { titles, pages } = await allPages(2);
    expect(titles).toEqual(['a', 'b', 'c', 'sans date']);
    expect(pages).toBe(2);
    expect((await allPages(100)).pages).toBe(1);
  });

  it('5 000 tâches lues par blocs de 500 : toutes, une seule fois', async () => {
    await db.driver.transaction(async (tx) => {
      for (let i = 0; i < 5000; i += 1) {
        await tx.execute(
          "INSERT INTO task (id, space_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, 'todo', 1, 'z', 'z', 'd', 'h')",
          [`21000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SPACE_PRO_ID, `T${String(i)}`, new Date(Date.UTC(2023, 9, 4) + (i % 1000) * 86_400_000).toISOString().slice(0, 10)],
        );
      }
    });
    const { titles, pages } = await allPages(500);
    expect(titles).toHaveLength(5000);
    expect(new Set(titles).size).toBe(5000);
    expect(pages).toBe(10);
  });

  it('filtre d’espace et de projet (ES-08), période d’un mois', async () => {
    await task('pro', '2026-09-10');
    await task('mission', '2026-09-11', { project: MISSION });
    await task('perso', '2026-09-12', { space: SPACE_PERSO_ID });
    await task('octobre', '2026-10-01');
    expect((await allPages(10, { filter: { space: SPACE_PRO_ID, project: null } })).titles).toEqual(['pro', 'mission', 'octobre']);
    expect((await allPages(10, { filter: { space: SPACE_PRO_ID, project: MISSION } })).titles).toEqual(['mission']);
    expect((await allPages(10, { filter: { space: SPACE_PERSO_ID, project: null } })).titles).toEqual(['perso']);
    expect((await allPages(10, { range: { from: d('2026-09-01'), to: d('2026-09-30') } })).titles).toEqual(['pro', 'mission', 'perso']);
  });

  it('noms d’espace, de projet, d’objectif et règle de répétition', async () => {
    await db.driver.execute("INSERT INTO recurrence (id, freq, interval, weekdays, created_at, updated_at, device_id, hlc) VALUES ('50000000-0000-4000-8000-000000000001', 'weekly', 2, '[1,3]', 'z', 'z', 'd', 'h')");
    await db.driver.execute("INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES ('51000000-0000-4000-8000-000000000001', ?, '2026-09-07', 'Finir le dossier', 'open', 'z', 'z', 'd', 'h')", [SPACE_PRO_ID]);
    const id = await task('liée', '2026-09-10', { project: MISSION, note: 'ligne 1\nligne 2' });
    await db.driver.execute("UPDATE task SET recurrence_id = '50000000-0000-4000-8000-000000000001', goal_id = '51000000-0000-4000-8000-000000000001' WHERE id = ?", [id]);
    const page = await db.data.repos.stats.listTasksForExport({ filter: ALL_ITEMS, range: null, after: null, limit: 10 });
    expect(page.tasks[0]).toMatchObject({
      title: 'liée',
      note: 'ligne 1\nligne 2',
      spaceName: 'Pro',
      projectName: 'Mission client',
      goalTitle: 'Finir le dossier',
      recurrence: { freq: 'weekly', interval: 2, weekdays: [1, 3] },
    });
  });

  it('sessions Focus : lecture par blocs, filtre d’espace et de projet, période', async () => {
    const add = async (n: number, space: string, project: string | null, startedAt: string) =>
      db.driver.execute(
        "INSERT INTO focus_session (id, task_id, space_id, project_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES (?, NULL, ?, ?, 25, ?, ?, 0, 'z', 'z', 'd', 'h')",
        [`40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, space, project, startedAt, startedAt],
      );
    await add(1, SPACE_PRO_ID, MISSION, '2026-09-10T08:00:00.000Z');
    await add(2, SPACE_PRO_ID, null, '2026-09-11T08:00:00.000Z');
    await add(3, SPACE_PERSO_ID, null, '2026-10-02T08:00:00.000Z');
    const repo = db.data.repos.focusSessions;
    const first = await repo.listForExport({ filter: ALL_ITEMS, span: null, afterId: null, limit: 2 });
    expect(first.map((session) => String(session.id).slice(-1))).toEqual(['1', '2']);
    const second = await repo.listForExport({ filter: ALL_ITEMS, span: null, afterId: first[1]?.id ?? null, limit: 2 });
    expect(second.map((session) => String(session.id).slice(-1))).toEqual(['3']);
    expect((await repo.listForExport({ filter: { space: SPACE_PRO_ID, project: MISSION }, span: null, afterId: null, limit: 10 })).map((s) => String(s.id).slice(-1))).toEqual(['1']);
    expect((await repo.listForExport({ filter: ALL_ITEMS, span: { from: '2026-09-01T00:00:00.000Z' as IsoDateTime, to: '2026-10-01T00:00:00.000Z' as IsoDateTime }, afterId: null, limit: 10 })).length).toBe(2);
  });
});
