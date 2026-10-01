import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Faux @tauri-apps/plugin-sql : enregistre les appels, pas d'IPC. */
const calls: Array<{ op: string; sql?: string; params?: unknown[] }> = [];
const fake = {
  execute: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ op: 'execute', sql, params: params ?? [] });
    return sql.startsWith('INSERT') ? { rowsAffected: 1, lastInsertId: 7 } : { rowsAffected: 0 };
  }),
  select: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ op: 'select', sql, params: params ?? [] });
    return [{ n: 1 }];
  }),
  close: vi.fn(async () => {
    calls.push({ op: 'close' });
    return true;
  }),
};
const load = vi.fn(async (_url: string) => fake);

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: (url: string) => load(url) } }));

const { openTauriSqlDriver, TAURI_DB_URL } = await import('./sqlDriver');

describe('driver Tauri SQL (plugin simulé)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('ouvre la base par défaut et pose les PRAGMA dans l’ordre', async () => {
    const db = await openTauriSqlDriver();
    expect(db.kind).toBe('tauri-sqlite');
    expect(load).toHaveBeenCalledWith(TAURI_DB_URL);
    expect(calls.map((c) => c.sql)).toEqual(['PRAGMA foreign_keys = ON', 'PRAGMA journal_mode = WAL']);
  });

  it('transmet les paramètres et normalise lastInsertId', async () => {
    const db = await openTauriSqlDriver('sqlite:test.db');
    expect(load).toHaveBeenCalledWith('sqlite:test.db');
    calls.length = 0;

    await expect(db.execute('INSERT INTO t VALUES (?, ?)', ['a', 2])).resolves.toEqual({
      rowsAffected: 1,
      lastInsertId: 7,
    });
    await expect(db.execute('UPDATE t SET x = ?', [null])).resolves.toEqual({ rowsAffected: 0, lastInsertId: null });
    await expect(db.select('SELECT n FROM t WHERE id = ?', ['a'])).resolves.toEqual([{ n: 1 }]);
    await expect(db.execute('DELETE FROM t')).resolves.toMatchObject({ lastInsertId: null });

    expect(calls).toEqual([
      { op: 'execute', sql: 'INSERT INTO t VALUES (?, ?)', params: ['a', 2] },
      { op: 'execute', sql: 'UPDATE t SET x = ?', params: [null] },
      { op: 'select', sql: 'SELECT n FROM t WHERE id = ?', params: ['a'] },
      { op: 'execute', sql: 'DELETE FROM t', params: [] },
    ]);
  });

  it('encadre une transaction par BEGIN IMMEDIATE / COMMIT et ferme la base', async () => {
    const db = await openTauriSqlDriver();
    calls.length = 0;
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (?)', ['x']);
    });
    await db.close();
    expect(calls.map((c) => c.sql ?? c.op)).toEqual(['BEGIN IMMEDIATE', 'INSERT INTO t VALUES (?)', 'COMMIT', 'close']);
  });

  it('normalise les erreurs du plugin', async () => {
    const db = await openTauriSqlDriver();
    fake.execute.mockRejectedValueOnce('error returned from database: (code: 2067) UNIQUE constraint failed: t.id');
    await expect(db.execute('INSERT INTO t VALUES (?)', ['x'])).rejects.toMatchObject({
      name: 'DbError',
      code: 'constraint',
    });
  });
});
