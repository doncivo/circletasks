import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLedgerStore } from './notificationLedger';
import { openNotificationScheduler, type NotificationSchedulerDeps } from './index';
import type { NotificationScheduler } from './types';

const deps: NotificationSchedulerDeps = {
  ledger: createLedgerStore({ load: () => Promise.resolve({ state: 'missing' }), save: () => Promise.resolve() }),
  clock: { nowMs: () => 0, zone: () => 'Europe/Paris' },
};

afterEach(() => {
  vi.doUnmock('./tauriNotifications');
  vi.resetModules();
});

describe('openNotificationScheduler (N-01 critère 1)', () => {
  it.each([
    ['tauri', 'windows'],
    ['tauri', 'other'],
    ['web', 'ios'],
    ['web', 'windows'],
    ['web', 'other'],
  ] as const)('(%s, %s) : toujours l’implémentation vide, même avec les dépendances de l’adaptateur', async (runtime, os) => {
    const scheduler = openNotificationScheduler(runtime, os, deps);
    expect(await scheduler.availability()).toBe('unavailable');
    expect(await scheduler.permission()).toBe('denied');
    expect(await scheduler.replace([])).toEqual({ scheduled: 0, cancelled: 0, kept: 0 });
    expect(await scheduler.pending()).toEqual([]);
    expect(await scheduler.reservedCount()).toBe(0);
  });

  it('(tauri, ios) : l’adaptateur réel, chargé à la demande', async () => {
    const real: NotificationScheduler = {
      availability: () => Promise.resolve('available'),
      permission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
      replace: () => Promise.resolve({ scheduled: 4, cancelled: 0, kept: 0 }),
      cancelAll: () => Promise.resolve(),
      pending: () => Promise.resolve([]),
      reservedCount: () => Promise.resolve(1),
    };
    const factory = vi.fn(() => real);
    vi.resetModules();
    vi.doMock('./tauriNotifications', () => ({ createTauriNotificationScheduler: factory, createIosNotificationBridge: () => ({}) }));
    const { openNotificationScheduler: open } = await import('./index');
    const scheduler = open('tauri', 'ios', deps);
    expect(factory).not.toHaveBeenCalled();
    expect(await scheduler.availability()).toBe('available');
    expect(await scheduler.replace([])).toEqual({ scheduled: 4, cancelled: 0, kept: 0 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toBeDefined();
  });

  it('(tauri, ios) sans plugin joignable : unavailable, jamais un silence', async () => {
    const scheduler = openNotificationScheduler('tauri', 'ios', deps);
    expect(await scheduler.availability()).toBe('unavailable');
    await expect(scheduler.replace([])).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
