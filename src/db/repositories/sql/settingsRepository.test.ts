import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSetting } from '../../../domain/model';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000006');

describe('SettingsRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('get renvoie la valeur par défaut tant que la clé est absente', async () => {
    expect(await db.data.repos.settings.get('general.theme')).toBe(defaultSetting('general.theme'));
    expect(await db.data.repos.settings.get('spaces.filter')).toBe('all');
  });

  it('set puis get relit la valeur écrite (round-trip JSON)', async () => {
    await db.data.repos.settings.set('general.theme', 'dark');
    expect(await db.data.repos.settings.get('general.theme')).toBe('dark');

    await db.data.repos.settings.set('reminders.morningRecap', { enabled: false, time: '07:30' as never });
    expect(await db.data.repos.settings.get('reminders.morningRecap')).toEqual({ enabled: false, time: '07:30' });
  });

  it('set met à jour la même ligne (upsert) sans dupliquer la clé', async () => {
    await db.data.repos.settings.set('general.theme', 'dark');
    db.clock.advance(1000);
    await db.data.repos.settings.set('general.theme', 'light');
    const rows = await db.driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key = 'general.theme'");
    expect(rows[0]?.n).toBe(1);
    expect(await db.data.repos.settings.get('general.theme')).toBe('light');
  });

  it('getAll fournit toutes les clés connues, par défaut ou en base', async () => {
    await db.data.repos.settings.set('general.theme', 'dark');
    const all = await db.data.repos.settings.getAll();
    expect(all['general.theme']).toBe('dark');
    expect(all['tasks.carryOverUndone']).toBe(defaultSetting('tasks.carryOverUndone'));
  });
});

describe('SyncMetaRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('maxHlc ignore les lignes posées par la migration (hlc graine) tant que rien n’a été écrit localement', async () => {
    // La seule donnée en base est le seed des espaces Pro/Perso, hlc "zéro".
    const seedMax = await db.data.repos.syncMeta.maxHlc();
    expect(seedMax).not.toBeNull();
    expect(seedMax?.startsWith('000000000000000')).toBe(true);
  });

  it('maxHlc augmente après une écriture et couvre toutes les tables synchronisées', async () => {
    const before = await db.data.repos.syncMeta.maxHlc();
    await db.data.repos.settings.set('general.theme', 'dark');
    const afterSettings = await db.data.repos.syncMeta.maxHlc();
    expect(afterSettings && before && afterSettings > before).toBe(true);
  });
});
