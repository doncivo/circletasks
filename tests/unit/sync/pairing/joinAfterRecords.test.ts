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

describe('topologie réelle du point de contrôle 0.2.3 : iPhone en époque orpheline, PC porteur des données', () => {
  /** PC : 5 tâches dans l'instantané, « Test Pc » créée après (enregistrement 1), mise à jour de minuit (enregistrement 2). */
  async function topology(cursor: 'ack-set' | 'ack-null'): Promise<{ a: SimDevice; b: SimDevice; testPc: TaskId; localIphone: TaskId }> {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    for (let i = 0; i < 5; i += 1) await a.createTask(`Tâche PC ${String(i)}`);
    await a.cycle();
    const testPc = (await a.createTask('Test Pc')).id as TaskId;
    await a.cycle();
    await pair(a, b);
    a.clock.advance(3_600_000);
    await a.updateTask(testPc, { carriedOver: true });
    await a.cycle();
    // L'iPhone voit le dossier du PC sans son état (absent, pas dans le nuage) : il se croit le premier, ouvre ef50 et s'arrête avant l'état.
    const localIphone = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
    propagate(a.folder, b.folder, a.id, { drop: ['state.ctx'] });
    b.service = createSyncService({
      data: b.data, platform: b.platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, devicePlatform: 'ios', sv: SCHEMA_VERSION, appVersion: '0.4.0', logger: b.logger,
      setTimeout: () => 0, clearTimeout: () => undefined,
      deadlineProbe: (unit) => {
        if (unit === 'write-state') b.clock.advance(HIDE_SYNC_DEADLINE_MS);
      },
    });
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    await b.restart();
    expect(await b.data.repos.sync.getMeta('epoch')).toContain(B_ID.slice(0, 8));
    expect(b.folder.devices.get(b.id)?.state ?? null).toBeNull();
    // Position de lecture laissée par le défaut sur le PC.
    const pcRow = (await a.data.repos.sync.getStates()).find((r) => r.isSelf);
    await b.data.repos.sync.saveState(a.id, { cursorSegment: 1, cursorRecord: 2, ackHlc: cursor === 'ack-set' ? (pcRow?.ackHlc ?? a.hlc.now()) : null });
    // Le dossier du PC arrive complètement chez l'iPhone.
    propagate(a.folder, b.folder, a.id);
    return { a, b, testPc, localIphone };
  }

  const liveIds = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ id: string }>('SELECT id FROM task WHERE deleted_at IS NULL ORDER BY id')).map((r) => r.id);

  for (const cursor of ['ack-set', 'ack-null'] as const) {
    it(`l’iPhone abandonne son époque orpheline et rejoint celle du PC (${cursor}) : aucune ligne perdue, aucun « À jour » prématuré`, async () => {
      const { a, b, testPc, localIphone } = await topology(cursor);
      const pcBefore = await liveIds(a);
      expect(pcBefore).toHaveLength(6);
      const epochA = await a.data.repos.sync.getMeta('epoch');
      for (let round = 0; round < 4; round += 1) {
        const status = await b.cycle();
        // « À jour » seulement quand tout le contenu du PC est là.
        if (status.phase === 'idle' && status.warnings === undefined) expect((await b.task(testPc))?.title).toBe('Test Pc');
        syncFolders(devices);
        await a.cycle();
        syncFolders(devices);
      }
      expect(await b.data.repos.sync.getMeta('epoch')).toBe(epochA);
      expect(await a.data.repos.sync.getMeta('epoch')).toBe(epochA);
      expect((await b.task(testPc))?.carriedOver).toBe(true);
      expect((await b.task(testPc))?.title).toBe('Test Pc');
      for (const id of pcBefore) expect(await b.task(id as TaskId), id).not.toBeNull();
      // Rien n'est supprimé ni perdu des deux côtés ; la tâche de l'iPhone est arrivée sur le PC.
      expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
      for (const id of pcBefore) expect(await a.task(id as TaskId), id).not.toBeNull();
      expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
      expect(await a.driver.select('SELECT id FROM task WHERE deleted_at IS NOT NULL')).toEqual([]);
      expect(await b.driver.select('SELECT id FROM task WHERE deleted_at IS NOT NULL')).toEqual([]);
      // L'époque orpheline n'a jamais été annoncée et ses fichiers sont supprimés ; l'état de l'iPhone est publié.
      expect(b.folder.devices.get(b.id)?.epochs.has(`e0001-${B_ID}` as never) ?? false).toBe(false);
      expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
    });
  }
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
