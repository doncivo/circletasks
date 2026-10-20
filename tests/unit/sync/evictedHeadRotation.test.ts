import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSimDevice, SCHEMA_VERSION, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { publishOutbox } from '../../../src/sync/publisher';
import { META, readJson } from '../../../src/sync/meta';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { toSyncError } from '../../../src/platform/sync/tauriSync';
import type { SyncDeps } from '../../../src/sync/deps';
import type { DeviceAck } from '../../../src/domain/sync/format';

const SELF = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let d: SimDevice;
let deps: SyncDeps;
let head: DeviceAck;
beforeAll(warmSimDevices);
beforeEach(async () => {
  d = await createSimDevice(SELF, { devicePlatform: 'ios' });
  await setupFirst(d);
  await d.createTask('Avant éviction');
  await d.cycle();
  head = (await readJson<DeviceAck>(d.data.repos, META.head))!;
  await d.createTask('Après éviction');
  deps = { data: d.data, platform: d.platform, deviceId: d.id, devicePlatform: d.devicePlatform, hlc: d.hlc, clock: d.clock, logger: d.logger, sv: SCHEMA_VERSION, appVersion: '0.3.3' };
});
afterEach(async () => { await d.close(); });
const unavailable = () => Object.assign(new SyncPlatformError('cloud-pending'), { appendBeforeWrite: true });

describe('Y-IOS-07 : rotation locale et origine du refus', () => {
  it('le refus IPC garde uniquement la preuve fixe de refus avant écriture', () => {
    expect(toSyncError({ code: 'cloud-pending', appendBeforeWrite: true, message: 'secret' })).toMatchObject({ code: 'cloud-pending', appendBeforeWrite: true });
    expect(toSyncError({ code: 'io', appendBeforeWrite: true })).not.toHaveProperty('appendBeforeWrite');
    expect(toSyncError({ code: 'cloud-pending', appendBeforeWrite: 'true' })).not.toHaveProperty('appendBeforeWrite');
  });

  it('ouvre max + 1 avec zéro attendu sans lire ni hydrater le segment évincé', async () => {
    const file = `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`;
    const before = d.folder.fileSize(d.id, file);
    d.folder.setAvailability(d.id, file, 'cloud');
    d.folder.armFaults({ name: 'aucune-lecture-pour-ecrire', faults: [
      { id: 'read-head', op: 'read', file: `devices/${SELF}/${file}`, nth: 1, effect: 'error', code: 'io' },
      { id: 'hydrate-head', op: 'hydrate', file: `devices/${SELF}/${file}`, nth: 1, effect: 'error', code: 'io' },
    ] });
    const outcome = await publishOutbox(deps, head.epoch, head, 7);
    expect(outcome.error).toBeNull();
    expect(outcome.head.segment).toBe(8);
    expect(outcome.head.record).toBeGreaterThan(0);
    expect(await d.data.repos.sync.readOutbox()).toEqual([]);
    expect(d.folder.fileSize(d.id, file)).toBe(before);
    expect(d.folder.availabilityOf(d.id, file)).toBe('cloud');
    expect(d.folder.unfiredFaults()).toEqual(['read-head', 'hydrate-head']);
  });

  it('dix cycles refusés réutilisent la même cible, gardent la file et ne créent aucun fichier', async () => {
    const calls: number[] = [];
    const names = d.folder.fileNames(d.id);
    deps = { ...deps, platform: { ...d.platform, appendJournal: (r) => { calls.push(r.segment); return Promise.reject(unavailable()); } } };
    for (let cycle = 0; cycle < 10; cycle += 1) await publishOutbox(deps, head.epoch, head, head.segment);
    expect(calls.slice(0, 2)).toEqual([head.segment, head.segment + 1]);
    expect(calls.slice(2)).toEqual(Array.from({ length: 9 }, () => head.segment + 1));
    expect(d.folder.fileNames(d.id)).toEqual(names);
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
    expect(await d.data.repos.sync.getMeta('publishRotation')).not.toBeNull();
  });

  it('un résultat incertain pendant l’écriture ne déclenche aucune rotation', async () => {
    const calls: number[] = [];
    deps = { ...deps, platform: { ...d.platform, appendJournal: (r) => { calls.push(r.segment); return Promise.reject(new SyncPlatformError('cloud-pending')); } } };
    const outcome = await publishOutbox(deps, head.epoch, head, head.segment);
    expect(outcome.error).toBe('cloud-pending');
    expect(calls).toEqual([head.segment]);
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
  });

  it('un échec de rotation reste visible au redémarrage avant tout nouveau cycle', async () => {
    deps = { ...deps, platform: { ...d.platform, appendJournal: () => Promise.reject(unavailable()) } };
    await publishOutbox(deps, head.epoch, head, head.segment);
    await d.restart();
    if (d.service.status().errorCode !== 'cloud-pending') {
      await new Promise<void>((resolve) => {
        const stop = d.service.subscribe(() => { if (d.service.status().errorCode === 'cloud-pending') { stop(); resolve(); } });
      });
    }
    expect(d.service.status().phase).toBe('waiting-icloud');
    expect(d.service.status().errorCode).toBe('cloud-pending');
  });
});
