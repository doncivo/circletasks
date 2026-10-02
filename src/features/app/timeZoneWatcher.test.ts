import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { createManualClock } from '../../domain/clock';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer } from './container';
import { createTimeZoneWatcher } from './timeZoneWatcher';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000011');

describe('createTimeZoneWatcher (T-11, critère 6)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());
  const container = () => createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: createManualClock(0), deviceId: DEVICE }), data: db.data });

  it('premier lancement : enregistre le fuseau sans signaler de changement', async () => {
    const onChange = vi.fn();
    const onCurrent = vi.fn();
    const watcher = createTimeZoneWatcher(container(), { detect: () => 'Europe/Paris', onChange, onCurrent });
    await watcher.check();
    expect(await db.data.repos.settings.get('general.timeZone')).toBe('Europe/Paris');
    expect(onCurrent).toHaveBeenCalledWith('Europe/Paris');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('changement : met à jour general.timeZone et notifie (N-06) ; stable : rien', async () => {
    let zone = 'Europe/Paris';
    const onChange = vi.fn();
    const watcher = createTimeZoneWatcher(container(), { detect: () => zone, onChange });
    await watcher.check();
    await watcher.check();
    expect(onChange).not.toHaveBeenCalled();
    zone = 'Africa/Tunis';
    await watcher.check();
    expect(await db.data.repos.settings.get('general.timeZone')).toBe('Africa/Tunis');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ previous: 'Europe/Paris', current: 'Africa/Tunis' });
  });

  it('détection impossible ou base en échec : ne rejette jamais', async () => {
    await expect(createTimeZoneWatcher(container(), { detect: () => null }).check()).resolves.toBeUndefined();
    const broken = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: createManualClock(0), deviceId: DEVICE }),
      data: { ...db.data, repos: { ...db.data.repos, settings: { ...db.data.repos.settings, get: () => Promise.reject(new Error('boom')) } } },
    });
    await expect(createTimeZoneWatcher(broken, { detect: () => 'Europe/Paris' }).check()).resolves.toBeUndefined();
  });

  it('une erreur du point d’extension est absorbée', async () => {
    let zone = 'Europe/Paris';
    const watcher = createTimeZoneWatcher(container(), { detect: () => zone, onChange: () => Promise.reject(new Error('N-06')) });
    await watcher.check();
    zone = 'Africa/Tunis';
    await expect(watcher.check()).resolves.toBeUndefined();
  });
});
