import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import type { DeviceId, TaskId } from '../../../../src/domain/types';
import type { EpochId } from '../../../../src/domain/sync/format';
import { LOG_MASK, sanitizeLogDetail } from '../../../../src/platform/logs/sanitize';
import { SyncPlatformError, type FolderScan, type SyncPlatform } from '../../../../src/platform/sync/types';
import { createSyncService, HIDE_SYNC_DEADLINE_MS } from '../../../../src/sync';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : publication bloquée pour toujours par l'instantané d'une orpheline resté dans iCloud alors que
 * le mémo `sync_meta.orphanEpoch` a été perdu. État réel de la séance 0.3.2 du 2026-10-16 : l'iPhone `ef50…` suit l'époque du PC
 * `e0001-56d4…`, lit son journal, n'a jamais publié d'état (`stateSeq` 0), `orphanEpoch` nul, et `devices/ef50…/e0001-ef50…/s-00000001.cts`
 * est le seul fichier de son dossier. Horloge injectée, faux dossier en mémoire, aucun délai réel.
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PC_EPOCH = `e0001-${A_ID}` as EpochId;
const ORPHAN = `e0001-${B_ID}` as EpochId;

let devices: SimDevice[] = [];
// Coût unique (SQLite Wasm et migrations de la base modèle) payé hors du budget du premier test.
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Service de l'iPhone sur une plateforme truquée (même base, même horloge). */
function withPlatform(b: SimDevice, platform: SyncPlatform): void {
  b.service = createSyncService({
    data: b.data, platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, devicePlatform: b.devicePlatform, sv: SCHEMA_VERSION, appVersion: '0.3.2', logger: b.logger,
    setTimeout: () => 0, clearTimeout: () => undefined,
  });
}

/** Listing de son propre dossier modifié (listing iCloud transitoire ou incomplet). */
function alterOwnListing(b: SimDevice, alter: (epochs: FolderScan['devices'][number]['epochs']) => FolderScan['devices'][number]['epochs']): SyncPlatform['scan'] {
  return async (request) => {
    const scan = await b.platform.scan(request);
    return { ...scan, devices: scan.devices.map((d) => (d.deviceId === b.id ? { ...d, epochs: alter(d.epochs) } : d)) };
  };
}

/** Époque `ef50` ouverte par l'iPhone (0.2.3) : instantané 1 de sa base, `sync_meta` comme après `epoch-opened`, aucun état. */
async function seedOrphan(b: SimDevice): Promise<void> {
  await b.platform.bindDevice(b.id);
  await b.platform.writeSnapshot({ epoch: ORPHAN, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + ORPHAN + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
  await b.data.repos.sync.clearOutbox(await b.data.repos.sync.maxOutboxSeq());
  await b.data.repos.sync.setMeta('epoch', JSON.stringify(ORPHAN));
  await b.data.repos.sync.setMeta('head', JSON.stringify({ epoch: ORPHAN, segment: 0, record: 0, hlc: null, stateSeq: 0 }));
  await b.data.repos.sync.setMeta('snapshot', JSON.stringify({ epoch: ORPHAN, seq: 1, endHlc: b.hlc.now() }));
  await b.restart();
}

/**
 * Reproduit l'état de la séance : abandon de l'orpheline et arrivée dans `56d4` faits (journal du PC lu), état jamais écrit (cycle
 * interrompu avant `state.ctx` et avant tout segment), puis mémo `orphanEpoch` effacé alors que `s-00000001.cts` reste dans le dossier.
 */
async function aliState(memo: 'lost' | 'kept' = 'lost'): Promise<{ a: SimDevice; b: SimDevice; testPc: TaskId; localIphone: TaskId }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  for (let i = 0; i < 3; i += 1) await a.createTask(`Tâche PC ${String(i)}`);
  await a.cycle();
  const testPc = (await a.createTask('Test Pc')).id as TaskId;
  await a.cycle();
  await pair(a, b);
  a.clock.advance(3_600_000);
  await a.updateTask(testPc, { carriedOver: true });
  await a.cycle();
  const localIphone = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
  await seedOrphan(b);
  propagate(a.folder, b.folder, a.id);
  // Premier cycle 0.2.3/0.3.0 : abandon, arrivée dans 56d4 et lecture faits ; ni segment ni état écrits (cycle interrompu).
  withPlatform(b, {
    ...b.platform,
    appendJournal: () => Promise.reject(new SyncPlatformError('io')),
    writeState: () => Promise.reject(new SyncPlatformError('io')),
  });
  await b.cycle();
  await b.restart();
  expect(b.logger.entries.some((e) => e.event === 'epoch-abandoned')).toBe(true);
  expect((await b.task(testPc))?.carriedOver).toBe(true);
  if (memo === 'lost') await b.data.repos.sync.setMeta('orphanEpoch', null);
  // État exact constaté sur l'iPhone.
  expect(await b.data.repos.sync.getMeta('epoch')).toBe(JSON.stringify(PC_EPOCH));
  expect(JSON.parse((await b.data.repos.sync.getMeta('orphanEpoch')) ?? 'null')).toEqual(memo === 'lost' ? null : { epoch: ORPHAN });
  expect(JSON.parse((await b.data.repos.sync.getMeta('stateSeq')) ?? '0') ?? 0).toBe(0);
  const own = b.folder.devices.get(b.id);
  expect(own?.state ?? null).toBeNull();
  expect([...(own?.epochs.keys() ?? [])]).toEqual([ORPHAN]);
  expect([...(own?.epochs.get(ORPHAN)?.snapshots.keys() ?? [])]).toEqual([1]);
  expect(own?.epochs.get(ORPHAN)?.segments.size).toBe(0);
  propagate(b.folder, a.folder, b.id);
  b.logger.entries.length = 0;
  return { a, b, testPc, localIphone };
}

const events = (d: SimDevice, event: string): number => d.logger.entries.filter((e) => e.event === event).length;

async function converge(list: readonly SimDevice[], rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const d of list) {
      await d.cycle();
      syncFolders(list);
    }
  }
}

describe('Y-IOS-02-FIX-02 : état réel de la séance (critère 16)', () => {
  it('orphanEpoch nul et s-00000001.cts de ef50 listé seul : le cycle suivant réarme, supprime, publie, le PC lit l’iPhone, les tâches circulent dans les deux sens', async () => {
    const { a, b, testPc, localIphone } = await aliState();
    const status = await b.cycle();
    expect(status.phase).toBe('idle');
    expect(status.warnings ?? []).not.toContain('publish-blocked');
    expect(statusLine(status, b.clock.nowMs())).toContain('À jour');
    expect(events(b, 'publish-deferred')).toBe(0);
    const relisted = b.logger.entries.findIndex((e) => e.event === 'orphan-epoch-relisted');
    const deleted = b.logger.entries.findIndex((e) => e.event === 'orphan-epoch-deleted');
    expect(relisted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(relisted);
    expect(b.logger.entries[relisted]?.detail).toEqual({ epoch: ORPHAN.slice(0, 14) });
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
    expect((await b.platform.scan({ keep: [] })).devices.find((d) => d.deviceId === b.id)?.state?.epoch).toBe(PC_EPOCH);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    // Le PC a lu l'état de l'iPhone (ligne sync_state dans 56d4) et sa tâche.
    expect((await a.data.repos.sync.getStates()).find((r) => r.deviceId === b.id)?.epoch).toBe(PC_EPOCH);
    expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
    const fromPc = (await a.createTask('Nouvelle sur le PC')).id as TaskId;
    const fromIphone = (await b.createTask('Nouvelle sur l’iPhone')).id as TaskId;
    await converge([a, b]);
    expect((await b.task(fromPc))?.title).toBe('Nouvelle sur le PC');
    expect((await a.task(fromIphone))?.title).toBe('Nouvelle sur l’iPhone');
    expect((await b.task(testPc))?.carriedOver).toBe(true);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    // Plus rien à réarmer ni à supprimer ensuite.
    expect(events(b, 'orphan-epoch-relisted')).toBe(1);
    expect(events(b, 'publish-deferred')).toBe(0);
  });

  it('suppression en échec : l’iPhone publie quand même, orphan-epoch-delete-failed { code }, mémo gardé, retentée au cycle suivant et réussie', async () => {
    const { a, b, localIphone } = await aliState();
    let failing = true;
    withPlatform(b, { ...b.platform, deleteOwn: (files) => (failing && files.some((f) => f.kind === 'epoch') ? Promise.reject(new SyncPlatformError('io')) : b.platform.deleteOwn(files)) });
    const status = await b.cycle();
    expect(status.phase).toBe('idle');
    expect(status.warnings ?? []).not.toContain('publish-blocked');
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
    expect(b.logger.entries.find((e) => e.event === 'orphan-epoch-delete-failed')?.detail).toEqual({ code: 'io' });
    expect(JSON.parse((await b.data.repos.sync.getMeta('orphanEpoch')) ?? 'null')).toEqual({ epoch: ORPHAN });
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
    // Mémo posé : pas de second réarmement, la voie unique retente.
    await b.cycle();
    expect(events(b, 'orphan-epoch-delete-failed')).toBe(2);
    expect(events(b, 'orphan-epoch-relisted')).toBe(1);
    failing = false;
    await b.cycle();
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
  });

  it('interruption du cycle pendant la suppression : jamais comptée comme un échec, mémo gardé, reprise au cycle suivant', async () => {
    const { b } = await aliState();
    let stopped = false;
    b.service = createSyncService({
      data: b.data, platform: b.platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, devicePlatform: 'ios', sv: SCHEMA_VERSION, appVersion: '0.3.2', logger: b.logger,
      setTimeout: () => 0, clearTimeout: () => undefined,
      // Échéance du cycle `hide` atteinte exactement à la suppression de l'orpheline réarmée (unité `delete-own`).
      deadlineProbe: (unit) => {
        if (!stopped && unit === 'delete-own' && b.logger.entries.some((e) => e.event === 'orphan-epoch-relisted')) {
          stopped = true;
          b.clock.advance(HIDE_SYNC_DEADLINE_MS);
        }
      },
    });
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    expect(stopped).toBe(true);
    expect(JSON.parse((await b.data.repos.sync.getMeta('orphanEpoch')) ?? 'null')).toEqual({ epoch: ORPHAN });
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
    expect(events(b, 'orphan-epoch-delete-failed')).toBe(0);
    expect(events(b, 'orphan-epoch-relisted')).toBe(1);
    await b.restart();
    await b.cycle();
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
    expect(events(b, 'orphan-epoch-delete-failed')).toBe(0);
  });
});

describe('Y-IOS-02-FIX-02 : listing iCloud transitoire (critère 9)', () => {
  it('époque absente un cycle (mémo effacé par la règle existante, rien supprimé, rien perdu), présente le suivant : réarmée puis supprimée', async () => {
    const { a, b, localIphone } = await aliState('kept');
    withPlatform(b, { ...b.platform, scan: alterOwnListing(b, (epochs) => epochs.filter((e) => e.epoch !== ORPHAN)) });
    const first = await b.cycle();
    expect(first.warnings ?? []).not.toContain('publish-blocked');
    expect(events(b, 'orphan-epoch-cleared')).toBe(1);
    expect(events(b, 'orphan-epoch-deleted')).toBe(0);
    // Rien n'a été supprimé : le fichier est toujours dans le dossier.
    expect(b.folder.devices.get(b.id)?.epochs.get(ORPHAN)?.snapshots.has(1)).toBe(true);
    await b.restart();
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(1);
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
    await converge([a, b]);
    expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('listing incomplet de l’époque courante (segments cachés un cycle) : aucune suppression, rien perdu, publication reprise ensuite', async () => {
    const { a, b } = await aliState();
    await b.cycle();
    await b.createTask('Écrite après publication');
    await b.cycle();
    syncFolders(devices);
    const before = b.folder.devices.get(b.id)?.epochs.get(PC_EPOCH)?.segments.size ?? 0;
    expect(before).toBeGreaterThan(0);
    b.logger.entries.length = 0;
    withPlatform(b, { ...b.platform, scan: alterOwnListing(b, (epochs) => epochs.map((e) => ({ ...e, segments: [] }))) });
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.get(PC_EPOCH)?.segments.size).toBe(before);
    await b.restart();
    await converge([a, b]);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('Y-IOS-02-FIX-02 : non-régression du refus de publier', () => {
  it('instantané dans l’époque courante, sans état, sans accusé, stateSeq 0 (hors ouverture) : toujours refusé, cause réelle au journal', async () => {
    const { b } = await aliState();
    await b.platform.writeSnapshot({ epoch: PC_EPOCH, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + PC_EPOCH + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
    const status = await b.cycle();
    expect(status.warnings).toContain('publish-blocked');
    expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
    expect(b.folder.devices.get(b.id)?.state ?? null).toBeNull();
    const deferred = b.logger.entries.find((e) => e.event === 'publish-deferred');
    // L'instantané de l'orpheline (non courante, jamais annoncée) est ignoré, celui de l'époque courante compte.
    expect(deferred?.detail).toEqual({ reason: 'own-state-missing', state: 'missing', files: 1, ignored: 1, acks: 0, localSeq: 0 });
    // Son état n'est pas connu : rien n'est réarmé ni supprimé.
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
  });

  it('segment listé dans une ancienne époque, sans état : toujours refusé, aucune suppression', async () => {
    const { b } = await aliState();
    const old = `e0001-00000000-0000-4000-8000-000000000000` as EpochId;
    withPlatform(b, { ...b.platform, scan: alterOwnListing(b, (epochs) => [...epochs, { epoch: old, segments: [1], snapshots: [] }]) });
    const status = await b.cycle();
    expect(status.warnings).toContain('publish-blocked');
    expect(b.logger.entries.find((e) => e.event === 'publish-deferred')?.detail).toMatchObject({ reason: 'own-state-missing', files: 1, ignored: 1 });
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
  });

  it('état illisible ou dans le nuage : reason own-state-unknown avec son statut', async () => {
    const { b } = await aliState();
    withPlatform(b, {
      ...b.platform,
      scan: async (request) => {
        const scan = await b.platform.scan(request);
        return { ...scan, devices: scan.devices.map((d) => (d.deviceId === b.id ? { ...d, stateStatus: 'cloud-pending', state: null, epochs: [...d.epochs, { epoch: PC_EPOCH, segments: [1], snapshots: [] }] } : d)) };
      },
    });
    await b.cycle();
    expect(b.logger.entries.find((e) => e.event === 'publish-deferred')?.detail).toMatchObject({ reason: 'own-state-unknown', state: 'cloud-pending', files: 1, ignored: 1, acks: 0, localSeq: 0 });
  });
});

describe('Y-IOS-02-FIX-02 : format du journal (ADR 0014, critère 13)', () => {
  it('publish-deferred et orphan-epoch-relisted passent l’assainissement intacts (statuts et compteurs, époque tronquée, aucun chemin ni nom de fichier)', () => {
    const deferred = JSON.stringify({ reason: 'own-state-missing', state: 'missing', files: 0, ignored: 1, acks: 0, localSeq: 0 });
    expect(sanitizeLogDetail(`publish-deferred ${deferred}`)).toBe(`publish-deferred ${deferred}`);
    const relisted = JSON.stringify({ epoch: ORPHAN.slice(0, 14) });
    expect(sanitizeLogDetail(`orphan-epoch-relisted ${relisted}`)).toBe(`orphan-epoch-relisted ${relisted}`);
    expect(relisted).not.toContain('.cts');
    // Époque complète (42 caractères) : masquée à l'export, d'où la forme tronquée (limite des autres entrées notée dans docs/dettes.md).
    expect(sanitizeLogDetail(JSON.stringify({ epoch: ORPHAN }))).toBe(LOG_MASK);
  });
});

describe('Y-IOS-02-FIX-02 : garde-fous du réarmement (QA, critères 8, 10, 11, 13)', () => {
  it('critère 8 : pendant une réinitialisation lancée par l’appareil, un reste d’orpheline listé n’est ni réarmé ni supprimé', async () => {
    const { b } = await aliState();
    // Un cycle ordinaire publie l'état (la réinitialisation l'exige) et règle l'orpheline ; la réinitialisation démarre ensuite.
    await b.cycle();
    expect((await b.service.resetSync()).kind).toBe('started');
    expect(b.service.status().reset).toBeDefined();
    await b.data.repos.sync.setMeta('orphanEpoch', null);
    // Le listing iCloud montre un reste d'instantané seul dans une époque propre plus grande que l'époque courante (cas qui serait réarmé hors réinitialisation).
    const late = `e0009-${B_ID}` as EpochId;
    const deleted: unknown[] = [];
    withPlatform(b, {
      ...b.platform,
      scan: alterOwnListing(b, (epochs) => [...epochs, { epoch: late, segments: [], snapshots: [1] }]),
      deleteOwn: (files) => { deleted.push(files); return b.platform.deleteOwn(files); },
    });
    b.logger.entries.length = 0;
    await b.cycle();
    expect(b.service.status().reset).toBeDefined();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(events(b, 'orphan-epoch-deleted')).toBe(0);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect(JSON.stringify(deleted)).not.toContain(late);
  });

  it('critère 8 : un instantané seul dans le dossier d’un autre appareil n’est ni réarmé ni supprimé (écrivain unique)', async () => {
    const { a, b } = await aliState();
    // Orpheline de l'iPhone retirée : le dossier propre n'a plus rien à réarmer ; le PC porte un reste du même genre.
    b.folder.devices.get(b.id)?.epochs.delete(ORPHAN);
    await a.platform.bindDevice(a.id);
    const foreign = `e0009-${A_ID}` as EpochId;
    await a.platform.writeSnapshot({ epoch: foreign, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + foreign + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
    syncFolders(devices);
    const before = [...(a.folder.devices.get(a.id)?.epochs.get(foreign)?.snapshots.keys() ?? [])];
    expect(before).toEqual([1]);
    await b.cycle();
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(events(b, 'orphan-epoch-deleted')).toBe(0);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect([...(b.folder.devices.get(a.id)?.epochs.get(foreign)?.snapshots.keys() ?? [])]).toEqual(before);
  });

  it('critère 8 : une époque propre non courante avec un segment n’est jamais réarmée par le moteur (segment qui borne, rien supprimé)', async () => {
    const { b } = await aliState();
    await b.cycle();
    await b.data.repos.sync.setMeta('orphanEpoch', null);
    const own = b.folder.devices.get(b.id);
    expect(own?.epochs.get(ORPHAN)).toBeUndefined();
    withPlatform(b, { ...b.platform, scan: alterOwnListing(b, (epochs) => [...epochs, { epoch: ORPHAN, segments: [1], snapshots: [1] }]) });
    b.logger.entries.length = 0;
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(events(b, 'orphan-epoch-deleted')).toBe(0);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
  });

  it('critère 11 et 13 : les entrées réelles du journal sur le scénario de la séance ne contiennent ni chemin, ni nom de fichier, ni identifiant complet', async () => {
    const { b } = await aliState();
    withPlatform(b, { ...b.platform, deleteOwn: () => Promise.reject(new SyncPlatformError('io')) });
    await b.cycle();
    await b.platform.writeSnapshot({ epoch: PC_EPOCH, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + PC_EPOCH + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
    const text = JSON.stringify(b.logger.entries.filter((e) => ['orphan-epoch-relisted', 'orphan-epoch-delete-failed', 'publish-deferred'].includes(e.event)));
    expect(text).toContain('orphan-epoch-relisted');
    expect(text).not.toMatch(/\.cts|\.json|devices|\\|\/|s-0000/);
    expect(text).not.toContain(B_ID);
    expect(text).not.toContain(A_ID);
  });

  it('critère 11 : publish-deferred du scénario bloqué (instantané courant) porte uniquement statuts, compteurs et reason de la liste fermée', async () => {
    const { b } = await aliState();
    await b.platform.writeSnapshot({ epoch: PC_EPOCH, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + PC_EPOCH + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
    await b.cycle();
    const detail = b.logger.entries.find((e) => e.event === 'publish-deferred')?.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(['acks', 'files', 'ignored', 'localSeq', 'reason', 'state']);
    expect(['own-state-missing', 'own-state-unknown']).toContain(detail.reason);
    for (const key of ['acks', 'files', 'ignored', 'localSeq']) expect(typeof detail[key]).toBe('number');
  });

  it('critère 13 : une écriture de sync_meta qui échoue au réarmement n’est pas avalée (erreur visible, rien supprimé)', async () => {
    const { b } = await aliState();
    const sync = b.data.repos.sync;
    const original = sync.setMeta.bind(sync);
    sync.setMeta = (key: string, value: string | null) => (key === 'orphanEpoch' && value !== null ? Promise.reject(new Error('disk full')) : original(key, value));
    try {
      const status = await b.cycle();
      expect(status.phase).toBe('error');
      expect(events(b, 'orphan-epoch-relisted')).toBe(0);
      expect(events(b, 'orphan-epoch-deleted')).toBe(0);
      expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
    } finally {
      sync.setMeta = original;
    }
  });
});

const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
type ScanDevice = FolderScan['devices'][number];

/**
 * Scan de l'iPhone modifié : son propre listing (`own`), l'entrée du PC remplacée (`pc`), et un troisième appareil C authentifié dont l'état
 * est fabriqué depuis celui du PC (`third` : époque annoncée et accusés). Le dossier réel n'est jamais modifié.
 */
function scanWith(b: SimDevice, opts: { own?: (epochs: ScanDevice['epochs']) => ScanDevice['epochs']; third?: () => { epoch: EpochId; acks?: [DeviceId, EpochId][] } | null; pc?: (d: ScanDevice) => ScanDevice }): SyncPlatform['scan'] {
  return async (request) => {
    const scan = await b.platform.scan(request);
    let devices = scan.devices.map((d) => (d.deviceId === b.id && opts.own ? { ...d, epochs: opts.own(d.epochs) } : d.deviceId === A_ID && opts.pc ? opts.pc(d) : d));
    const third = opts.third?.() ?? null;
    const pc = scan.devices.find((d) => d.deviceId === A_ID);
    if (third !== null && pc?.state) {
      const acks = new Map((third.acks ?? []).map(([id, epoch]) => [id, { epoch, segment: 0, record: 0, hlc: null, stateSeq: 0 }] as const));
      const state = { ...pc.state, deviceId: C_ID, epoch: third.epoch, stateSeq: 1, head: { epoch: third.epoch, segment: 0, record: 0, hlc: null, stateSeq: 1 }, acks, snapshot: null };
      devices = [...devices, { ...pc, deviceId: C_ID, state, epochs: [], pending: [] }];
    }
    return { ...scan, devices };
  };
}

const hideOrphan = (epochs: ScanDevice['epochs']): ScanDevice['epochs'] => epochs.filter((e) => e.epoch !== ORPHAN);

describe('Y-IOS-02-FIX-02 : revue « à corriger » (points 1 à 4)', () => {
  it('point 1 : state.ctx supprimé par un tiers, base restaurée à stateSeq 0, seul un instantané d’ancienne époque non annoncée : Rust refuse stateSeq 1, publish-blocked, jamais « À jour »', async () => {
    const { b } = await aliState();
    // Aucune écriture à publier : le dossier de l'iPhone ne contiendra que son état (aucun segment).
    await b.data.repos.sync.clearOutbox(await b.data.repos.sync.maxOutboxSeq());
    // Premier cycle : état publié (stateSeq 1), suppression de l'orpheline en échec (le fichier reste).
    withPlatform(b, { ...b.platform, deleteOwn: (files) => (files.some((f) => f.kind === 'epoch') ? Promise.reject(new SyncPlatformError('io')) : b.platform.deleteOwn(files)) });
    expect((await b.cycle()).warnings ?? []).not.toContain('publish-blocked');
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
    // Un tiers supprime state.ctx ; la base est restaurée d'avant toute publication (stateSeq 0, mémo et dernier état effacés).
    const own = b.folder.devices.get(b.id);
    if (own) own.state = null;
    for (const key of ['stateSeq', 'lastState', 'orphanEpoch']) await b.data.repos.sync.setMeta(key, null);
    expect([...(own?.epochs.keys() ?? [])]).toEqual([ORPHAN]);
    b.logger.entries.length = 0;
    const status = await b.cycle();
    expect(b.logger.entries.find((e) => e.event === 'write-state-failed')?.detail).toEqual({ code: 'state-mismatch' });
    expect(b.logger.entries.find((e) => e.event === 'publish-deferred')?.detail).toEqual({ reason: 'state-refused', state: 'missing', files: 0, ignored: 1, acks: 0, localSeq: 0 });
    expect(status.warnings).toContain('publish-blocked');
    expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
    // Son état n'est pas connu : rien n'est réarmé.
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
  });

  it('point 2 : l’état du PC dans le nuage (non lisible à ce scan) : aucun réarmement ; lisible au cycle suivant : réarmé puis supprimé', async () => {
    const { b } = await aliState();
    let pcPending = true;
    withPlatform(b, { ...b.platform, scan: scanWith(b, { pc: (d) => (pcPending ? { ...d, stateStatus: 'cloud-pending', state: null } : d) }) });
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
    pcPending = false;
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(1);
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
  });

  it('point 3 (a) : époque non courante annoncée par l’état d’un autre appareil : l’instantané compte (publication refusée), puis aucun réarmement', async () => {
    const { b } = await aliState();
    let hidden = false;
    withPlatform(b, { ...b.platform, scan: scanWith(b, { own: (epochs) => (hidden ? hideOrphan(epochs) : epochs), third: () => ({ epoch: ORPHAN }) }) });
    const blocked = await b.cycle();
    expect(blocked.warnings).toContain('publish-blocked');
    expect(b.logger.entries.find((e) => e.event === 'publish-deferred')?.detail).toEqual({ reason: 'own-state-missing', state: 'missing', files: 1, ignored: 0, acks: 0, localSeq: 0 });
    // L'orpheline masquée un cycle : l'iPhone publie (son état devient connu).
    hidden = true;
    expect((await b.cycle()).warnings ?? []).not.toContain('publish-blocked');
    hidden = false;
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
  });

  it('point 3 (b) : époque annoncée par un accusé d’un autre appareil sur soi : publication, aucun réarmement', async () => {
    const { b } = await aliState();
    withPlatform(b, { ...b.platform, scan: scanWith(b, { third: () => ({ epoch: PC_EPOCH, acks: [[B_ID as DeviceId, ORPHAN]] }) }) });
    const status = await b.cycle();
    expect(status.warnings ?? []).not.toContain('publish-blocked');
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
    await b.cycle();
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
  });

  it('point 3 (c) : son état propre publié n’est pas connu (écriture refusée) : aucun réarmement, publish-blocked', async () => {
    const { b } = await aliState();
    withPlatform(b, { ...b.platform, writeState: () => Promise.reject(new SyncPlatformError('state-mismatch')) });
    const status = await b.cycle();
    expect(status.warnings).toContain('publish-blocked');
    expect(events(b, 'orphan-epoch-relisted')).toBe(0);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN)).toBe(true);
  });

  it('point 4 : iCloud remonte l’époque déjà supprimée à chaque cycle : orphan-epoch-deleted une seule fois, puis orphan-epoch-already-gone', async () => {
    const { b } = await aliState();
    // Listing qui montre toujours l'orpheline (suppression locale pas encore propagée par iCloud).
    withPlatform(b, { ...b.platform, scan: scanWith(b, { own: (epochs) => (epochs.some((e) => e.epoch === ORPHAN) ? epochs : [...epochs, { epoch: ORPHAN, segments: [], snapshots: [1] }]) }) });
    await b.cycle();
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(b.folder.devices.get(b.id)?.epochs.has(ORPHAN) ?? false).toBe(false);
    await b.cycle();
    await b.cycle();
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(events(b, 'orphan-epoch-already-gone')).toBe(2);
    expect(b.logger.entries.find((e) => e.event === 'orphan-epoch-already-gone')?.detail).toEqual({ epoch: ORPHAN.slice(0, 14) });
  });
});
