import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupError, createMemoryBackup, createTauriBackup, markerOf, openBackupService, type TauriBackupApi } from './index';

/** P-04-iOS critères 1, 6, 7 et 12 : service de l'iPhone, ordre de la restauration, aucun appel à la base après la fermeture, marqueur. */
function makeApi(log: string[], overrides: Partial<TauriBackupApi> = {}): TauriBackupApi {
  return {
    list: () => Promise.resolve({ directory: null, entries: [] }),
    daily: () => Promise.resolve({ created: true }),
    check: () => {
      log.push('check');
      return Promise.resolve(17);
    },
    restore: () => {
      log.push('restore');
      return Promise.resolve({ safetyCopy: 'x', schemaVersion: 17, marker: 'written', markerCode: null });
    },
    reveal: () => Promise.resolve(),
    relaunch: () => Promise.resolve(),
    ...overrides,
  };
}

/** Connexion unique factice : compte chaque appel, et ceux faits APRÈS la fermeture. */
function countingDb(log: string[]) {
  let closed = false;
  const afterClose: string[] = [];
  return {
    afterClose,
    db: {
      select: (sql: string) => {
        log.push(sql.startsWith('PRAGMA wal_checkpoint') ? 'checkpoint' : sql);
        if (closed) afterClose.push(sql);
        return Promise.resolve([]);
      },
      close: () => {
        log.push('close');
        if (closed) afterClose.push('close');
        closed = true;
        return Promise.resolve();
      },
    },
  };
}

describe('P-04-iOS : service de sauvegarde de l’iPhone', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('critère 1 : (tauri, ios) disponible, sans « Afficher dans le dossier », redémarrage = rechargement de la WebView', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const service = openBackupService('tauri', 'ios', { db: countingDb([]).db as never });
    expect(service.available()).toBe(true);
    expect(service.reveal).toBeUndefined();
    await service.restart();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(openBackupService('tauri', 'windows', { db: countingDb([]).db as never }).reveal).toBeTypeOf('function');
    expect(openBackupService('web', 'other', { db: countingDb([]).db as never }).available()).toBe(true);
  });

  it('critère 6 : vérifier -> mise au calme -> point de contrôle -> fermeture -> échange ; aucun appel à la base après la fermeture', async () => {
    const log: string[] = [];
    const { db, afterClose } = countingDb(log);
    const service = createTauriBackup({ db, api: makeApi(log), restart: () => Promise.resolve(), reveal: false });
    const result = await service.restore({ name: 'circletasks-daily-20261007.db', stamp: '20261008T080000Z' }, { prepare: () => Promise.resolve(void log.push('quiesce')) });
    expect(log).toEqual(['check', 'quiesce', 'checkpoint', 'close', 'restore']);
    expect(afterClose).toEqual([]);
    expect(result).toEqual({ marker: 'written', markerCode: null });
  });

  it('critère 6 : mise au calme refusée (synchro en cours) : rien n’est fermé ni modifié', async () => {
    const log: string[] = [];
    const { db } = countingDb(log);
    const service = createTauriBackup({ db, api: makeApi(log) });
    const failure = service.restore({ name: 'x.db', stamp: 's' }, { prepare: () => Promise.reject(new BackupError('sync-busy')) });
    await expect(failure).rejects.toMatchObject({ reason: 'sync-busy', databaseClosed: false });
    expect(log).toEqual(['check']);
  });

  it('critère 7 : échec après la fermeture -> databaseClosed ; connexion encore ouverte côté Rust -> db-open', async () => {
    const log: string[] = [];
    const { db } = countingDb(log);
    const service = createTauriBackup({ db, api: makeApi(log, { restore: () => Promise.reject({ code: 'db-open', message: 'x' }) }) });
    await expect(service.restore({ name: 'x.db', stamp: 's' })).rejects.toMatchObject({ reason: 'db-open', databaseClosed: true });
  });

  it('critère 12 : marqueur rendu par Rust : écrit, non configuré, échec (code), forme inattendue = échec (jamais tue)', () => {
    expect(markerOf({ marker: 'written' })).toEqual({ marker: 'written', markerCode: null });
    expect(markerOf({ marker: 'not-configured' })).toEqual({ marker: 'not-configured', markerCode: null });
    expect(markerOf({ marker: 'failed', markerCode: 'io' })).toEqual({ marker: 'failed', markerCode: 'io' });
    expect(markerOf({ safetyCopy: 'x' })).toEqual({ marker: 'failed', markerCode: 'unknown' });
    expect(markerOf(null)).toEqual({ marker: 'failed', markerCode: 'unknown' });
  });

  it('faux en mémoire : la mise au calme précède la restauration ; marqueur programmable', async () => {
    const service = createMemoryBackup({ versions: [{ name: 'a.db', kind: 'daily', stamp: '20261007', size: 1, modifiedMs: 1, tasks: 1, schemaVersion: 17 }] });
    service.markerNext({ marker: 'failed', markerCode: 'io' });
    const order: string[] = [];
    const result = await service.restore({ name: 'a.db', stamp: 's' }, { prepare: () => Promise.resolve(void order.push('quiesce')) });
    expect(order).toEqual(['quiesce']);
    expect(result).toEqual({ marker: 'failed', markerCode: 'io' });
  });
});
