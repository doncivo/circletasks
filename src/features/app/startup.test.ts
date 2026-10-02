import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { useAppStore } from './appStore';
import { createAppContainer } from './container';
import { startAppStartup, type StartupEnv } from './startup';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000008');

function fakeEnv(extra: Partial<StartupEnv> = {}) {
  const handlers = new Map<string, () => void>();
  const add = vi.fn((type: string, h: () => void) => void handlers.set(type, h));
  const remove = vi.fn((type: string) => void handlers.delete(type));
  const doc = { addEventListener: add, removeEventListener: remove, visibilityState: 'visible' as DocumentVisibilityState };
  const env = { document: doc, window: { addEventListener: add, removeEventListener: remove } } as unknown as StartupEnv;
  Object.assign(env, extra);
  return { env, handlers };
}

describe('startAppStartup (T-06)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, new Date(2026, 8, 23, 12).getTime());
  });
  afterEach(async () => {
    useAppStore.setState({ day: null, carryOverFailed: false, timeZone: null });
    await db.close();
  });
  const container = () => createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: createManualClock(0), deviceId: DEVICE }), data: db.data });

  it('premier contrôle publié dans le store, écouteurs visibilitychange et focus posés puis retirés', async () => {
    const { env, handlers } = fakeEnv();
    const startup = startAppStartup(container(), env);
    expect([...handlers.keys()].sort()).toEqual(['focus', 'visibilitychange']);
    await startup.ready;
    expect(useAppStore.getState().day).toBe('2026-09-23');
    startup.dispose();
    startup.dispose();
    expect(handlers.size).toBe(0);
  });

  it('focus et retour au premier plan relancent un contrôle (veille sans visibilitychange)', async () => {
    const { env, handlers } = fakeEnv();
    const startup = startAppStartup(container(), env);
    await startup.ready;
    db.clock.set(new Date(2026, 8, 24, 8).getTime());
    handlers.get('focus')?.();
    await vi.waitFor(() => expect(useAppStore.getState().day).toBe('2026-09-24'));
    startup.dispose();
  });

  it('démontage avant la fin de start : nettoyage sans réarmement ni mise à jour du jour', async () => {
    const { env, handlers } = fakeEnv();
    const startup = startAppStartup(container(), env);
    startup.dispose();
    await startup.ready;
    expect(handlers.size).toBe(0);
    expect(useAppStore.getState().day).toBeNull();
  });

  it('T-11 : fuseau publié au démarrage ; un changement au retour au premier plan met à jour le réglage et notifie', async () => {
    let zone = 'Europe/Paris';
    const changes: unknown[] = [];
    const { env, handlers } = fakeEnv({ detectTimeZone: () => zone, onTimeZoneChange: (c) => void changes.push(c) });
    const startup = startAppStartup(container(), env);
    await startup.ready;
    expect(useAppStore.getState().timeZone).toBe('Europe/Paris');
    expect(await db.data.repos.settings.get('general.timeZone')).toBe('Europe/Paris');
    zone = 'Africa/Tunis';
    handlers.get('focus')?.();
    await vi.waitFor(() => expect(useAppStore.getState().timeZone).toBe('Africa/Tunis'));
    expect(await db.data.repos.settings.get('general.timeZone')).toBe('Africa/Tunis');
    expect(changes).toEqual([{ previous: 'Europe/Paris', current: 'Africa/Tunis' }]);
    startup.dispose();
  });

  it('T-08 : purge de la corbeille au démarrage, seulement au-delà de 30 jours', async () => {
    const old = '70000000-0000-4000-8000-0000000000a1';
    const recent = '70000000-0000-4000-8000-0000000000a2';
    const insert = (id: string, deletedAt: string) =>
      db.driver.execute(
        `INSERT INTO task (id, space_id, title, note, status, sort_order, carried_over, someday, source, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, (SELECT id FROM space LIMIT 1), 'Tâche', '', 'todo', 0, 0, 0, 'local', ?, ?, ?, ?, ?)`,
        [id, deletedAt, deletedAt, deletedAt, DEVICE, `h-${id}`],
      );
    await insert(old, '2026-08-01T08:00:00.000Z');
    await insert(recent, '2026-09-10T08:00:00.000Z');
    const { env } = fakeEnv();
    const startup = startAppStartup(container(), env);
    await startup.ready;
    await vi.waitFor(async () => {
      const rows = await db.driver.select<{ id: string }>('SELECT id FROM task ORDER BY id', []);
      expect(rows.map((r) => r.id)).toEqual([recent]);
    });
    startup.dispose();
  });
});
