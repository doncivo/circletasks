import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId, type LocalTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createSettingsUseCases } from './settingsUseCases';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000c5');

describe('cas d’usage des réglages (T-06, A-03, A-06, N-04, D-02, ES-03)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  it('lit les valeurs par défaut puis celles enregistrées', async () => {
    const useCases = createSettingsUseCases(db);
    expect(await useCases.load()).toEqual({
      carryOverUndone: true,
      hideRoutines: false,
      recaps: { morning: { enabled: true, time: '07:30' }, evening: { enabled: true, time: '21:00' } },
    });
    await useCases.setCarryOverUndone(false);
    await useCases.setHideRoutines(true);
    const recaps = { morning: { enabled: false, time: '08:00' as LocalTime }, evening: { enabled: true, time: '22:15' as LocalTime } };
    await useCases.saveRecaps(recaps);
    expect(await useCases.load()).toEqual({ carryOverUndone: false, hideRoutines: true, recaps });
  });

  it('vue compacte : seul l’écran visé change', async () => {
    const useCases = createSettingsUseCases(db);
    await useCases.setCompactView('routines', true);
    await useCases.setCompactView('someday', true);
    await useCases.setCompactView('routines', false);
    expect(await db.data.repos.settings.get('view.compact')).toEqual({ today: false, routines: false, checklists: false, someday: true });
  });

  it('miroir du démarrage Windows et filtre d’espace', async () => {
    const useCases = createSettingsUseCases(db);
    await useCases.setLaunchAtStartupMirror(true);
    expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(true);
    await useCases.syncLaunchAtStartupMirror(false);
    expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(false);
    await useCases.saveSpaceFilter('all');
    expect(await db.data.repos.settings.get('spaces.filter')).toBe('all');
  });

  it('n’écrit pas le miroir quand il est déjà aligné, et rejette quand la base échoue', async () => {
    let writes = 0;
    const settings = { get: () => Promise.resolve(true), set: () => Promise.resolve(void writes++) };
    await createSettingsUseCases({ data: { repos: { settings } } } as never).syncLaunchAtStartupMirror(true);
    expect(writes).toBe(0);
    const broken = { data: { repos: { settings: { get: () => Promise.reject(new Error('boom')), set: () => Promise.reject(new Error('boom')) } } } } as never;
    await expect(createSettingsUseCases(broken).setCompactView('today', true)).rejects.toThrow('boom');
    await expect(createSettingsUseCases(broken).saveSpaceFilter('all')).rejects.toThrow('boom');
  });
});
