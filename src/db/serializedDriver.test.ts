import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError, classifySqliteMessage, toDbError, type SqlDriver, type SqlExecutor } from './driver';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import { DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS, createSerializedDriver } from './serializedDriver';

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

describe('transaction perdue (connexion remplacée en cours de transaction)', () => {
  it('un COMMIT « no transaction is active » est un échec visible `transaction-lost`, jamais un succès', async () => {
    const sent: string[] = [];
    const driver = createSerializedDriver('sqlite-wasm', {
      execute: (sql) => {
        sent.push(sql);
        return sql === 'COMMIT' ? Promise.reject('error returned from database: (code: 1) cannot commit - no transaction is active') : Promise.resolve({ rowsAffected: 0, lastInsertId: null });
      },
      select: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    });
    await expect(driver.transaction(async (tx) => { await tx.execute('UPDATE t SET x = 1'); })).rejects.toMatchObject({ name: 'DbError', code: 'transaction-lost' });
    expect(sent).toEqual(['BEGIN IMMEDIATE', 'UPDATE t SET x = 1', 'COMMIT', 'ROLLBACK']);
  });
});

/**
 * TRI-22 (audit 1.0, « transaction-lost laisse sync_guard ») : quand la connexion est remplacée en cours de transaction, chaque instruction
 * est validée seule. Une garde posée (`INSERT … sync_guard`) puis une erreur, et le ROLLBACK ne trouve plus de transaction : la garde reste,
 * les déclencheurs de capture sont coupés et les écritures locales suivantes n'entrent plus dans `sync_outbox`, sans signe, jusqu'au
 * redémarrage. Le pilote la retire AVANT de rendre la file : aucune écriture d'un autre appelant ne passe sous une garde orpheline.
 */
describe('TRI-22 : garde de synchro retirée quand la transaction est perdue', () => {
  const NO_TX = 'error returned from database: (code: 1) cannot rollback - no transaction is active';
  const GUARD_DELETE = 'DELETE FROM sync_guard';

  function lostDriver(failing: { readonly rollback?: boolean; readonly commit?: boolean; readonly guardDelete?: boolean }): { readonly driver: SqlDriver; readonly sent: string[] } {
    const sent: string[] = [];
    const driver = createSerializedDriver('sqlite-wasm', {
      execute: (sql) => {
        sent.push(sql);
        if (sql === 'ROLLBACK' && failing.rollback) return Promise.reject(NO_TX);
        if (sql === 'COMMIT' && failing.commit) return Promise.reject('error returned from database: (code: 1) cannot commit - no transaction is active');
        if (sql === GUARD_DELETE && failing.guardDelete) return Promise.reject('disk I/O error');
        return Promise.resolve({ rowsAffected: 0, lastInsertId: null });
      },
      select: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    });
    return { driver, sent };
  }

  it('erreur du travail puis ROLLBACK sans transaction : la garde est retirée avant toute autre instruction', async () => {
    const { driver, sent } = lostDriver({ rollback: true });
    await expect(
      driver.transaction(async (tx) => {
        await tx.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await driver.execute('SELECT 1');
    expect(sent).toEqual(['BEGIN IMMEDIATE', 'INSERT OR IGNORE INTO sync_guard (id) VALUES (1)', 'ROLLBACK', GUARD_DELETE, 'SELECT 1']);
  });

  it('COMMIT perdu : la garde est retirée, l’échec `transaction-lost` reste visible', async () => {
    const { driver, sent } = lostDriver({ commit: true });
    await expect(driver.transaction(async (tx) => { await tx.execute('UPDATE t SET x = 1'); })).rejects.toMatchObject({ code: 'transaction-lost' });
    expect(sent).toContain(GUARD_DELETE);
    expect(sent.indexOf(GUARD_DELETE)).toBeGreaterThan(sent.indexOf('COMMIT'));
  });

  it('l’échec du nettoyage ne masque pas l’erreur d’origine', async () => {
    const { driver } = lostDriver({ rollback: true, guardDelete: true });
    await expect(driver.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('garde-fou : une transaction annulée normalement ne touche pas à la garde', async () => {
    const { driver, sent } = lostDriver({});
    await expect(driver.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sent).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
