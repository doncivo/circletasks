import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { useAppStore } from './appStore';
import { bootstrapDatabase, getDatabase } from './bootstrap';

describe('démarrage de la base', () => {
  beforeEach(() => {
    useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null });
  });

  it('ouvre la base, applique les migrations et publie « ready »', async () => {
    const db = await bootstrapDatabase(openSqliteWasmDriver);
    expect(db).toBeDefined();
    expect(getDatabase()).toBe(db);
    expect(useAppStore.getState().dbStatus).toBe('ready');
    const rows = await getDatabase().select("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'");
    expect(rows).toHaveLength(1);
  });

  it('publie « error » si l’ouverture échoue', async () => {
    const db = await bootstrapDatabase(() => Promise.reject(new Error('disque plein')));
    expect(db).toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error', dbErrorDetail: 'disque plein' });
  });
});
