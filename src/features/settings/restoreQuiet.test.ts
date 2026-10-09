import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { isRestoreQuiet, quietWorkSettled, setRestoreQuiet, trackQuietWork } from '../../platform/quiet';
import { createMemorySyncPlatform } from '../../platform/sync';
import { createMemorySyncLogger, createSyncService } from '../../sync';
import { createAppContainer } from '../app/container';
import { calendarsStore } from '../calendars/calendarsStore';
import { startCalendarScheduler } from '../calendars/scheduler';
import { runRemindersPass } from '../calendars/appleReminders/remindersPass';
import { quiesceForRestore } from './restoreQuiesce';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fe');

/** P-04-iOS, revue I3 : la mise au calme vaut au niveau du service (toute origine), des agendas et des Rappels Apple. */
describe('mise au calme au niveau des services', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
  });
  afterEach(async () => {
    setRestoreQuiet(false);
    vi.restoreAllMocks();
    await db.close();
  });

  it('syncNow refusé pendant le calme, d’où que vienne la demande (zone de notification, minuteur d’association, manuel)', async () => {
    const logger = createMemorySyncLogger();
    const service = createSyncService({ data: db.data, platform: createMemorySyncPlatform(), hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), clock: db.clock, deviceId: DEVICE, sv: 1, appVersion: '0.2.3', logger });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, sync: service });
    const handle = await quiesceForRestore(container, 50);
    expect(typeof handle).toBe('object');
    expect(isRestoreQuiet()).toBe(true);
    for (const reason of ['tray', 'timer', 'manual'] as const) await service.syncNow(reason);
    expect(logger.entries.map((entry) => entry.event)).toEqual(['sync-now-quiet', 'sync-now-quiet', 'sync-now-quiet']);
    expect(service.running()).toBeNull();
    if (typeof handle === 'object') handle.release();
    expect(isRestoreQuiet()).toBe(false);
  });

  it('passage des Rappels Apple et rafraîchissement des agendas : sautés pendant le calme', async () => {
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    setRestoreQuiet(true);
    expect(await runRemindersPass(container, 'full')).toMatchObject({ status: 'skipped', reason: 'restore' });
    const refresh = vi.spyOn(calendarsStore.get(container).getState(), 'refreshAll');
    const scheduler = startCalendarScheduler(container, {
      document: { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as never,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    await scheduler.resume();
    expect(refresh).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('un travail en cours est attendu ; au-delà du délai, la mise au calme est refusée (busy) et relâchée', async () => {
    let finish: () => void = () => undefined;
    void trackQuietWork(new Promise<void>((resolve) => (finish = resolve)));
    expect(await quietWorkSettled(20)).toBe(false);
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    expect(await quiesceForRestore(container, 20)).toBe('busy');
    expect(isRestoreQuiet()).toBe(false);
    finish();
    expect(await quietWorkSettled(20)).toBe(true);
  });
});
