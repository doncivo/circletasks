import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import type { NewTask } from '../../domain/model';
import { asEntityId, asLocalDate, type DeviceId, type RecurrenceId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncPlatform } from '../../platform/sync/types';
import { startSyncIntegration } from '../sync/startSync';
import { createFakeSyncService, type FakeSyncService } from '../sync/testKit';
import { useAppStatusStore } from './appStatus';
import { useAppStore } from './appStore';
import { createAppContainer, type AppContainer } from './container';
import { startAppStartup, type StartupEnv } from './startup';
import { FIRST_CYCLE_GATE_MS } from './syncGate';

/**
 * T-TECH-01 critères 6 à 10 : la porte de synchro du premier report. Horloge et minuterie injectées (aucun délai réel) ; le service de
 * synchro est un faux dont l'état est posé à la main.
 */

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a9');
const LATE = asEntityId<TaskId>('61000000-0000-4000-8000-000000000001');
const RULE = asEntityId<RecurrenceId>('62000000-0000-4000-8000-000000000001');

function fakeEnv(gateTimers: ReturnType<typeof fakeTimers>, extra: Partial<StartupEnv> = {}) {
  const handlers = new Map<string, () => void>();
  const add = vi.fn((type: string, h: () => void) => void handlers.set(type, h));
  const remove = vi.fn((type: string) => void handlers.delete(type));
  const document = { addEventListener: add, removeEventListener: remove, visibilityState: 'visible' as DocumentVisibilityState };
  const env = { document, window: { addEventListener: add, removeEventListener: remove }, gateTimers, ...extra } as unknown as StartupEnv;
  return { env, handlers, document };
}

/** Minuterie manuelle : `fire()` déclenche la minuterie armée, comme si 12 s s'étaient écoulées. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout: vi.fn((handler: () => void) => {
      pending.set(++next, handler);
      return next;
    }),
    clearTimeout: vi.fn((handle: unknown) => void pending.delete(handle as number)),
    fire: () => [...pending.values()].forEach((handler) => handler()),
    armed: () => pending.size,
  };
}

const platformWith = (configured: boolean): SyncPlatform => ({ folder: { info: () => Promise.resolve({ configured, label: null, kind: 'icloud', pinned: false }) } }) as unknown as SyncPlatform;

describe('porte de synchro du premier report (T-TECH-01 critères 6 à 10)', () => {
  let db: TestDb;
  let sync: FakeSyncService;
  let timers: ReturnType<typeof fakeTimers>;
  const toDispose: { dispose(): void }[] = [];
  beforeEach(async () => {
    db = await openTestDb(DEVICE, new Date(2026, 8, 23, 12).getTime());
    sync = createFakeSyncService();
    timers = fakeTimers();
    useAppStatusStore.getState().setStatus('syncTrouble', null);
    // Une tâche d'hier à faire (à reporter) et une récurrence passée (occurrence suivante à générer).
    await db.data.repos.recurrences.create({ id: RULE, freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
    const base: NewTask = { id: LATE, spaceId: SPACE_PRO_ID, projectId: null, title: 'En retard', note: '', date: asLocalDate('2026-09-22'), time: null, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: RULE, seriesIndex: 0, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null };
    await db.data.repos.tasks.create(base);
  });
  afterEach(async () => {
    for (const item of toDispose.splice(0)) item.dispose();
    useAppStore.setState({ day: null, carryOverFailed: false, timeZone: null });
    await db.close();
  });

  const container = (parts: { sync?: boolean; configured?: boolean } = {}): AppContainer =>
    createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: createManualClock(0), deviceId: DEVICE }),
      data: db.data,
      ...(parts.sync === false ? {} : { sync, syncPlatform: platformWith(parts.configured ?? true) }),
    });
  const late = () => db.data.repos.tasks.getById(LATE);
  const seriesCount = () => db.data.repos.tasks.listByRecurrence(RULE).then((rows) => rows.length);

  it('critères 6 et 9 : ni génération ni report avant le premier cycle conclu, une seule fois ensuite ; ready n’attend pas le cycle', async () => {
    const { env } = fakeEnv(timers);
    const startup = startAppStartup(container(), env);
    toDispose.push(startup);
    await startup.ready; // se résout sans cycle : le premier rendu n'est jamais bloqué
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), FIRST_CYCLE_GATE_MS);
    expect(await late()).toMatchObject({ date: '2026-09-22', carriedOver: false });
    expect(await seriesCount()).toBe(1);
    expect(useAppStore.getState().day).toBeNull();

    sync.setStatus({ phase: 'idle', lastSyncAt: '2026-09-23T10:00:00.000Z' as never }); // premier cycle réussi
    await startup.firstCheck;

    expect(await late()).toMatchObject({ date: '2026-09-23', carriedOver: true });
    expect(await seriesCount()).toBe(2);
    expect(useAppStore.getState().day).toBe('2026-09-23'); // « Aujourd'hui » se rafraîchit à la fin du report
    expect(timers.clearTimeout).toHaveBeenCalled(); // la minuterie est retirée à l'ouverture
  });

  it('B1 : fichiers iCloud en attente (waiting-icloud, ancienne heure de synchro) : le report part, le nettoyage ne tourne pas ; cycle réussi : il tourne', async () => {
    const { env } = fakeEnv(timers);
    const startup = startAppStartup(container(), env);
    toDispose.push(startup);
    await startup.ready;
    sync.setStatus({ phase: 'waiting-icloud', lastSyncAt: '2026-09-20T10:00:00.000Z' as never });
    await startup.firstCheck;
    expect(await late()).toMatchObject({ carriedOver: true });
    expect(await db.data.repos.sync.getMeta('recurrenceDedup')).toBeNull();

    const second = startAppStartup(container(), fakeEnv(fakeTimers()).env);
    toDispose.push(second);
    await second.ready;
    sync.setStatus({ phase: 'idle', lastSyncAt: '2026-09-23T10:00:00.000Z' as never });
    await second.firstCheck;
    expect(await db.data.repos.sync.getMeta('recurrenceDedup')).not.toBeNull();
  });

  it('critère 6 : un cycle en cours (phase syncing, progression) n’ouvre pas la porte', async () => {
    const { env } = fakeEnv(timers);
    const startup = startAppStartup(container(), env);
    toDispose.push(startup);
    await startup.ready;
    sync.setStatus({ phase: 'syncing' });
    sync.setStatus({ phase: 'syncing', progress: { done: 1, total: 4 } });
    expect(await late()).toMatchObject({ carriedOver: false });
    sync.setStatus({ phase: 'idle', progress: null, lastSyncAt: '2026-09-23T10:00:01.000Z' as never });
    await startup.firstCheck;
    expect(await late()).toMatchObject({ carriedOver: true });
  });

  it('critère 7 : 12 s sans conclusion (horloge injectée) : le report et la génération partent', async () => {
    const { env } = fakeEnv(timers);
    const startup = startAppStartup(container(), env);
    toDispose.push(startup);
    await startup.ready;
    expect(await late()).toMatchObject({ carriedOver: false });
    timers.fire();
    await startup.firstCheck;
    expect(await late()).toMatchObject({ date: '2026-09-23', carriedOver: true });
    expect(await seriesCount()).toBe(2);
  });

  it('critère 7 et D3 : un cycle en échec ouvre la porte aussitôt (sans les 12 s) et l’état A-09 de synchro est visible', async () => {
    const c = container();
    const { env, document } = fakeEnv(timers);
    const startup = startAppStartup(c, env);
    toDispose.push(startup);
    await startup.ready;
    const integration = startSyncIntegration(c, { document, clock: db.clock, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    toDispose.push(integration);

    expect(await late()).toMatchObject({ date: '2026-09-22', carriedOver: false }); // la porte retient le report tant que le cycle n'a pas conclu
    sync.setStatus({ phase: 'error', errorCode: 'io' });
    await startup.firstCheck;
    await integration.refreshed();

    expect(await late()).toMatchObject({ date: '2026-09-23', carriedOver: true }); // le report a eu lieu
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeDefined(); // et l'échec reste visible (A-09)
    expect(timers.armed()).toBe(0); // sans attendre les 12 s : la minuterie a été retirée, pas tirée
  });

  it('critère 8 : aucune synchro configurée : le report part tout de suite, aucune minuterie armée, ready l’attend', async () => {
    for (const c of [container({ configured: false }), container({ sync: false })]) {
      const t = fakeTimers();
      const { env } = fakeEnv(t);
      const startup = startAppStartup(c, env);
      toDispose.push(startup);
      await startup.ready;
      expect(t.setTimeout).not.toHaveBeenCalled();
      expect(await late()).toMatchObject({ date: '2026-09-23', carriedOver: true });
      expect(useAppStore.getState().day).toBe('2026-09-23');
      startup.dispose();
      await db.driver.execute('UPDATE task SET date = ?, carried_over = 0 WHERE id = ?', ['2026-09-22', LATE]);
      useAppStore.setState({ day: null });
    }
  });

  it('critère 10 : les contrôles suivants ne repassent pas par la porte et ne réarment pas la minuterie', async () => {
    const detect = vi.fn(() => 'Europe/Paris');
    const { env, handlers } = fakeEnv(timers, { detectTimeZone: detect });
    const startup = startAppStartup(container(), env);
    toDispose.push(startup);
    await startup.ready;

    // Avant l'ouverture de la porte, un retour au premier plan ne lance aucun report (base périmée).
    const transaction = vi.spyOn(db.data, 'transaction');
    handlers.get('focus')?.();
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
    expect(transaction).not.toHaveBeenCalled();
    expect(await late()).toMatchObject({ carriedOver: false });

    sync.setStatus({ phase: 'idle', lastSyncAt: '2026-09-23T10:00:00.000Z' as never });
    await startup.firstCheck;
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);

    // Après : minuit passé, retour au premier plan : contrôle direct, la minuterie de la porte n'est pas réarmée.
    db.clock.set(new Date(2026, 8, 24, 8).getTime());
    handlers.get('focus')?.();
    await vi.waitFor(() => expect(useAppStore.getState().day).toBe('2026-09-24'));
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.armed()).toBe(0);
  });

  it('démontage pendant l’attente : minuterie retirée, aucun report ni mise à jour du jour', async () => {
    const { env } = fakeEnv(timers);
    const startup = startAppStartup(container(), env);
    await startup.ready;
    startup.dispose();
    await startup.firstCheck;
    expect(timers.armed()).toBe(0);
    expect(await late()).toMatchObject({ carriedOver: false });
    expect(useAppStore.getState().day).toBeNull();
  });
});
