import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
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

describe('démarrage : sauvegarde avant migration', () => {
  it('échec de sauvegarde sur une base existante : « error », dbBackupFailed, rien de migré', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 1));
    const result = await bootstrapDatabase(() => Promise.resolve(db), {
      backup: () => Promise.resolve({ backup: () => Promise.reject(new Error('disque plein')) }),
    });
    expect(result).toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error', dbBackupFailed: true });
  });

  it('D-03 échec de sauvegarde : aucune migration appliquée et base fermée', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 1));
    const transaction = vi.spyOn(db, 'transaction');
    const close = vi.spyOn(db, 'close');
    await bootstrapDatabase(() => Promise.resolve(db), {
      backup: () => Promise.resolve({ backup: () => Promise.reject(new Error('disque plein')) }),
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('base neuve : le port n’est jamais appelé', async () => {
    const backup = vi.fn(() => Promise.resolve());
    const db = await bootstrapDatabase(openSqliteWasmDriver, { backup: () => Promise.resolve({ backup }) });
    expect(db).toBeDefined();
    expect(backup).not.toHaveBeenCalled();
    expect(useAppStore.getState().dbBackupFailed).toBe(false);
  });
});
