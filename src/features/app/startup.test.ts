import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { useAppStore } from './appStore';
import { createAppContainer } from './container';
import { startAppStartup, type StartupEnv } from './startup';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000008');

function fakeEnv() {
  const handlers = new Map<string, () => void>();
  const add = vi.fn((type: string, h: () => void) => void handlers.set(type, h));
  const remove = vi.fn((type: string) => void handlers.delete(type));
  const doc = { addEventListener: add, removeEventListener: remove, visibilityState: 'visible' as DocumentVisibilityState };
  const env = { document: doc, window: { addEventListener: add, removeEventListener: remove } } as unknown as StartupEnv;
  return { env, handlers };
}

describe('startAppStartup (T-06)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, new Date(2026, 8, 23, 12).getTime());
  });
  afterEach(async () => {
    useAppStore.setState({ day: null, carryOverFailed: false });
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
});
