import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newerDevices } from '../../../src/domain/sync/compat';
import { newerDeviceText } from '../../../src/features/sync/syncText';
import { t } from '../../../src/i18n';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { makeNewerDevice, NEXT_SV, TEST_COLUMN, upgradeDevice } from '../../sim/syncVersions';

/**
 * I-06 critère 7 : Y-07 juste entre le PC et l'iPhone, chacun publiant son VRAI numéro d'application (fin du `0.0.0` de l'iPhone).
 * PC 0.2.3 et iPhone 0.3.0 (migration additive) ; puis l'inverse ; puis la même version.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function pcAndPhone(): Promise<{ pc: SimDevice; phone: SimDevice }> {
  const pc = await createSimDevice(PC_ID, { name: 'PC', appVersion: '0.2.3' });
  const phone = await createSimDevice(PHONE_ID, { name: 'iPhone', clock: pc.clock, appVersion: '0.2.3', devicePlatform: 'ios' });
  devices = [pc, phone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, phone);
  await phone.cycle();
  syncFolders(devices);
  pc.clock.advance(1_000);
  await pc.cycle();
  syncFolders(devices);
  await phone.cycle();
  return { pc, phone };
}

describe('Y-07 entre PC et iPhone avec les numéros publiés (critère 7)', () => {
  it('iPhone mis à jour d’abord (0.3.0, sv +1) : le PC lit, garde le champ inconnu, montre le numéro réel de l’iPhone ; après la mise à jour du PC, plus rien et rien de perdu', async () => {
    const { pc, phone } = await pcAndPhone();
    const values = new Map<string, string>();
    makeNewerDevice(phone, { appVersion: '0.3.0', devicePlatform: 'ios', xFor: (id) => values.get(id) ?? null });
    await phone.cycle();
    syncFolders(devices);
    await pc.cycle();
    const task = await phone.createTask('Créée sur l’iPhone 0.3.0');
    values.set(task.id, 'champ de la version suivante');
    pc.clock.advance(1_000);
    await phone.cycle();
    syncFolders(devices);
    const status = await pc.cycle();

    expect((await pc.task(task.id))?.title).toBe('Créée sur l’iPhone 0.3.0');
    expect(await pc.driver.select('SELECT field, sv FROM sync_unknown')).toEqual([{ field: TEST_COLUMN, sv: NEXT_SV }]);
    const iphone = status.devices.find((d) => d.deviceId === PHONE_ID);
    expect(iphone).toMatchObject({ platform: 'ios', newer: 'schema', appVersion: '0.3.0' });
    // Bandeau « Mettez à jour l'app » (startSync : `newerDevices` non vide) et ligne de Détails avec le numéro PUBLIÉ par l'iPhone.
    const newer = newerDevices(status.devices);
    expect(newer.map((d) => d.deviceId)).toEqual([PHONE_ID]);
    expect(newerDeviceText(newer[0] as (typeof newer)[number], status.devices)).toBe(t('sync.version.newerWithVersion', { device: t('sync.status.deviceIphone'), version: '0.3.0' }));
    expect(newerDeviceText(newer[0] as (typeof newer)[number], status.devices)).not.toContain('0.0.0');

    // « Mise à jour » du PC : catalogue étendu, migration rejouée, même sv et même numéro publiés.
    expect(await upgradeDevice(pc)).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    makeNewerDevice(pc, { appVersion: '0.3.0' });
    const after = await pc.cycle();
    expect(newerDevices(after.devices)).toEqual([]);
    expect(await pc.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [task.id])).toEqual([{ x: 'champ de la version suivante' }]);
    expect(await pc.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await pc.driver.select('SELECT * FROM sync_unknown')).toEqual([]);
  });

  it('cas inverse (PC en avance, iPhone en retard) : aucun bandeau côté PC, bandeau côté iPhone avec le numéro du PC', async () => {
    const { pc, phone } = await pcAndPhone();
    makeNewerDevice(pc, { appVersion: '0.3.0' });
    await pc.cycle();
    syncFolders(devices);
    const onPhone = await phone.cycle();
    syncFolders(devices);
    const onPc = await pc.cycle();
    expect(newerDevices(onPc.devices)).toEqual([]);
    const newer = newerDevices(onPhone.devices);
    expect(newer.map((d) => d.deviceId)).toEqual([PC_ID]);
    expect(newerDeviceText(newer[0] as (typeof newer)[number], onPhone.devices)).toBe(t('sync.version.newerWithVersion', { device: t('sync.status.devicePc'), version: '0.3.0' }));
  });

  it('même version : aucune ligne « version » d’un côté comme de l’autre ; chaque appareil voit le numéro réel de l’autre', async () => {
    const { pc, phone } = await pcAndPhone();
    pc.clock.advance(1_000);
    syncFolders(devices);
    const onPc = await pc.cycle();
    syncFolders(devices);
    const onPhone = await phone.cycle();
    expect(newerDevices(onPc.devices)).toEqual([]);
    expect(newerDevices(onPhone.devices)).toEqual([]);
    expect(onPc.devices.find((d) => d.deviceId === PHONE_ID)?.appVersion).toBe('0.2.3');
    expect(onPhone.devices.find((d) => d.deviceId === PC_ID)?.appVersion).toBe('0.2.3');
  });
});

describe('numéro illisible publié par l’autre appareil', () => {
  it('« unknown » (I-06) et « 0.0.0 » (anciennes versions de l’iPhone) : « version inconnue », jamais le numéro brut', () => {
    const devicesList = [{ platform: 'ios' as const }];
    for (const raw of ['unknown', '0.0.0']) {
      const text = newerDeviceText({ deviceId: PHONE_ID as never, platform: 'ios', appVersion: raw }, devicesList);
      expect(text).toBe(t('sync.version.newerWithVersion', { device: t('sync.status.deviceIphone'), version: t('sync.version.unknownVersion') }));
      expect(text).not.toContain(raw);
    }
  });
});
