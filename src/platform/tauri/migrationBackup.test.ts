import { describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../../db/driver';

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve({ path: 'x', removed: 0 } as { path: string | null; removed: number }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { createTauriMigrationBackup, BACKUP_COMMAND } = await import('./migrationBackup');

const request = { fromVersion: 2, toVersion: 4, stamp: '20261002T101500Z' };
const dbWith = (busy: number, order: string[] = []): SqlDriver =>
  ({
    select: (sql: string) => {
      order.push(sql);
      return Promise.resolve([{ busy, log: 0, checkpointed: 0 }]);
    },
  }) as unknown as SqlDriver;

describe('sauvegarde Tauri', () => {
  it('checkpoint WAL puis commande Rust, dans cet ordre', async () => {
    const order: string[] = [];
    invoke.mockImplementationOnce(() => {
      order.push('invoke');
      return Promise.resolve({ path: 'x', removed: 0 });
    });
    await createTauriMigrationBackup(dbWith(0, order)).backup(request);
    expect(order).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)', 'invoke']);
    expect(invoke).toHaveBeenLastCalledWith(BACKUP_COMMAND, request);
  });

  it('checkpoint occupé (busy = 1) : erreur, commande non appelée', async () => {
    invoke.mockClear();
    await expect(createTauriMigrationBackup(dbWith(1)).backup(request)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('aucun fichier créé (path null) : erreur', async () => {
    invoke.mockResolvedValueOnce({ path: null, removed: 0 });
    await expect(createTauriMigrationBackup(dbWith(0)).backup(request)).rejects.toThrow();
  });

  it('propage l’échec de la commande', async () => {
    invoke.mockRejectedValueOnce({ code: 'no-database', message: 'introuvable' });
    await expect(createTauriMigrationBackup(dbWith(0)).backup(request)).rejects.toBeDefined();
  });
});
