import { describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../../db/driver';

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve({ path: 'x', removed: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { createTauriMigrationBackup, BACKUP_COMMAND } = await import('./migrationBackup');

describe('sauvegarde Tauri', () => {
  it('checkpoint WAL puis commande Rust, dans cet ordre', async () => {
    const order: string[] = [];
    const db = {
      select: (sql: string) => {
        order.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as SqlDriver;
    invoke.mockImplementationOnce(() => {
      order.push('invoke');
      return Promise.resolve({ path: 'x', removed: 0 });
    });
    await createTauriMigrationBackup(db).backup({ fromVersion: 2, toVersion: 4, stamp: '20261002T101500Z' });
    expect(order).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)', 'invoke']);
    expect(invoke).toHaveBeenLastCalledWith(BACKUP_COMMAND, { fromVersion: 2, toVersion: 4, stamp: '20261002T101500Z' });
  });

  it('propage l’échec de la commande', async () => {
    const db = { select: () => Promise.resolve([]) } as unknown as SqlDriver;
    invoke.mockRejectedValueOnce({ code: 'io', message: 'disque plein' });
    await expect(
      createTauriMigrationBackup(db).backup({ fromVersion: 1, toVersion: 2, stamp: '20261002T101500Z' }),
    ).rejects.toBeDefined();
  });
});
