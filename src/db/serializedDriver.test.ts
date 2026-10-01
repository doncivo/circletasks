import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError, classifySqliteMessage, toDbError, type SqlDriver, type SqlExecutor } from './driver';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import { DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS } from './serializedDriver';

describe('driver SQLite (contrat SqlDriver)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openSqliteWasmDriver();
    await db.execute('CREATE TABLE item (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, n INTEGER)');
  });

  afterEach(async () => {
    await db.close().catch(() => undefined);
  });

  it('exécute et lit avec paramètres positionnels', async () => {
    expect(db.kind).toBe('sqlite-wasm');
    const res = await db.execute('INSERT INTO item (id, label, n) VALUES (?, ?, ?)', ['a', 'Café', 3]);
    expect(res.rowsAffected).toBe(1);
    const rows = await db.select<{ id: string; label: string; n: number }>('SELECT id, label, n FROM item');
    expect(rows).toEqual([{ id: 'a', label: 'Café', n: 3 }]);
  });

  it('valide une transaction réussie', async () => {
    const count = await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['a', 'A']);
      await tx.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['b', 'B']);
      const rows = await tx.select<{ c: number }>('SELECT count(*) AS c FROM item');
      return rows[0]?.c;
    });
    expect(count).toBe(2);
  });

  it('annule une transaction en échec et normalise l’erreur', async () => {
    const attempt = db.transaction(async (tx) => {
      await tx.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['a', 'A']);
      await tx.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['b', 'A']);
    });
    await expect(attempt).rejects.toMatchObject({ name: 'DbError', code: 'constraint' });
    expect(await db.select('SELECT * FROM item')).toEqual([]);
  });

  it('sérialise les appels concurrents autour d’une transaction', async () => {
    const tx = db.transaction(async (t) => {
      await t.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['a', 'A']);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await t.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['b', 'B']);
    });
    const concurrent = db.select<{ c: number }>('SELECT count(*) AS c FROM item');
    await tx;
    expect((await concurrent)[0]?.c).toBe(2);
  });

  it('fait attendre une lecture concurrente émise pendant la transaction, sans erreur', async () => {
    let releaseTx: () => void = () => undefined;
    let txStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (txStarted = resolve));
    const tx = db.transaction(async (t) => {
      await t.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['a', 'A']);
      await new Promise<void>((resolve) => {
        releaseTx = resolve;
        txStarted();
      });
    });
    await started;
    // Lecture « UI » émise pendant que la transaction est ouverte : mise en file.
    const read = db.select<{ c: number }>('SELECT count(*) AS c FROM item');
    releaseTx();
    await tx;
    expect((await read)[0]?.c).toBe(1);
  });

  it('rejette après le délai un appel réentrant depuis la transaction et annule celle-ci', async () => {
    const short = await openSqliteWasmDriver({ transactionWaitTimeoutMs: 30 });
    await short.execute('CREATE TABLE item (id TEXT PRIMARY KEY, label TEXT NOT NULL)');
    const attempt = short.transaction(async (tx) => {
      await tx.execute('INSERT INTO item (id, label) VALUES (?, ?)', ['a', 'A']);
      await short.select('SELECT 1'); // erreur de programmation : devrait passer par tx
    });
    await expect(attempt).rejects.toMatchObject({ name: 'DbError', code: 'transaction-wait-timeout' });
    await expect(attempt).rejects.toThrow(/réentrant/);
    // ROLLBACK effectué, file débloquée, l'appel abandonné n'est pas rejoué.
    expect(await short.select('SELECT * FROM item')).toEqual([]);
    await short.close();
  });

  it('rejette après le délai une transaction imbriquée', async () => {
    const short = await openSqliteWasmDriver({ transactionWaitTimeoutMs: 30 });
    const attempt = short.transaction(async () => short.transaction(async () => 1));
    await expect(attempt).rejects.toMatchObject({ code: 'transaction-wait-timeout' });
    await expect(short.select<{ v: number }>('SELECT 1 AS v')).resolves.toEqual([{ v: 1 }]);
    await short.close();
  });

  it('attend 10 s par défaut', () => {
    expect(DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS).toBe(10_000);
  });

  it('interdit d’utiliser une transaction terminée', async () => {
    let leaked: SqlExecutor | undefined;
    await db.transaction(async (tx) => {
      leaked = tx;
    });
    if (!leaked) throw new Error('transaction non exécutée');
    await expect(leaked.select('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
    await expect(leaked.execute('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
  });

  it('refuse les appels après fermeture', async () => {
    await db.close();
    await expect(db.select('SELECT 1')).rejects.toMatchObject({ code: 'closed' });
  });

  it('classe les messages SQLite', () => {
    expect(classifySqliteMessage('UNIQUE constraint failed: item.label')).toBe('constraint');
    expect(classifySqliteMessage('database is locked')).toBe('busy');
    expect(classifySqliteMessage('near "x": syntax error')).toBe('syntax');
    expect(classifySqliteMessage('disk I/O error')).toBe('unknown');
    const original = new DbError('busy', 'occupé');
    expect(toDbError(original)).toBe(original);
    expect(toDbError('texte brut', 'SELECT 1')).toMatchObject({ code: 'unknown', sql: 'SELECT 1' });
  });
});
