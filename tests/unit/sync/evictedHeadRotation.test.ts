import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSimDevice, SCHEMA_VERSION, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { publishOutbox } from '../../../src/sync/publisher';
import { META, readJson } from '../../../src/sync/meta';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { toSyncError } from '../../../src/platform/sync/tauriSync';
import type { SyncDeps } from '../../../src/sync/deps';
import { MAX_FILE_NUMBER, type DeviceAck } from '../../../src/domain/sync/format';
import { parsePublishRotation } from '../../../src/domain/sync/publishRotation';
import { armCrash } from '../../sim/syncCrash';
import { SyncStateUnreadableError } from '../../../src/domain/sync/stored';

const SELF = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let d: SimDevice;
let deps: SyncDeps;
let head: DeviceAck;
beforeAll(warmSimDevices);
async function prepare() {
  d = await createSimDevice(SELF, { devicePlatform: 'ios' });
  await setupFirst(d);
  await d.cycle();
  await d.createTask('Avant éviction');
  await d.cycle();
  const savedHead = await readJson<DeviceAck>(d.data.repos, META.head);
  if (!savedHead) throw new Error('tête absente');
  head = savedHead;
  expect(head.segment).toBeGreaterThan(0);
  await d.createTask('Après éviction');
  deps = { data: d.data, platform: d.platform, deviceId: d.id, devicePlatform: d.devicePlatform, hlc: d.hlc, clock: d.clock, logger: d.logger, sv: SCHEMA_VERSION, appVersion: '0.3.3' };
}
beforeEach(prepare);
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
      { id: 'hydrate-head', op: 'hydrate', file: `devices/${SELF}/${file}`, nth: 1, effect: 'download-error' },
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

  it('l’écriture aboutit localement quand tous les accès de lecture et d’hydratation sont muets', async () => {
    const file = `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`;
    d.folder.setAvailability(d.id, file, 'cloud');
    d.folder.armFaults({ name: 'hors-ligne-ecriture', faults: [
      { id: 'no-read', op: 'read', file: 'devices/*', nth: 1, effect: 'mute' },
      { id: 'no-hydrate', op: 'hydrate', file: 'devices/*', nth: 1, effect: 'mute' },
    ] });
    const result = await publishOutbox(deps, head.epoch, head, head.segment);
    expect(result.error).toBeNull();
    expect(result.head.segment).toBe(head.segment + 1);
    expect(d.folder.unfiredFaults()).toEqual(['no-read', 'no-hydrate']);
    expect(await d.data.repos.sync.readOutbox()).toEqual([]);
  });

  it('un résultat incertain pendant l’écriture ne déclenche aucune rotation', async () => {
    const calls: number[] = [];
    deps = { ...deps, platform: { ...d.platform, appendJournal: (r) => { calls.push(r.segment); return Promise.reject(new SyncPlatformError('cloud-pending')); } } };
    const outcome = await publishOutbox(deps, head.epoch, head, head.segment);
    expect(outcome.error).toBe('cloud-pending');
    expect(calls).toEqual([head.segment]);
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
  });

  it('le plafond d’une rotation couvre tous les lots et garde un échec du lot suivant', async () => {
    for (let i = 0; i < 12; i += 1) await d.createTask(`Lot ${String(i)}`, { note: 'x'.repeat(120_000) });
    const append = d.platform.appendJournal.bind(d.platform);
    const calls: number[] = [];
    deps = { ...deps, platform: { ...d.platform, appendJournal: async (request) => {
      calls.push(request.segment);
      if (calls.length !== 2) throw unavailable();
      return append(request);
    } } };
    const result = await publishOutbox(deps, head.epoch, head, head.segment);
    expect(result.published).toBeGreaterThan(0);
    expect(result.error).toBe('cloud-pending');
    expect(calls).toEqual([head.segment, head.segment + 1, head.segment + 1]);
    const failure = JSON.parse((await d.data.repos.sync.getMeta('publishRotation')) ?? 'null') as unknown;
    expect(failure).toMatchObject({ segment: head.segment + 1, code: 'cloud-pending' });
  });

  it('reprend une intention après arrêt entre ajout au nouveau segment et retrait de la file', async () => {
    const evict = () => d.folder.setAvailability(d.id, `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`, 'cloud');
    evict();
    const count = armCrash(d, null);
    const append = d.platform.appendJournal.bind(d.platform);
    let rank = 0;
    d.platform.appendJournal = async (request) => {
      const result = await append(request);
      if (result.head.segment > head.segment) rank = count.writes + 1;
      return result;
    };
    await publishOutbox(deps, head.epoch, head, head.segment);
    count.disarm();
    expect(rank).toBeGreaterThan(0);
    await d.close();
    await prepare();
    evict();
    const crash = armCrash(d, rank);
    await expect(publishOutbox(deps, head.epoch, head, head.segment)).rejects.toThrow('arrêt simulé');
    expect(crash.crashed).toBe(true);
    crash.disarm();
    expect(await d.data.repos.sync.getMeta(META.inflight)).not.toBeNull();
    await d.restart();
    await d.cycle();
    const resumed = await readJson<DeviceAck>(d.data.repos, META.head);
    expect(resumed?.segment).toBe(head.segment + 1);
    expect(await d.data.repos.sync.readOutbox()).toEqual([]);
    expect(await d.data.repos.sync.getMeta(META.inflight)).toBeNull();
    expect(await d.data.repos.sync.getMeta('publishRotation')).toBeNull();
    expect(d.folder.fileNames(d.id).filter((name) => name.endsWith('.ctj'))).toHaveLength(2);
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

  it('la cause permanente reste mémorisée puis disparaît seulement quand la cible est publiée', async () => {
    let count = 0;
    const failed = { ...deps, platform: { ...d.platform, appendJournal: () => Promise.reject(++count === 1 ? unavailable() : new SyncPlatformError('io')) } };
    expect((await publishOutbox(failed, head.epoch, head, head.segment)).error).toBe('io');
    expect(JSON.parse((await d.data.repos.sync.getMeta('publishRotation')) ?? 'null')).toMatchObject({ code: 'io' });
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
    expect((await publishOutbox(deps, head.epoch, head, head.segment)).error).toBeNull();
    expect(await d.data.repos.sync.getMeta('publishRotation')).toBeNull();
    expect(await d.data.repos.sync.readOutbox()).toEqual([]);
  });

  it('un mémo illisible est conservé et remonte au cycle', async () => {
    await d.data.repos.sync.setMeta('publishRotation', '{bad');
    await expect(publishOutbox(deps, head.epoch, head, head.segment)).rejects.toBeInstanceOf(SyncStateUnreadableError);
    expect(await d.data.repos.sync.getMeta('publishRotation')).toBe('{bad');
  });

  it('un refus du stockage empêche la tentative sur la cible et garde la file', async () => {
    let calls = 0;
    const setMeta = d.data.repos.sync.setMeta.bind(d.data.repos.sync);
    d.data.repos.sync.setMeta = (key, value) => key === 'publishRotation' ? Promise.reject(new Error('disk full')) : setMeta(key, value);
    const failed = { ...deps, platform: { ...d.platform, appendJournal: () => { calls += 1; return Promise.reject(unavailable()); } } };
    await expect(publishOutbox(failed, head.epoch, head, head.segment)).rejects.toThrow('disk full');
    expect(calls).toBe(1);
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
  });

  it('la limite des numéros ne produit ni cible invalide ni mémo illisible', async () => {
    const names = d.folder.fileNames(d.id);
    d.folder.setAvailability(d.id, `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`, 'cloud');
    const result = await publishOutbox(deps, head.epoch, head, MAX_FILE_NUMBER);
    expect(result.error).toBe('folder-too-large');
    expect(d.folder.fileNames(d.id)).toEqual(names);
    const raw = await d.data.repos.sync.getMeta('publishRotation');
    expect(parsePublishRotation(raw)).toMatchObject({ segment: head.segment, code: 'folder-too-large' });
    expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
  });

  it('la borne protège aussi une cible persistée qui devient pleine', async () => {
    const refused = { ...deps, platform: { ...d.platform, appendJournal: () => Promise.reject(unavailable()) } };
    await publishOutbox(refused, head.epoch, head, head.segment);
    const full = { ...deps, platform: { ...d.platform, appendJournal: () => Promise.reject(new SyncPlatformError('segment-full')) } };
    expect((await publishOutbox(full, head.epoch, head, MAX_FILE_NUMBER)).error).toBe('folder-too-large');
    expect(parsePublishRotation(await d.data.repos.sync.getMeta('publishRotation'))).toMatchObject({ segment: head.segment + 1, code: 'folder-too-large' });
  });

  it('une tête vide reprend sa cible persistée même si le maximum listé a augmenté', async () => {
    const calls: number[] = [];
    const empty = { ...head, segment: 0, record: 0, hlc: null };
    const refused = { ...deps, platform: { ...d.platform, appendJournal: (r: { segment: number }) => { calls.push(r.segment); return Promise.reject(unavailable()); } } };
    await publishOutbox(refused, head.epoch, empty, 1);
    await publishOutbox(refused, head.epoch, empty, 4);
    expect(calls).toEqual([2, 3, 3]);
    expect(parsePublishRotation(await d.data.repos.sync.getMeta('publishRotation'))).toMatchObject({ segment: 3 });
  });
});
