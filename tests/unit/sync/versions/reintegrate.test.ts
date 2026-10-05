import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlExecutor, SqlParams } from '../../../../src/db/driver';
import { migrations } from '../../../../src/db/migrations';
import { migrate } from '../../../../src/db/migrator';
import { reintegrateUnknownFields, type UnknownCatalogue } from '../../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../../src/db/repositories/sql/testSetup';
import { settingKeyScope, syncColumn, syncTable } from '../../../../src/domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, SpaceId, TaskId } from '../../../../src/domain/types';
import { extendedCatalogue, NEXT_MIGRATION, TEST_COLUMN } from '../../../sim/syncVersions';

/**
 * Réintégration des champs inconnus devenus connus (Y-07 critère 6 ; ADR 0011 §3.2, §7.2 ; D3), sur une base peuplée : règle de hlc
 * ordinaire, garde, aucune entrée dans `sync_outbox`, identifiants du seul catalogue, rejouable, ligne pas encore arrivée.
 */

const SELF = '60000000-0000-4000-8000-0000000000e1' as DeviceId;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const T1 = '11111111-1111-4111-8111-111111111111' as TaskId;
const T2 = '22222222-2222-4222-8222-222222222222' as TaskId;
const NOW = '2026-10-05T09:00:00.000Z' as IsoDateTime;
const h = (ms: number, dev = A): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${dev}` as Hlc;

let db: TestDb;
const catalogue = extendedCatalogue();
const run = (driver: SqlDriver = db.driver, cat: UnknownCatalogue = catalogue) => reintegrateUnknownFields(driver, { now: NOW, catalogue: cat });

async function keep(table: string, rowId: string, field: string, value: unknown, hlc: Hlc, base: Hlc | null = null, sv = 19): Promise<void> {
  await db.driver.execute('INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES (?, ?, ?, ?, ?, ?, ?)', [table, rowId, field, JSON.stringify(value), hlc, base, sv]);
}

async function createTask(id: TaskId, title = 'Locale'): Promise<void> {
  await db.data.repos.tasks.create({
    id,
    spaceId: PRO,
    projectId: null,
    title,
    note: '',
    date: '2026-10-05' as LocalDate,
    time: null,
    status: 'todo',
    doneAt: null,
    sortOrder: 1,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local',
    externalId: null,
    externalEventId: null,
  });
}

const unknownRows = () => db.driver.select('SELECT table_name, row_id, field FROM sync_unknown ORDER BY table_name, row_id, field');
const clockOf = async (id: string, field: string) => (await db.driver.select<{ hlc: string; base_hlc: string | null }>("SELECT hlc, base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = ? AND field = ?", [id, field]))[0] ?? null;

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
  await migrate(db.driver, [...migrations, NEXT_MIGRATION]);
});
afterEach(() => db.close());

describe('réintégration (Y-07 critère 6)', () => {
  it('champ devenu connu, valeur reçue plus récente : écrit avec son horloge, retiré de sync_unknown, aucune entrée de file, garde vide', async () => {
    await createTask(T1);
    await db.driver.execute('DELETE FROM sync_outbox');
    const rowHlc = (await db.driver.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [T1]))[0]?.hlc as Hlc;
    const remote = h(3_600_000);
    expect(remote > rowHlc).toBe(true);
    await keep('task', T1, TEST_COLUMN, 'valeur de A', remote, null);
    const report = await run();
    expect(report).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    expect(await db.driver.select(`SELECT ${TEST_COLUMN} AS x, hlc, device_id FROM task WHERE id = ?`, [T1])).toEqual([{ x: 'valeur de A', hlc: remote, device_id: A }]);
    expect(await clockOf(T1, TEST_COLUMN)).toEqual({ hlc: remote, base_hlc: null });
    // Repli « * » figé à l'ancien hlc de la ligne : les autres champs gardent leur horloge.
    expect((await clockOf(T1, '*'))?.hlc).toBe(rowHlc);
    expect(await unknownRows()).toEqual([]);
    expect(await db.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
  });

  it('même écriture (hlc égal au repli de la ligne, colonne absente quand elle est arrivée) : la valeur gardée la complète ; avec une horloge propre égale, rien', async () => {
    await createTask(T1);
    await createTask(T2);
    const hlcOf = async (id: string) => (await db.driver.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [id]))[0]?.hlc as Hlc;
    await keep('task', T1, TEST_COLUMN, 'même écriture', await hlcOf(T1));
    await db.driver.execute("INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES ('task', ?, ?, ?, NULL)", [T2, TEST_COLUMN, await hlcOf(T2)]);
    await keep('task', T2, TEST_COLUMN, 'déjà écrite ici', await hlcOf(T2));
    expect(await run()).toEqual({ reintegrated: 1, superseded: 1, remaining: 0 });
    expect(await db.driver.select(`SELECT id, ${TEST_COLUMN} AS x FROM task ORDER BY id`)).toEqual([
      { id: T1, x: 'même écriture' },
      { id: T2, x: null },
    ]);
  });

  it('migration de test : une écriture locale non gardée de x pose son horloge propre (hlc de la ligne, base = repli) et entre dans la file, comme le générateur de 0015', async () => {
    await createTask(T1);
    await db.driver.execute('DELETE FROM sync_outbox');
    const before = (await db.driver.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [T1]))[0]?.hlc as Hlc;
    await db.driver.execute(`UPDATE task SET ${TEST_COLUMN} = 'locale', hlc = ? WHERE id = ?`, [h(9_000, SELF), T1]);
    expect(await clockOf(T1, TEST_COLUMN)).toEqual({ hlc: h(9_000, SELF), base_hlc: before });
    expect(await db.driver.select('SELECT field FROM sync_outbox WHERE row_id = ? ORDER BY field', [T1])).toEqual([{ field: TEST_COLUMN }]);
    // Sous garde : rien.
    await db.driver.execute('INSERT INTO sync_guard (id) VALUES (1)');
    await db.driver.execute(`UPDATE task SET ${TEST_COLUMN} = 'gardée', hlc = ? WHERE id = ?`, [h(9_500, SELF), T1]);
    await db.driver.execute('DELETE FROM sync_guard');
    expect(await clockOf(T1, TEST_COLUMN)).toEqual({ hlc: h(9_000, SELF), base_hlc: before });
  });

  it('rejouable : un second appel ne change rien', async () => {
    await createTask(T1);
    await keep('task', T1, TEST_COLUMN, 'v', h(3_600_000));
    await run();
    const before = await db.driver.select('SELECT * FROM task');
    const clocks = await db.driver.select('SELECT * FROM sync_field_clock ORDER BY table_name, row_id, field');
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 0 });
    expect(await db.driver.select('SELECT * FROM task')).toEqual(before);
    expect(await db.driver.select('SELECT * FROM sync_field_clock ORDER BY table_name, row_id, field')).toEqual(clocks);
  });

  it('champ local plus récent : gardé ; la valeur reçue est quand même retirée ; conflit inscrit (deux écritures qui ne se sont pas vues)', async () => {
    await createTask(T1);
    await db.driver.execute('DELETE FROM sync_outbox');
    // Écriture locale de x après la mise à jour (déclencheur de la migration de test : entrée de file).
    await db.driver.execute(`UPDATE task SET ${TEST_COLUMN} = 'locale', hlc = ? WHERE id = ?`, [h(7_200_000, SELF), T1]);
    await keep('task', T1, TEST_COLUMN, 'ancienne de A', h(3_600_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 1, remaining: 0 });
    expect(await db.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [T1])).toEqual([{ x: 'locale' }]);
    expect(await unknownRows()).toEqual([]);
    expect(await db.driver.select('SELECT field FROM sync_outbox WHERE row_id = ?', [T1])).toEqual([{ field: TEST_COLUMN }]);
    expect(await db.driver.select('SELECT field, kept_value, discarded_value FROM conflict_log')).toEqual([{ field: TEST_COLUMN, kept_value: '"locale"', discarded_value: '"ancienne de A"' }]);
  });

  it('valeur reçue plus récente qu’une écriture locale en attente : écrite, l’écriture locale ne sera pas publiée', async () => {
    await createTask(T1);
    await db.driver.execute(`UPDATE task SET ${TEST_COLUMN} = 'locale', hlc = ? WHERE id = ?`, [h(1_000, SELF), T1]);
    await keep('task', T1, TEST_COLUMN, 'récente de A', h(3_600_000));
    expect((await run()).reintegrated).toBe(1);
    expect(await db.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [T1])).toEqual([{ x: 'récente de A' }]);
    expect(await db.driver.select('SELECT field FROM sync_outbox WHERE row_id = ? AND field = ?', [T1, TEST_COLUMN])).toEqual([]);
  });

  it('encore inconnu, invalide, colonne locale ou technique, table inconnue : reste ; seul le champ devenu connu part', async () => {
    await createTask(T1);
    await keep('task', T1, 'y', 'encore inconnu', h(10));
    await keep('task', T1, 'discarded', 1, h(10));
    await keep('task', T1, 'hlc', 'z', h(10));
    await keep('task', T1, 'status', 'peut-être', h(10));
    await keep('future_table', T1, 'a', 'b', h(10));
    await keep('task', T1, TEST_COLUMN, 'ok', h(3_600_000));
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 5 });
    expect(await unknownRows()).toEqual([
      { table_name: 'future_table', row_id: T1, field: 'a' },
      { table_name: 'task', row_id: T1, field: 'discarded' },
      { table_name: 'task', row_id: T1, field: 'hlc' },
      { table_name: 'task', row_id: T1, field: 'status' },
      { table_name: 'task', row_id: T1, field: 'y' },
    ]);
    expect(await db.driver.select('SELECT status, discarded FROM task WHERE id = ?', [T1])).toEqual([{ status: 'todo', discarded: 0 }]);
  });

  it('valeur de type refusé par le catalogue (nombre pour un texte) : reste', async () => {
    await createTask(T1);
    await keep('task', T1, TEST_COLUMN, 42, h(3_600_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 1 });
  });

  it('sans le catalogue étendu (app pas encore à jour) : rien ne bouge', async () => {
    await createTask(T1);
    await keep('task', T1, TEST_COLUMN, 'v', h(3_600_000));
    const appCatalogue: UnknownCatalogue = { table: syncTable, column: syncColumn, settingScope: settingKeyScope };
    expect(await run(db.driver, appCatalogue)).toEqual({ reintegrated: 0, superseded: 0, remaining: 1 });
    expect(await db.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [T1])).toEqual([{ x: null }]);
  });

  it('ligne pas encore arrivée : le champ reste ; réintégré au démarrage suivant, une fois la ligne là (D3)', async () => {
    await keep('task', T2, TEST_COLUMN, 'en avance', h(3_600_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 1 });
    await createTask(T2);
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    expect(await db.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [T2])).toEqual([{ x: 'en avance' }]);
  });

  it('ligne purgée ici : une valeur plus ancienne que la purge est retirée, une plus récente attend', async () => {
    await db.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('task', ?, ?, ?)", [T2, h(5_000), NOW]);
    await keep('task', T2, TEST_COLUMN, 'avant la purge', h(4_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 1, remaining: 0 });
    await keep('task', T2, TEST_COLUMN, 'après la purge', h(6_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 1 });
    expect(await db.driver.select('SELECT id FROM task WHERE id = ?', [T2])).toEqual([]);
  });

  it('ligne absente mais complète (table devenue connue) : insérée avec ses horloges si ses parents sont là ; sinon elle attend', async () => {
    const task = syncTable('task');
    const full = { space_id: PRO, project_id: null, title: 'Nouvelle', note: '', date: '2026-10-05', time: null, status: 'todo', done_at: null, sort_order: 1, carried_over: 0, recurrence_id: null, series_index: null, goal_id: null, icon: null, someday: 0, source: 'local', external_id: null, series_template: null, external_event_id: null, created_at: '2026-10-05T08:00:00.000Z', deleted_at: null, [TEST_COLUMN]: 'x' } as Record<string, unknown>;
    expect(task?.columns.every((c) => c.name in full)).toBe(true);
    for (const [field, value] of Object.entries(full)) await keep('task', T2, field, value, field === 'title' ? h(2_000) : h(1_000), field === 'title' ? h(1_000) : null);
    expect((await run()).reintegrated).toBe(Object.keys(full).length);
    expect(await db.driver.select(`SELECT title, ${TEST_COLUMN} AS x, hlc FROM task WHERE id = ?`, [T2])).toEqual([{ title: 'Nouvelle', x: 'x', hlc: h(2_000) }]);
    expect(await clockOf(T2, '*')).toEqual({ hlc: h(2_000), base_hlc: null });
    expect(await clockOf(T2, 'note')).toEqual({ hlc: h(1_000), base_hlc: null });
    expect(await clockOf(T2, 'title')).toEqual({ hlc: h(2_000), base_hlc: h(1_000) });
    expect(await db.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
    // Parent absent : la ligne attend.
    const T3 = '33333333-3333-4333-8333-333333333333';
    for (const [field, value] of Object.entries({ ...full, project_id: '44444444-4444-4444-8444-444444444444' })) await keep('task', T3, field, value, h(1_000));
    expect((await run()).remaining).toBe(Object.keys(full).length);
  });

  it('champ de clé étrangère dont le parent manque ici : il attend, les autres champs de la ligne passent', async () => {
    await createTask(T1);
    await keep('task', T1, 'project_id', '44444444-4444-4444-8444-444444444444', h(3_600_000));
    await keep('task', T1, TEST_COLUMN, 'ok', h(3_600_000));
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 1 });
    expect(await unknownRows()).toEqual([{ table_name: 'task', row_id: T1, field: 'project_id' }]);
  });

  it('clé de réglage devenue partagée : insérée dans settings ; encore inconnue ou locale : reste', async () => {
    await keep('settings', 'future.option', 'value', 'true', h(1_000));
    await keep('settings', 'device.id', 'value', '"x"', h(1_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 2 });
    const settingsCatalogue: UnknownCatalogue = { ...catalogue, settingScope: (key) => (key === 'future.option' ? 'shared' : settingKeyScope(key)) };
    expect(await run(db.driver, settingsCatalogue)).toEqual({ reintegrated: 1, superseded: 0, remaining: 1 });
    expect(await db.driver.select("SELECT value, hlc FROM settings WHERE key = 'future.option'")).toEqual([{ value: 'true', hlc: h(1_000) }]);
    expect(await unknownRows()).toEqual([{ table_name: 'settings', row_id: 'device.id', field: 'value' }]);
    expect(await db.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
  });

  it('aucun nom gardé n’atteint le SQL : un espion sur execute et select ne voit que des noms du catalogue', async () => {
    await createTask(T1);
    await keep('evil_table', T1, 'evil_col', 'v', h(1_000));
    await keep('task', T1, 'evil_col', 'v', h(1_000));
    await keep('task', T1, TEST_COLUMN, 'ok', h(3_600_000));
    const sqls: string[] = [];
    const spyExec = (ex: SqlExecutor): SqlExecutor => ({
      execute: (sql: string, params?: SqlParams) => (sqls.push(sql), ex.execute(sql, params)),
      select: (sql, params) => (sqls.push(sql), ex.select(sql, params)),
    });
    const spy: SqlDriver = { ...db.driver, ...spyExec(db.driver), transaction: (fn) => db.driver.transaction((tx) => fn(spyExec(tx))) };
    expect((await run(spy)).reintegrated).toBe(1);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((sql) => sql.includes('evil'))).toBe(false);
  });

  it('une ligne en échec (contrainte d’une migration future) est isolée : comptée dans remaining, nom de l’erreur seul signalé, les autres lignes et pages passent', async () => {
    const ids = ['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003'] as [TaskId, TaskId, TaskId];
    for (const [i, id] of ids.entries()) {
      await createTask(id);
      await keep('task', id, TEST_COLUMN, i === 1 ? 'interdite' : `v${String(i)}`, h(3_600_000 + i));
    }
    await db.driver.execute(`CREATE TRIGGER test_refuse_x BEFORE UPDATE OF ${TEST_COLUMN} ON task WHEN NEW.${TEST_COLUMN} = 'interdite' BEGIN SELECT RAISE(ABORT, 'interdite'); END`);
    const errors: string[] = [];
    for (const pageSize of [1, 200]) {
      errors.length = 0;
      const report = await reintegrateUnknownFields(db.driver, { now: NOW, catalogue, pageSize, onRowError: (name) => errors.push(name) });
      expect(report.remaining, `page de ${String(pageSize)}`).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).not.toContain('interdite');
    }
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
    expect((await db.driver.select<{ x: string | null }>(`SELECT ${TEST_COLUMN} AS x FROM task ORDER BY id`)).map((r) => r.x)).toEqual(['v0', null, 'v2']);
    expect(await unknownRows()).toEqual([{ table_name: 'task', row_id: ids[1], field: TEST_COLUMN }]);
    // La ligne en échec ne laisse rien d'écrit à moitié (horloge, file).
    expect(await clockOf(ids[1], TEST_COLUMN)).toBeNull();
    expect(await db.driver.select('SELECT * FROM sync_outbox WHERE field = ?', [TEST_COLUMN])).toEqual([]);
    await db.driver.execute('DROP TRIGGER test_refuse_x');
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
  });

  it('parent et enfant tous deux en attente (ordre alphabétique inverse : project avant space) : réintégrés au même démarrage', async () => {
    const SPACE = '99999999-0000-4000-8000-000000000001';
    const PROJECT = '88888888-0000-4000-8000-000000000001';
    const at = '2026-10-05T08:00:00.000Z';
    for (const [field, value] of Object.entries({ name: 'Nouvel espace', color: '#112233', sort_order: 3, quiet_hours: '[]', created_at: at, deleted_at: null })) await keep('space', SPACE, field, value, h(1_000));
    for (const [field, value] of Object.entries({ space_id: SPACE, name: 'Projet', color: '#445566', archived: 0, sort_order: 1, created_at: at, deleted_at: null })) await keep('project', PROJECT, field, value, h(2_000));
    expect((await run(db.driver, { ...catalogue })).remaining).toBe(0);
    expect(await db.driver.select('SELECT id, space_id FROM project WHERE id = ?', [PROJECT])).toEqual([{ id: PROJECT, space_id: SPACE }]);
    expect(await db.driver.select('SELECT name FROM space WHERE id = ?', [SPACE])).toEqual([{ name: 'Nouvel espace' }]);
  });

  it('parent dans la même table (objectif reporté d’un objectif plus loin dans l’ordre) : nouveau passage tant qu’il y a du progrès', async () => {
    const G1 = 'ffffffff-0000-4000-8000-000000000001';
    const G2 = '00000001-0000-4000-8000-000000000002';
    const goal = (carried: string | null) => ({ space_id: PRO, week_start: '2026-10-05', title: 'Objectif', icon: null, pinned: 0, status: 'open', carried_from_id: carried, created_at: '2026-10-05T08:00:00.000Z', deleted_at: null });
    for (const [field, value] of Object.entries(goal(null))) await keep('goal', G1, field, value, h(1_000));
    for (const [field, value] of Object.entries(goal(G1))) await keep('goal', G2, field, value, h(2_000));
    expect(await reintegrateUnknownFields(db.driver, { now: NOW, catalogue, pageSize: 1 })).toMatchObject({ remaining: 0 });
    expect(await db.driver.select('SELECT id, carried_from_id FROM goal WHERE id IN (?, ?) ORDER BY id', [G1, G2])).toEqual([
      { id: G2, carried_from_id: G1 },
      { id: G1, carried_from_id: null },
    ]);
  });

  it('par pages : plus de lignes que la taille de page, toutes traitées', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000` as TaskId;
      ids.push(id);
      await createTask(id);
      await keep('task', id, TEST_COLUMN, `v${String(i)}`, h(3_600_000 + i));
    }
    expect(await reintegrateUnknownFields(db.driver, { now: NOW, catalogue, pageSize: 3 })).toEqual({ reintegrated: 7, superseded: 0, remaining: 0 });
    expect((await db.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task ORDER BY id`)).map((r) => r['x'])).toEqual(ids.map((_, i) => `v${String(i)}`));
  });
});
