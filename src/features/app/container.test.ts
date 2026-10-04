import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createManualClock } from '../../domain/clock';
import { createHlcClock, createWriteStamper, parseHlc } from '../../domain/hlc';
import type { DeviceId, Hlc } from '../../domain/types';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { createDataAccess, type RepositoryFactory, type Repositories } from '../../db/repositories';
import { createPendingRepositories } from '../../../tests/fixtures/pendingRepositories';
import { useAppStore } from './appStore';
import { bootstrapApp } from './bootstrap';
import { createAppContainer, defineFeatureStore, type AppContainer } from './container';

const DEVICE = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const clock = createManualClock('2026-10-01T08:00:00.000Z');

function testContainer(): AppContainer {
  const hlc = createHlcClock({ clock, deviceId: DEVICE });
  return createAppContainer({ clock, hlc, data: {} as never });
}

describe('conteneur', () => {
  it('complète les dépendances par défaut', () => {
    const c = testContainer();
    expect(c.clock).toBe(clock);
    expect(c.undo.getSnapshot().size).toBe(0);
    expect(c.shortcuts.activeIds()).toEqual([]);
    expect(c.platform).toEqual({ runtime: 'web', os: 'other' });
    expect(c.ids.next()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('crée un store de feature par conteneur', () => {
    const counter = defineFeatureStore((c) => createStore(() => ({ device: c.hlc.deviceId, n: 0 })));
    const a = testContainer();
    const b = testContainer();
    expect(counter.get(a)).toBe(counter.get(a));
    expect(counter.get(a)).not.toBe(counter.get(b));
    counter.get(a).setState({ n: 1 });
    expect(counter.get(b).getState().n).toBe(0);
  });
});

describe('démarrage complet', () => {
  beforeEach(() => useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null }));

  function fakeFactory(stored: DeviceId | null, maxHlc: Hlc | null, set = vi.fn(async () => undefined)): RepositoryFactory {
    return (executor, stamper) => {
      const pending = createPendingRepositories(executor, stamper);
      const repos: Repositories = {
        ...pending,
        settings: { ...pending.settings, get: async () => stored as never, set },
        syncMeta: { maxHlc: async () => maxHlc },
      };
      return repos;
    };
  }

  it('crée l’identité de l’appareil au premier lancement', async () => {
    const set = vi.fn(async () => undefined);
    const container = await bootstrapApp({
      open: openSqliteWasmDriver,
      repositories: fakeFactory(null, null, set),
      clock,
      ids: { next: () => DEVICE },
    });
    expect(container?.hlc.deviceId).toBe(DEVICE);
    expect(set).toHaveBeenCalledWith('device.id', DEVICE);
    expect(useAppStore.getState().dbStatus).toBe('ready');
  });

  it('reprend l’appareil connu et la graine HLC', async () => {
    const seed = `00${String(Date.parse('2026-10-02T00:00:00.000Z'))}-0005-${DEVICE}` as Hlc;
    const set = vi.fn(async () => undefined);
    const container = await bootstrapApp({ open: openSqliteWasmDriver, repositories: fakeFactory(DEVICE, seed, set), clock });
    expect(set).not.toHaveBeenCalled();
    expect(parseHlc(container?.hlc.now() ?? ('' as Hlc))).toMatchObject({ counter: 6 });
  });

  it('publie une erreur si on force les repositories en attente', async () => {
    expect(
      await bootstrapApp({ open: openSqliteWasmDriver, repositories: createPendingRepositories }),
    ).toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error' });
    expect(useAppStore.getState().dbErrorDetail).toMatch(/settings\.get/);
  });

  it('démarre avec les vrais repositories SQL par défaut (migrations et espaces Pro/Perso)', async () => {
    const container = await bootstrapApp({ open: openSqliteWasmDriver, clock, ids: { next: () => DEVICE } });
    expect(container).toBeDefined();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    const spaces = await container?.data.repos.spaces.listAll();
    expect(spaces?.map((s) => s.name)).toEqual(['Pro', 'Perso']);
  });

  it('s’arrête si la base ne s’ouvre pas', async () => {
    expect(await bootstrapApp({ open: () => Promise.reject(new Error('disque plein')) })).toBeUndefined();
  });

  it('les écritures de démarrage passent par le tampon HLC', async () => {
    const driver = await openSqliteWasmDriver();
    const seen: string[] = [];
    const factory: RepositoryFactory = (executor, stamper) => {
      const pending = createPendingRepositories(executor, stamper);
      return { ...pending, settings: { ...pending.settings, set: async () => void seen.push(stamper.next().hlc) } };
    };
    const hlc = createHlcClock({ clock, deviceId: DEVICE });
    await createDataAccess(driver, createWriteStamper(clock, hlc), factory).repos.settings.set('device.id', DEVICE);
    expect(seen).toHaveLength(1);
    await driver.close();
  });
});
