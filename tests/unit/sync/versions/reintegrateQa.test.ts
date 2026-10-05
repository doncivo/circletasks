import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../../../src/db/driver';
import { migrations } from '../../../../src/db/migrations';
import { migrate } from '../../../../src/db/migrator';
import { reintegrateUnknownFields } from '../../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../../src/db/repositories/sql/testSetup';
import type { DeviceId, Hlc, IsoDateTime, SpaceId, TaskId } from '../../../../src/domain/types';
import { extendedCatalogue, NEXT_MIGRATION, TEST_COLUMN } from '../../../sim/syncVersions';

/**
 * QA Y-07, critère 6 : la règle « même écriture » de la réintégration mise à l'épreuve (valeur locale plus récente écrasée ? valeur
 * périmée réintégrée ?), réintégration interrompue puis rejouée. Le déclencheur de capture de `x` est ici celui que génère
 * `captureTriggers` (migration 0015) pour une colonne publiée : il écrit l'horloge propre du champ au hlc de la ligne.
 */

const SELF = '60000000-0000-4000-8000-0000000000e1' as DeviceId;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const T1 = '11111111-1111-4111-8111-111111111111' as TaskId;
const NOW = '2026-10-05T09:00:00.000Z' as IsoDateTime;
const h = (ms: number, dev = A): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const catalogue = extendedCatalogue();

let db: TestDb;
const run = (driver: SqlDriver = db.driver, pageSize?: number) => reintegrateUnknownFields(driver, { now: NOW, catalogue, ...(pageSize === undefined ? {} : { pageSize }) });

/** Déclencheur de capture complet de la colonne `x` : horloge propre du champ au hlc de la ligne, comme `captureTriggers`. */
async function useRealCaptureTrigger(): Promise<void> {
  await db.driver.execute('DROP TRIGGER test_capture_task_x');
  await db.driver.execute(`CREATE TRIGGER real_capture_task_x AFTER UPDATE OF ${TEST_COLUMN} ON task
    WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND OLD.${TEST_COLUMN} IS NOT NEW.${TEST_COLUMN}
    BEGIN
      INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
        VALUES ('task', NEW.id, '${TEST_COLUMN}', NEW.hlc, COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '${TEST_COLUMN}'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc))
        ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
      DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = '${TEST_COLUMN}';
      INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('task', NEW.id, '${TEST_COLUMN}');
    END`);
}

async function keep(rowId: string, value: unknown, hlc: Hlc, base: Hlc | null = null, field = TEST_COLUMN): Promise<void> {
  await db.driver.execute('INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES (?, ?, ?, ?, ?, ?, ?)', ['task', rowId, field, JSON.stringify(value), hlc, base, 19]);
}

/** Tâche telle qu'une application distante de A la crée : hlc de ligne = `hlc`, repli « * » à ce hlc (apply.ts, insertion). */
async function taskFromA(id: TaskId, hlc: Hlc): Promise<void> {
  await db.driver.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
  await db.driver.execute(
    `INSERT INTO task (id, space_id, project_id, title, note, date, status, sort_order, carried_over, source, created_at, updated_at, device_id, hlc)
     VALUES (?, ?, NULL, 'De A', '', '2026-10-05', 'todo', 1, 0, 'local', ?, ?, ?, ?)`,
    [id, PRO, '2026-10-05T08:00:00.000Z', '2026-10-05T08:00:00.000Z', A, hlc],
  );
  await db.driver.execute("INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES ('task', ?, '*', ?, NULL)", [id, hlc]);
  await db.driver.execute('DELETE FROM sync_guard');
}

const xOf = async (id: string) => (await db.driver.select<{ x: string | null }>(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [id]))[0]?.x;
const dump = async () => ({
  task: await db.driver.select('SELECT * FROM task ORDER BY id'),
  clocks: await db.driver.select('SELECT * FROM sync_field_clock ORDER BY table_name, row_id, field'),
  unknown: await db.driver.select('SELECT * FROM sync_unknown ORDER BY table_name, row_id, field'),
  outbox: await db.driver.select('SELECT * FROM sync_outbox ORDER BY table_name, row_id, field'),
  conflicts: await db.driver.select('SELECT table_name, row_id, field, kept_value, discarded_value FROM conflict_log ORDER BY id'),
  guard: await db.driver.select('SELECT * FROM sync_guard'),
});

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
  await migrate(db.driver, [...migrations, NEXT_MIGRATION]);
  await useRealCaptureTrigger();
});
afterEach(() => db.close());

describe('règle « même écriture » (Y-07 critère 6, QA)', () => {
  it('la valeur de A au hlc de la ligne complète la ligne reçue de A, même après une modification locale d’un autre champ', async () => {
    await taskFromA(T1, h(1_000));
    await keep(T1, 'de A', h(1_000));
    // B modifie le titre : le hlc de la ligne avance, le repli « * » reste à celui de A (déclencheur de 0015).
    await db.driver.execute("UPDATE task SET title = 'Titre de B', hlc = ? WHERE id = ?", [h(5_000, SELF), T1]);
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    expect(await xOf(T1)).toBe('de A');
    expect((await db.driver.select<{ title: string; hlc: string }>('SELECT title, hlc FROM task WHERE id = ?', [T1]))[0]).toEqual({ title: 'Titre de B', hlc: h(5_000, SELF) });
  });

  it('une valeur locale de x plus récente (horloge propre du champ) n’est jamais écrasée, même si la valeur gardée égale le repli de la ligne', async () => {
    await taskFromA(T1, h(1_000));
    await keep(T1, 'de A', h(1_000));
    await db.driver.execute("UPDATE task SET x = 'locale', hlc = ? WHERE id = ?", [h(5_000, SELF), T1]);
    expect(await db.driver.select("SELECT hlc, base_hlc FROM sync_field_clock WHERE row_id = ? AND field = 'x'", [T1])).toEqual([{ hlc: h(5_000, SELF), base_hlc: h(1_000) }]);
    expect(await run()).toEqual({ reintegrated: 0, superseded: 1, remaining: 0 });
    expect(await xOf(T1)).toBe('locale');
    // L'écriture locale reste à publier ; la valeur de A (au hlc de base de l'écriture locale) ne fait pas de conflit.
    expect(await db.driver.select('SELECT field FROM sync_outbox WHERE field = ?', [TEST_COLUMN])).toEqual([{ field: TEST_COLUMN }]);
    expect(await db.driver.select('SELECT * FROM conflict_log')).toEqual([]);
  });

  it('valeur par défaut posée par la migration (sans horloge) : la valeur de A l’emporte, une seule fois ; rejeu sans effet', async () => {
    await taskFromA(T1, h(1_000));
    await db.driver.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
    await db.driver.execute("UPDATE task SET x = 'défaut' WHERE id = ?", [T1]);
    await db.driver.execute('DELETE FROM sync_guard');
    await keep(T1, 'de A', h(1_000));
    await run();
    expect(await xOf(T1)).toBe('de A');
    const after = await dump();
    await run();
    expect(await dump()).toEqual(after);
  });

  it('valeur gardée plus ancienne que le repli de la ligne (aucune horloge propre) : jamais réintégrée ; la règle ordinaire décide', async () => {
    await taskFromA(T1, h(5_000));
    await keep(T1, 'périmée', h(1_000));
    expect(await run()).toEqual({ reintegrated: 0, superseded: 1, remaining: 0 });
    expect(await xOf(T1)).toBeNull();
  });

  it('valeur gardée entre le repli et le hlc courant de la ligne : écrite (le champ n’a jamais eu d’écriture locale), le hlc de la ligne ne recule pas', async () => {
    await taskFromA(T1, h(1_000));
    await db.driver.execute("UPDATE task SET title = 'Titre de B', hlc = ? WHERE id = ?", [h(9_000, SELF), T1]);
    await keep(T1, 'de C', h(4_000));
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    expect(await xOf(T1)).toBe('de C');
    expect((await db.driver.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [T1]))[0]?.hlc).toBe(h(9_000, SELF));
    expect(await db.driver.select("SELECT hlc FROM sync_field_clock WHERE row_id = ? AND field = 'x'", [T1])).toEqual([{ hlc: h(4_000) }]);
  });

  it('deux champs d’une même écriture, un seul devenu connu : l’autre reste et ne bloque pas le premier', async () => {
    await taskFromA(T1, h(1_000));
    await keep(T1, 'de A', h(1_000));
    await keep(T1, 'futur', h(1_000), null, 'y');
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 1 });
    expect(await xOf(T1)).toBe('de A');
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 1 });
  });
});

describe('réintégration interrompue puis rejouée (Y-07 critère 6, QA)', () => {
  it('échec au retrait de sync_unknown (après l’écriture de x) : tout est annulé, état identique à l’avant ; le rejeu réussit une seule fois', async () => {
    await taskFromA(T1, h(1_000));
    await keep(T1, 'de A', h(1_000));
    const before = await dump();
    const failing: SqlDriver = {
      ...db.driver,
      transaction: (fn) =>
        db.driver.transaction((tx) =>
          fn({
            select: (sql, params) => tx.select(sql, params),
            execute: (sql, params) => (sql.startsWith('DELETE FROM sync_unknown') ? Promise.reject(new Error('interruption')) : tx.execute(sql, params)),
          }),
        ),
    };
    await expect(run(failing)).rejects.toThrow('interruption');
    expect(await dump()).toEqual(before);
    expect(await run()).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    const done = await dump();
    expect(await run()).toEqual({ reintegrated: 0, superseded: 0, remaining: 0 });
    expect(await dump()).toEqual(done);
    expect(done.guard).toEqual([]);
    expect(done.outbox).toEqual([]);
  });

  it('interruption à la deuxième page : la première reste réintégrée, la suite intacte, garde vide ; le rejeu termine sans doubler la première', async () => {
    const ids = ['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003'] as [TaskId, TaskId, TaskId];
    for (const [i, id] of ids.entries()) {
      await taskFromA(id, h(1_000 + i));
      await keep(id, `v${String(i)}`, h(1_000 + i));
    }
    let updates = 0;
    const failing: SqlDriver = {
      ...db.driver,
      transaction: (fn) =>
        db.driver.transaction((tx) =>
          fn({
            select: (sql, params) => tx.select(sql, params),
            execute: (sql, params) => {
              if (sql.startsWith('UPDATE task')) {
                updates += 1;
                if (updates === 2) return Promise.reject(new Error('coupure'));
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    await expect(run(failing, 1)).rejects.toThrow('coupure');
    expect(await xOf(ids[0])).toBe('v0');
    expect(await xOf(ids[1])).toBeNull();
    expect(await db.driver.select('SELECT row_id FROM sync_unknown ORDER BY row_id')).toEqual([{ row_id: ids[1] }, { row_id: ids[2] }]);
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
    expect(await db.driver.select('SELECT * FROM sync_outbox WHERE field = ?', [TEST_COLUMN])).toEqual([]);
    expect(await run(db.driver, 1)).toEqual({ reintegrated: 2, superseded: 0, remaining: 0 });
    expect(await Promise.all(ids.map(xOf))).toEqual(['v0', 'v1', 'v2']);
  });

  it('reprise après un état à moitié écrit (x posé avec son horloge, valeur encore gardée) : le rejeu retire la valeur sans rien changer ni publier', async () => {
    await taskFromA(T1, h(1_000));
    await db.driver.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
    await db.driver.execute("UPDATE task SET x = 'de A' WHERE id = ?", [T1]);
    await db.driver.execute("INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES ('task', ?, 'x', ?, NULL)", [T1, h(1_000)]);
    await db.driver.execute('DELETE FROM sync_guard');
    await keep(T1, 'de A', h(1_000));
    const before = await dump();
    expect(await run()).toEqual({ reintegrated: 0, superseded: 1, remaining: 0 });
    const after = await dump();
    expect({ ...after, unknown: [] }).toEqual({ ...before, unknown: [] });
    expect(after.unknown).toEqual([]);
  });
});
