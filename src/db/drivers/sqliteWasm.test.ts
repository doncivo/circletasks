import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver, preparedStatementCount } from './sqliteWasm';

/**
 * Y-TECH-05 (critère 11, durée) : SQLite recompile à chaque préparation les programmes de tous les déclencheurs de la table écrite ;
 * le pilote garde donc les instructions préparées par texte SQL. Preuve par comptage (aucun chronomètre).
 */
let driver: SqlDriver | null = null;
afterEach(async () => {
  await driver?.close();
  driver = null;
});

async function open(): Promise<SqlDriver> {
  driver = await openSqliteWasmDriver();
  await driver.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await driver.execute('CREATE TABLE log (n INTEGER)');
  await driver.execute('CREATE TRIGGER t_au AFTER UPDATE ON t BEGIN INSERT INTO log (n) VALUES (NEW.id); END');
  return driver;
}

describe('pilote SQLite Wasm : instructions préparées', () => {
  it('un même texte SQL répété 500 fois n’est préparé qu’une fois (déclencheurs non recompilés)', async () => {
    const db = await open();
    const before = preparedStatementCount(db);
    for (let i = 0; i < 500; i += 1) await db.execute('INSERT INTO t (id, v) VALUES (?, ?)', [i, 'a']);
    for (let i = 0; i < 500; i += 1) await db.execute('UPDATE t SET v = ? WHERE id = ?', ['b', i]);
    for (let i = 0; i < 500; i += 1) await db.select('SELECT v FROM t WHERE id = ?', [i]);
    expect(preparedStatementCount(db) - before).toBe(3);
  });

  it('résultats identiques à l’exécution directe : lignes, rowsAffected, lastInsertId, liaisons non conservées d’un appel à l’autre', async () => {
    const db = await open();
    expect(await db.execute('INSERT INTO t (v) VALUES (?)', ['x'])).toMatchObject({ rowsAffected: 1, lastInsertId: 1 });
    expect(await db.execute('INSERT INTO t (v) VALUES (?)', ['y'])).toMatchObject({ rowsAffected: 1, lastInsertId: 2 });
    expect(await db.execute('UPDATE t SET v = ? WHERE id <= ?', ['z', 2])).toMatchObject({ rowsAffected: 2 });
    expect(await db.select('SELECT id, v FROM t WHERE v = ? ORDER BY id', ['z'])).toEqual([{ id: 1, v: 'z' }, { id: 2, v: 'z' }]);
    expect(await db.select('SELECT id, v FROM t WHERE v = ? ORDER BY id', ['absent'])).toEqual([]);
    expect(await db.select('SELECT id FROM t WHERE id = ?', [2])).toEqual([{ id: 2 }]);
    expect(await db.select('SELECT n FROM log ORDER BY n')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('une instruction en échec est remise à zéro : le même texte réussit ensuite ; un changement de schéma est pris en compte', async () => {
    const db = await open();
    await db.execute('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    await expect(db.execute('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'dup'])).rejects.toThrow();
    expect(await db.execute('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'b'])).toMatchObject({ rowsAffected: 1 });
    expect(await db.select('SELECT * FROM t ORDER BY id')).toHaveLength(2);
    await db.execute('ALTER TABLE t ADD COLUMN w TEXT');
    expect(await db.select('SELECT * FROM t WHERE id = ?', [1])).toEqual([{ id: 1, v: 'a', w: null }]);
    await db.execute('DROP TABLE log');
    await expect(db.execute('UPDATE t SET v = ? WHERE id = ?', ['c', 1])).rejects.toThrow();
  });

  it('plusieurs instructions dans un même texte : exécutées toutes, jamais gardées', async () => {
    const db = await open();
    const before = preparedStatementCount(db);
    await db.execute("INSERT INTO t (id, v) VALUES (1, 'a'); INSERT INTO t (id, v) VALUES (2, 'b')");
    expect(await db.select('SELECT id FROM t ORDER BY id')).toHaveLength(2);
    expect(preparedStatementCount(db) - before).toBe(1);
  });
});
