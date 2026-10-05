import { afterEach, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * Synchro manuelle avec le vrai moteur (ADR 0011, sections 10.1 et 11.2 ; Y-03 critères 2, 3 et 7, Y-02 critère 1) : un seul cycle à la
 * fois, une seule demande de plus quel que soit le nombre de touches, `syncNow` ne rejette jamais, chaque appel journalise sa raison
 * sans contenu ni chemin. Le cycle en cours est retenu sur l'appel réel `scan` jusqu'à ce que le test le libère : aucun délai.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

/** Retient le prochain `scan` jusqu'à `release()` ; `entered` se résout quand le cycle y est arrivé. */
function holdScan(device: SimDevice): { entered: Promise<void>; release: () => void; scans: () => number } {
  const real = device.platform.scan.bind(device.platform);
  let count = 0;
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  device.platform.scan = async (request) => {
    count += 1;
    if (count === 1) {
      enter();
      await gate;
    }
    return real(request);
  };
  return { entered, release, scans: () => count };
}

describe('un seul cycle à la fois (Y-03 critère 3, Y-02 critère 1)', () => {
  it('cinq touches (Réglages et zone de notification) pendant un cycle : aucun cycle parallèle, un seul cycle de plus à la fin', async () => {
    const [a] = await twoDevices();
    const gate = holdScan(a);
    const first = a.service.syncNow('manual');
    await gate.entered;
    const more = [a.service.syncNow('manual'), a.service.syncNow('tray'), a.service.syncNow('manual'), a.service.syncNow('tray'), a.service.syncNow('manual')];
    expect(gate.scans(), 'aucun second cycle ne démarre pendant le premier').toBe(1);
    gate.release();
    await Promise.all([first, ...more]);
    expect(gate.scans(), 'le premier cycle et un seul de plus').toBe(2);
    expect(a.service.status().phase).toBe('idle');
  });

  it('une demande arrivée pendant le cycle voit les écritures faites entre-temps (le cycle de plus les publie)', async () => {
    const [a, b] = await twoDevices();
    const gate = holdScan(a);
    const first = a.service.syncNow('manual');
    await gate.entered;
    const t = await a.createTask('Écrite pendant le cycle');
    const second = a.service.syncNow('tray');
    gate.release();
    await Promise.all([first, second]);
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Écrite pendant le cycle');
  });
});

describe('résultat et journal (Y-03 critères 2 et 7)', () => {
  it('syncNow ne rejette jamais, même si la plateforme échoue ; l’état porte l’erreur et le bouton peut relancer', async () => {
    const [a] = await twoDevices();
    const real = a.platform.scan.bind(a.platform);
    a.platform.scan = () => Promise.reject(new SyncPlatformError('cloud-provider-stopped'));
    await expect(a.service.syncNow('manual')).resolves.toBeUndefined();
    expect(a.service.status().phase).toBe('error');
    expect(a.service.status().errorCode).toBe('cloud-provider-stopped');
    a.platform.scan = () => Promise.reject(new Error('panne inattendue avec un chemin C:\\Users\\Ali\\iCloudDrive'));
    await expect(a.service.syncNow('tray')).resolves.toBeUndefined();
    expect(a.service.status().phase).toBe('error');
    a.platform.scan = real;
    await a.service.syncNow('manual');
    expect(a.service.status().phase).toBe('idle');
  });

  it('chaque appel journalise sa raison (manual ou tray), sans contenu ni chemin', async () => {
    const [a] = await twoDevices();
    await a.createTask('Titre confidentiel');
    a.platform.scan = () => Promise.reject(new Error('échec sur C:\\Users\\Ali\\iCloudDrive\\CircleTasks'));
    await a.service.syncNow('manual');
    await a.service.syncNow('tray');
    const logged = a.logger.entries.filter((e) => e.event === 'sync-now');
    expect(logged.slice(-2).map((e) => e.detail)).toEqual([{ reason: 'manual' }, { reason: 'tray' }]);
    const everything = JSON.stringify(a.logger.entries);
    expect(everything).not.toContain('confidentiel');
    expect(everything).not.toContain('Users');
    expect(everything).not.toContain('iCloudDrive');
  });
});
