import { describe, expect, it, vi } from 'vitest';
import { BackupError, createMemoryBackup, createTauriBackup, createUnavailableBackup, reasonOf, type BackupVersion, type TauriBackupApi } from './index';

const version = (name: string, extra: Partial<BackupVersion> = {}): BackupVersion => ({ name, kind: 'daily', stamp: '20261003', size: 4096, modifiedMs: 1, tasks: 3, schemaVersion: 14, ...extra });

function makeApi(overrides: Partial<TauriBackupApi> = {}): TauriBackupApi {
  return {
    list: () => Promise.resolve({ directory: 'C:\\Users\\Ali\\AppData\\Roaming\\fr.circletasks.planner\\backups', entries: [version('circletasks-daily-20261003.db')] }),
    daily: () => Promise.resolve({ created: true }),
    check: () => Promise.resolve(14),
    restore: () => Promise.resolve({ safetyCopy: 'x', schemaVersion: 14 }),
    reveal: () => Promise.resolve(),
    relaunch: () => Promise.resolve(),
    ...overrides,
  };
}

function makeDb() {
  const calls: string[] = [];
  return {
    calls,
    db: {
      select: vi.fn((sql: string) => {
        calls.push(sql);
        return Promise.resolve([{ busy: 0 }]);
      }),
      close: vi.fn(() => {
        calls.push('close');
        return Promise.resolve();
      }),
    },
  };
}

describe('Service de sauvegarde Tauri (P-04)', () => {
  it('liste : dossier et versions de Rust', async () => {
    const { db } = makeDb();
    const listing = await createTauriBackup({ db, appSchemaVersion: 14, api: makeApi() }).list();
    expect(listing.directory).toContain('backups');
    expect(listing.versions.map((v) => v.name)).toEqual(['circletasks-daily-20261003.db']);
  });

  it('sauvegarde quotidienne : point de contrôle WAL, puis la commande avec le jour et le remplacement', async () => {
    const { db, calls } = makeDb();
    const daily = vi.fn(() => {
      calls.push('daily');
      return Promise.resolve({ created: true });
    });
    const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi({ daily }) });
    await expect(service.createDaily({ day: '20261005', replace: true })).resolves.toEqual({ created: true });
    expect(calls).toEqual(['PRAGMA wal_checkpoint(TRUNCATE)', 'daily']);
    expect(daily).toHaveBeenCalledWith('20261005', true);
  });

  it('un point de contrôle impossible (base occupée) n’empêche pas la copie', async () => {
    const { db } = makeDb();
    db.select.mockRejectedValueOnce(new Error('database is locked'));
    const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi() });
    await expect(service.createDaily({ day: '20261005', replace: false })).resolves.toEqual({ created: true });
  });

  it('une erreur de Rust devient une BackupError à raison stable', async () => {
    const { db } = makeDb();
    const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi({ daily: () => Promise.reject({ code: 'io', message: 'disque plein' }) }) });
    await expect(service.createDaily({ day: '20261005', replace: false })).rejects.toMatchObject({ name: 'BackupError', reason: 'io' });
    expect(reasonOf({ code: 'newer-schema' })).toBe('newer-schema');
    expect(reasonOf({ code: 'inconnu' })).toBe('io');
    expect(reasonOf(new Error('x'))).toBe('io');
  });

  it('restauration : vérification AVANT la fermeture de la base, puis fermeture, puis remplacement', async () => {
    const { db, calls } = makeDb();
    const api = makeApi({
      check: (name, appSchemaVersion) => {
        calls.push(`check:${name}:${String(appSchemaVersion)}`);
        return Promise.resolve(14);
      },
      restore: (name, stamp, appSchemaVersion) => {
        calls.push(`restore:${name}:${stamp}:${String(appSchemaVersion)}`);
        return Promise.resolve({});
      },
    });
    const service = createTauriBackup({ db, appSchemaVersion: 14, api });
    await service.restore({ name: 'circletasks-daily-20261003.db', stamp: '20261005T101500Z' });
    expect(calls).toEqual([
      'check:circletasks-daily-20261003.db:14',
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'close',
      'restore:circletasks-daily-20261003.db:20261005T101500Z:14',
    ]);
  });

  it('critère 7 : une version plus récente ou corrompue est refusée sans fermer la base', async () => {
    for (const code of ['newer-schema', 'corrupt'] as const) {
      const { db } = makeDb();
      const restore = vi.fn(() => Promise.resolve({}));
      const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi({ check: () => Promise.reject({ code, message: 'x' }), restore }) });
      const error = await service.restore({ name: 'circletasks-daily-20261003.db', stamp: '20261005T101500Z' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackupError);
      expect(error).toMatchObject({ reason: code, databaseClosed: false });
      expect(db.close).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    }
  });

  it('critère 8 : un échec de Rust après la fermeture signale qu’un redémarrage est nécessaire', async () => {
    const { db } = makeDb();
    const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi({ restore: () => Promise.reject({ code: 'io', message: 'échec' }) }) });
    await expect(service.restore({ name: 'circletasks-daily-20261003.db', stamp: '20261005T101500Z' })).rejects.toMatchObject({ reason: 'io', databaseClosed: true });
  });

  it('redémarrage et dossier : commandes sans paramètre venant de l’interface', async () => {
    const { db } = makeDb();
    const relaunch = vi.fn(() => Promise.resolve());
    const reveal = vi.fn(() => Promise.resolve());
    const service = createTauriBackup({ db, appSchemaVersion: 14, api: makeApi({ relaunch, reveal }) });
    await service.restart();
    await service.reveal?.();
    expect(relaunch).toHaveBeenCalledWith();
    expect(reveal).toHaveBeenCalledWith();
  });
});

describe('Faux en mémoire et service indisponible', () => {
  it('une version par jour ; « remplacer » met à jour celle du jour ; 14 quotidiennes au plus', async () => {
    let now = 1000;
    const service = createMemoryBackup({ nowMs: () => now });
    await expect(service.createDaily({ day: '20261005', replace: false })).resolves.toEqual({ created: true });
    now = 2000;
    await expect(service.createDaily({ day: '20261005', replace: false })).resolves.toEqual({ created: false });
    await expect(service.createDaily({ day: '20261005', replace: true })).resolves.toEqual({ created: true });
    expect(service.versions).toHaveLength(1);
    expect(service.versions[0]?.modifiedMs).toBe(2000);
    for (let day = 1; day <= 20; day += 1) await service.createDaily({ day: `202609${String(day).padStart(2, '0')}`, replace: false });
    expect(service.versions.filter((v) => v.kind === 'daily')).toHaveLength(14);
  });

  it('échec programmé et restauration inconnue', async () => {
    const service = createMemoryBackup({ versions: [version('a.db')] });
    service.failNext('restore', 'corrupt');
    await expect(service.restore({ name: 'a.db', stamp: 's' })).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(service.restore({ name: 'a.db', stamp: 's' })).resolves.toBeUndefined();
    await expect(service.restore({ name: 'absente.db', stamp: 's' })).rejects.toMatchObject({ reason: 'not-found' });
    expect(service.restores).toHaveLength(1);
  });

  it('indisponible (iPhone) : available() est faux et toute opération échoue proprement', async () => {
    const service = createUnavailableBackup();
    expect(service.available()).toBe(false);
    await expect(service.list()).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
