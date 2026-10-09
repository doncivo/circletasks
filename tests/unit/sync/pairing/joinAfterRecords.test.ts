import { afterEach, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { statusLine } from '../../../../src/features/sync/syncText';
import { createSyncService, HIDE_SYNC_DEADLINE_MS } from '../../../../src/sync';
import type { TaskId } from '../../../../src/domain/types';
import { hydrate, propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('arrivée après des enregistrements au-delà de l’instantané (point de contrôle 0.2.3, étape 4)', () => {
  it('instantané PC, tâche créée ensuite, iPhone associé plus tard, mise à jour de minuit : la tâche existe sur l’iPhone et son état est publié', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    expect((await a.cycle()).phase).toBe('idle');
    const task = await a.createTask('Test Pc');
    expect((await a.cycle()).phase).toBe('idle');
    await pair(a, b);
    await a.updateTask(task.id as TaskId, { carriedOver: true });
    expect((await a.cycle()).phase).toBe('idle');
    syncFolders(devices);
    expect((await b.cycle()).phase).toBe('idle');
    syncFolders(devices);
    expect((await a.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect((await b.task(task.id as TaskId))?.carriedOver).toBe(true);
    expect(await b.data.repos.sync.getMeta('epoch')).toBe(await a.data.repos.sync.getMeta('epoch'));
  });
});

describe('arrivée alors que l’état du PC est encore dans le nuage', () => {
  it('l’iPhone n’ouvre pas sa propre époque : il attend, puis rejoint l’époque du PC', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    expect((await a.cycle()).phase).toBe('idle');
    const task = await a.createTask('Test Pc');
    expect((await a.cycle()).phase).toBe('idle');
    await pair(a, b);
    // iCloud remplace les fichiers du PC par des espaces réservés (nouvelle version en cours de téléchargement) avant le premier cycle.
    propagate(a.folder, b.folder, a.id, { placeholder: true });
    await b.cycle();
    hydrate(b.folder, a.id);
    await b.cycle();
    syncFolders(devices);
    expect((await b.cycle()).phase).toBe('idle');
    syncFolders(devices);
    expect((await a.cycle()).phase).toBe('idle');
    expect((await b.task(task.id as TaskId))?.title).toBe('Test Pc');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

describe('« À jour » jamais affiché en silence', () => {
  it('curseur posé au-delà d’un enregistrement (mise à jour d’une ligne inconnue) : avertissement visible, puis reprise automatique sans perte', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const task = await a.createTask('Test Pc');
    await a.cycle();
    await a.updateTask(task.id as TaskId, { carriedOver: true });
    await a.cycle();
    syncFolders(devices);
    // État cassé de l’iPhone de l’utilisateur : lecture du journal du PC posée après la création.
    await b.data.repos.sync.saveState(a.id, { cursorSegment: 1, cursorRecord: 1 });
    const broken = await b.cycle();
    expect(await b.task(task.id as TaskId)).toBeNull();
    expect(broken.warnings).toContain('received-unapplied');
    expect(statusLine(broken, b.clock.nowMs())).not.toContain('À jour');
    // Cycle suivant : reprise depuis l’instantané demandée par le précédent, journal relu depuis la position couverte.
    await b.cycle();
    expect((await b.task(task.id as TaskId))?.carriedOver).toBe(true);
    const healed = await b.cycle();
    expect(healed.warnings ?? []).not.toContain('received-unapplied');
    expect(statusLine(healed, b.clock.nowMs())).toContain('À jour');
    syncFolders(devices);
    await a.cycle();
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('état propre non publiable (état absent, historique local) : avertissement, jamais « À jour »', async () => {
    const b = await createSimDevice(B_ID, { name: 'iPhone' });
    devices.push(b);
    await setupFirst(b);
    expect((await b.cycle()).phase).toBe('idle');
    // Le dossier perd l’état publié alors que l’historique local existe et qu’aucun autre appareil n’a d’accusé : la borne manque.
    const own = b.folder.devices.get(b.id);
    if (own) own.state = null;
    const blocked = await b.cycle();
    expect(blocked.warnings).toContain('publish-blocked');
    expect(statusLine(blocked, b.clock.nowMs())).not.toContain('À jour');
  });
});

describe('échec d’écriture de state.ctx', () => {
  it('visible : phase d’erreur avec son code, jamais « À jour » ; le cycle suivant, une fois l’écriture possible, publie l’état', async () => {
    const b = await createSimDevice(B_ID, { name: 'iPhone' });
    devices.push(b);
    await setupFirst(b);
    let failing = true;
    const platform = { ...b.platform, writeState: (input: Parameters<typeof b.platform.writeState>[0]) => (failing ? Promise.reject(new SyncPlatformError('io')) : b.platform.writeState(input)) };
    b.service = createSyncService({ data: b.data, platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, sv: SCHEMA_VERSION, appVersion: '0.4.0', logger: b.logger, setTimeout: () => 0, clearTimeout: () => undefined });
    await b.service.syncNow('manual');
    const failed = b.service.status();
    expect(failed.phase).toBe('error');
    expect(failed.errorCode).toBe('io');
    expect(statusLine(failed, b.clock.nowMs())).not.toContain('À jour');
    failing = false;
    await b.service.syncNow('manual');
    expect(b.service.status().phase).toBe('idle');
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
  });
});

describe('état propre jamais publié après l’ouverture de l’époque (arrêt entre l’instantané et l’état)', () => {
  it('le cycle suivant publie l’état au lieu de différer sans fin', async () => {
    const b = await createSimDevice(B_ID, { name: 'iPhone' });
    devices.push(b);
    await setupFirst(b);
    b.service = createSyncService({
      data: b.data,
      platform: b.platform,
      hlc: b.hlc,
      clock: b.clock,
      deviceId: b.id,
      devicePlatform: 'ios',
      sv: SCHEMA_VERSION,
      appVersion: '0.4.0',
      logger: b.logger,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      // L'échéance du passage en arrière-plan tombe juste avant l'écriture de l'état.
      deadlineProbe: (unit) => {
        if (unit === 'write-state') b.clock.advance(HIDE_SYNC_DEADLINE_MS);
      },
    });
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    expect(b.folder.devices.get(b.id)?.state ?? null).toBeNull();
    await b.restart();
    await b.cycle();
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
  });
});
