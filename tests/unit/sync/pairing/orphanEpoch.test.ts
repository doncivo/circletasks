import { afterEach, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import type { TaskId } from '../../../../src/domain/types';
import type { EpochId } from '../../../../src/domain/sync/format';
import { SyncPlatformError, type SyncPlatform } from '../../../../src/platform/sync/types';
import { createSyncService } from '../../../../src/sync';
import { hydrate, propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * ADR 0011 §24 (avenant Y-IOS-02, PR #24) : époque orpheline, attente de l'appareil connu, étapes de l'abandon (arrêt entre chacune),
 * suppression en échec non bloquante. Topologie réelle du point de contrôle 0.2.3 : dossier du PC `56d4` avec l'instantané 1 (avant « Test Pc »)
 * et un journal de deux enregistrements, dossier de l'iPhone `ef50` avec le seul instantané 1 et aucun `state.ctx`.
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Service de l'iPhone sur une plateforme éventuellement truquée, avec ou sans échéance de cycle `hide`. */
function iphoneService(b: SimDevice, platform: SyncPlatform, probe?: Parameters<typeof createSyncService>[0]['deadlineProbe']): void {
  b.service = createSyncService({
    data: b.data, platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, sv: SCHEMA_VERSION, appVersion: '0.4.0', logger: b.logger,
    setTimeout: () => 0, clearTimeout: () => undefined, ...(probe ? { deadlineProbe: probe } : {}),
  });
}

const orphanEpochOf = (_b: SimDevice): EpochId => `e0001-${B_ID}` as EpochId;

/** PC : 5 tâches dans l'instantané, « Test Pc » (enregistrement 1), mise à jour de minuit (enregistrement 2) ; iPhone en époque orpheline. */
async function topology(cursor: 'ack-set' | 'ack-null' = 'ack-null'): Promise<{ a: SimDevice; b: SimDevice; testPc: TaskId; localIphone: TaskId }> {
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
  const localIphone = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
  // État du PC absent chez l'iPhone (pas encore arrivé, ses autres fichiers si) au premier cycle, borné par l'échéance de `hide` : l'ancien
  // moteur ouvrait `ef50` puis s'arrêtait avant `state.ctx`. Ici l'orpheline est fabriquée à la main pour tester le rattrapage.
  propagate(a.folder, b.folder, a.id, { drop: ['state.ctx'] });
  await seedOrphan(b);
  // Position de lecture laissée par le défaut sur le PC (curseur après l'enregistrement 2, accusé au hlc de minuit ou nul).
  const pcRow = (await a.data.repos.sync.getStates()).find((r) => r.isSelf);
  await b.data.repos.sync.saveState(a.id, { cursorSegment: 1, cursorRecord: 2, ackHlc: cursor === 'ack-set' ? (pcRow?.ackHlc ?? a.hlc.now()) : null });
  propagate(a.folder, b.folder, a.id);
  // Le dossier de l'iPhone (instantané orphelin seul) arrive chez le PC : le PC cycle alors que l'orpheline est listée.
  propagate(b.folder, a.folder, b.id);
  return { a, b, testPc, localIphone };
}

/** Époque `ef50` ouverte par l'iPhone : instantané 1 de sa base, `sync_meta` comme après `epoch-opened`, aucun état. */
async function seedOrphan(b: SimDevice): Promise<void> {
  const epoch = orphanEpochOf(b);
  await b.platform.bindDevice(b.id);
  await b.platform.writeSnapshot({ epoch, seq: 1, sv: SCHEMA_VERSION, records: (async function* () { yield ['{"k":"snap-end","count":0,"covers":{},"epoch":"' + epoch + '","sv":' + String(SCHEMA_VERSION) + '}']; })() });
  const maxSeq = await b.data.repos.sync.maxOutboxSeq();
  await b.data.repos.sync.clearOutbox(maxSeq);
  await b.data.repos.sync.setMeta('epoch', JSON.stringify(epoch));
  await b.data.repos.sync.setMeta('head', JSON.stringify({ epoch, segment: 0, record: 0, hlc: null, stateSeq: 0 }));
  await b.data.repos.sync.setMeta('snapshot', JSON.stringify({ epoch, seq: 1, endHlc: b.hlc.now() }));
  await b.restart();
}

const liveIds = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ id: string }>('SELECT id FROM task WHERE deleted_at IS NULL ORDER BY id')).map((r) => r.id);

async function converge(list: readonly SimDevice[], rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const d of list) {
      await d.cycle();
      syncFolders(list as SimDevice[]);
    }
  }
}

describe('attente avant toute ouverture d’époque (§24 point 1)', () => {
  it('instantané 1 et journal 1 du PC téléchargés, state.ctx non listé : l’iPhone n’ouvre rien, nomme le PC, jamais « À jour », puis rejoint 56d4', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    const task = await a.createTask('Test Pc');
    await a.cycle();
    await a.updateTask(task.id as TaskId, { carriedOver: true });
    await a.cycle();
    await pair(a, b);
    propagate(a.folder, b.folder, a.id, { drop: ['state.ctx'] });
    const local = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
    for (let i = 0; i < 3; i += 1) {
      const status = await b.cycle();
      expect(status.phase).toBe('waiting-icloud');
      expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
      expect(status.devices.some((d) => d.deviceId === a.id && d.seen === false)).toBe(true);
    }
    expect(await b.data.repos.sync.getMeta('epoch')).toBeNull();
    expect(b.folder.devices.get(b.id)?.epochs.size ?? 0).toBe(0);
    expect(b.folder.devices.get(b.id)?.state ?? null).toBeNull();
    expect(b.logger.entries.some((e) => e.event === 'epoch-open-deferred')).toBe(true);
    // Le state.ctx arrive : l'iPhone rejoint l'époque du PC, la tâche arrive, celle de l'iPhone part.
    propagate(a.folder, b.folder, a.id);
    const joined = await b.cycle();
    expect((await b.task(task.id as TaskId))?.carriedOver).toBe(true);
    expect(joined.phase).toBe('idle');
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect(await b.data.repos.sync.getMeta('epoch')).toBe(await a.data.repos.sync.getMeta('epoch'));
    expect((await a.task(local))?.title).toBe('Écrite sur l’iPhone');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

/** Association par le QR du PC (le QR porte l'appareil qui l'a affiché : `pairedBy`), dossier du PC recopié d'abord. */
async function pairByQr(owner: SimDevice, joiner: SimDevice): Promise<void> {
  propagate(owner.folder, joiner.folder, owner.id);
  await joiner.platform.folder.choose();
  await owner.platform.key.openPairing('show');
  const payload = await owner.platform.key.pairingPayload();
  await owner.platform.key.closePairing();
  await joiner.platform.key.openPairing('import');
  await joiner.platform.key.import({ qrText: payload.qrText });
}

describe('appareil connu dont le dossier n’apparaît pas encore (§24 point 1 (b))', () => {
  it('association fraîche, listing vide pour le PC : l’iPhone n’ouvre rien, nomme le PC, puis rejoint son époque quand ses fichiers apparaissent', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    const task = await a.createTask('Test Pc');
    await a.cycle();
    await pairByQr(a, b);
    expect((await b.platform.key.status()).pairedBy).toBe(a.id);
    // iCloud n'a pas encore synchronisé le dossier du PC : il n'apparaît pas du tout dans le listing.
    b.folder.devices.delete(a.id);
    const local = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
    for (let i = 0; i < 3; i += 1) {
      const status = await b.cycle();
      expect(status.phase).toBe('waiting-icloud');
      expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
      expect(status.devices.some((d) => d.deviceId === a.id && d.seen === false)).toBe(true);
      expect(status.pendingFiles.some((f) => f.startsWith(String(a.id).slice(0, 8)))).toBe(true);
    }
    expect(await b.data.repos.sync.getMeta('epoch')).toBeNull();
    expect(b.folder.devices.get(b.id)?.epochs.size ?? 0).toBe(0);
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect(await b.data.repos.sync.getMeta('epoch')).toBe(await a.data.repos.sync.getMeta('epoch'));
    expect((await b.task(task.id as TaskId))?.title).toBe('Test Pc');
    expect((await a.task(local))?.title).toBe('Écrite sur l’iPhone');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('appareil mort (fichiers jamais arrivés) : attente, Détails le montre « jamais vu » avec l’action Oublier, puis l’iPhone ouvre son époque normalement', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    await pairByQr(a, b);
    b.folder.devices.delete(a.id);
    const waiting = await b.cycle();
    expect(waiting.phase).toBe('waiting-icloud');
    const ghost = waiting.devices.find((d) => d.deviceId === a.id);
    expect(ghost).toMatchObject({ seen: false, self: false });
    // L'action « Oublier l'appareil » (flux existant, Détails) sur ce fantôme.
    expect(await b.service.forgetDevice(a.id)).toEqual({ kind: 'done' });
    // Le PC oublié ne bloque plus nommément ; la clé étant importée, l'appareil attend encore (aucun état lu) jusqu'à l'action explicite.
    const after = await b.cycle();
    expect(after.phase).not.toBe('waiting-icloud');
    expect(after.warnings).toContain('awaiting-other-devices');
    await b.service.startFromThisDevice();
    expect(await b.data.repos.sync.getMeta('epoch')).not.toBeNull();
    expect(b.logger.entries.some((e) => e.event === 'epoch-opened')).toBe(true);
  });
});

describe('clé importée : jamais le premier appareil sans action explicite (§24 point 1)', () => {
  it('clé de secours (pas de pairedBy), listing sans aucun autre appareil : attente sans nom, rien d’écrit, puis « Démarrer la synchro depuis cet appareil » ouvre l’époque', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    expect((await b.platform.key.status()).imported).toBe(true);
    expect((await b.platform.key.status()).pairedBy ?? null).toBeNull();
    expect((await a.platform.key.status()).imported).toBe(false);
    b.folder.devices.delete(a.id);
    for (let i = 0; i < 3; i += 1) {
      const status = await b.cycle();
      expect(status.warnings).toContain('awaiting-other-devices');
      expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
      expect(status.devices.every((d) => d.self)).toBe(true);
    }
    expect(await b.data.repos.sync.getMeta('epoch')).toBeNull();
    expect(b.folder.devices.get(b.id)?.epochs.size ?? 0).toBe(0);
    await b.service.startFromThisDevice();
    expect(await b.data.repos.sync.getMeta('epoch')).not.toBeNull();
    expect(b.service.status().warnings ?? []).not.toContain('awaiting-other-devices');
    expect(await b.data.repos.sync.getMeta('startHere')).toBeNull();
  });

  it('les fichiers des autres appareils arrivent sans action : l’appareil rejoint leur époque, jamais la sienne', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    const task = await a.createTask('Test Pc');
    await a.cycle();
    await pair(a, b);
    b.folder.devices.delete(a.id);
    expect((await b.cycle()).warnings).toContain('awaiting-other-devices');
    propagate(a.folder, b.folder, a.id);
    const joined = await b.cycle();
    expect(joined.warnings ?? []).not.toContain('awaiting-other-devices');
    expect((await b.task(task.id as TaskId))?.title).toBe('Test Pc');
    expect(await b.data.repos.sync.getMeta('epoch')).toBe(await a.data.repos.sync.getMeta('epoch'));
  });
});

describe('avertissement d’une trace de l’orpheline : persistant jusqu’à acquittement', () => {
  it('reste levé à chaque cycle, puis « Lancer une reprise complète » le résout', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const id = '12345678-1234-4234-8234-123456789012' as TaskId;
    b.clock.advance(1_000);
    await b.data.repos.sync.insertTombstones([{ table: 'task', rowId: id, deletedHlc: b.hlc.now() }], new Date(b.clock.nowMs()).toISOString() as never);
    await b.data.repos.sync.setMeta('orphanTraces', JSON.stringify([`task|${id}`]));
    a.clock.advance(1_000);
    await a.createTask('Visée par la trace', { id });
    await a.cycle();
    syncFolders(devices);
    expect((await b.cycle()).warnings).toContain('received-unapplied');
    for (let i = 0; i < 3; i += 1) expect((await b.cycle()).warnings).toContain('received-unapplied');
    await b.service.fullResume();
    expect(b.service.status().warnings ?? []).not.toContain('received-unapplied');
    expect(await b.data.repos.sync.getMeta('orphanTraceHit')).toBeNull();
    expect(await b.data.repos.sync.getMeta('orphanTraceAck')).toBeNull();
    expect((await b.cycle()).warnings ?? []).not.toContain('received-unapplied');
  });
});

describe('garde des traces purgées de l’orpheline (§24 point 4 (a))', () => {
  it('ligne créée, supprimée puis purgée dans l’orpheline : après l’abandon et la reprise, rien ne revient, aucun orphan-trace-hit', async () => {
    const { a, b, testPc } = await topology();
    const purged = (await b.createTask('Créée puis purgée')).id as TaskId;
    await b.data.repos.sync.insertTombstones([{ table: 'task', rowId: purged, deletedHlc: b.hlc.now() }], new Date(b.clock.nowMs()).toISOString() as never);
    await b.driver.execute('DELETE FROM task WHERE id = ?', [purged]);
    await converge([b, a], 4);
    expect((await b.task(testPc))?.title).toBe('Test Pc');
    expect(await b.task(purged)).toBeNull();
    expect(await a.task(purged)).toBeNull();
    expect(b.logger.entries.some((e) => e.event === 'orphan-trace-hit')).toBe(false);
    expect(b.logger.entries.some((e) => e.event === 'epoch-abandoned')).toBe(true);
  });

  it('une opération reçue qui vise une de ces traces : journalisée (table seulement) et received-unapplied levé, la ligne n’est pas recréée', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices.push(a, b);
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const id = '12345678-1234-4234-8234-123456789012' as TaskId;
    b.clock.advance(1_000);
    await b.data.repos.sync.insertTombstones([{ table: 'task', rowId: id, deletedHlc: b.hlc.now() }], new Date(b.clock.nowMs()).toISOString() as never);
    await b.data.repos.sync.setMeta('orphanTraces', JSON.stringify([`task|${id}`]));
    a.clock.advance(1_000);
    await a.createTask('Visée par la trace', { id });
    await a.cycle();
    syncFolders(devices);
    const status = await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'orphan-trace-hit' && (e.detail as { table?: string }).table === 'task')).toBe(true);
    expect(await b.task(id)).toBeNull();
    expect(status.warnings).toContain('received-unapplied');
    expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
  });
});

describe('abandon de l’orpheline : étapes, arrêts, refus, suppression', () => {
  for (const cursor of ['ack-set', 'ack-null'] as const) {
  it(`topologie réelle (${cursor}) : le PC cycle avec l’orpheline listée sans effet, l’iPhone abandonne ef50 et rejoint 56d4 sans rien perdre`, async () => {
    const { a, b, testPc, localIphone } = await topology(cursor);
    const pcBefore = await liveIds(a);
    expect(a.folder.devices.get(b.id)?.epochs.has(orphanEpochOf(b))).toBe(true);
    const pcStatus = await a.cycle();
    expect(pcStatus.phase).toBe('idle');
    expect(await a.data.repos.sync.getMeta('epoch')).toBe(JSON.stringify('e0001-' + A_ID));
    syncFolders(devices);
    for (let round = 0; round < 4; round += 1) {
      const status = await b.cycle();
      if (status.phase === 'idle' && status.warnings === undefined) expect((await b.task(testPc))?.title).toBe('Test Pc');
      syncFolders(devices);
      await a.cycle();
      syncFolders(devices);
    }
    expect(await b.data.repos.sync.getMeta('epoch')).toBe(JSON.stringify('e0001-' + A_ID));
    expect((await b.task(testPc))?.carriedOver).toBe(true);
    for (const id of pcBefore) expect(await b.task(id as TaskId), id).not.toBeNull();
    expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await a.driver.select('SELECT id FROM task WHERE deleted_at IS NOT NULL')).toEqual([]);
    expect(b.folder.devices.get(b.id)?.epochs.has(orphanEpochOf(b)) ?? false).toBe(false);
    expect(b.logger.entries.some((e) => e.event === 'epoch-abandoned')).toBe(true);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
  });
  }

  for (const stop of ['avant-rust', 'apres-rust'] as const) {
    it(`arrêt ${stop} : cycle en échec visible sans rien publier, le cycle suivant reprend à l’étape interrompue`, async () => {
      const { a, b, testPc, localIphone } = await topology();
      let failing = true;
      const platform: SyncPlatform = {
        ...b.platform,
        abandonOrphanEpoch: async (epoch) => {
          if (failing && stop === 'avant-rust') throw new SyncPlatformError('io');
          await b.platform.abandonOrphanEpoch(epoch);
          if (failing && stop === 'apres-rust') throw new SyncPlatformError('io');
        },
      };
      iphoneService(b, platform);
      await b.service.syncNow('manual');
      expect(b.service.status().phase).toBe('error');
      expect(b.service.status().errorCode).toBe('io');
      expect(b.folder.devices.get(b.id)?.state ?? null).toBeNull();
      expect(await b.task(testPc)).toBeNull();
      failing = false;
      for (let i = 0; i < 4; i += 1) {
        await b.service.syncNow('manual');
        syncFolders(devices);
        await a.cycle();
        syncFolders(devices);
      }
      expect(b.service.status().phase).toBe('idle');
      expect((await b.task(testPc))?.carriedOver).toBe(true);
      expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
      expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    });
  }

  it('Rust refuse la preuve (state-mismatch) : l’abandon est annulé, journalisé, « publish-blocked » visible, rien n’est supprimé', async () => {
    const { a, b } = await topology();
    const platform: SyncPlatform = { ...b.platform, abandonOrphanEpoch: () => Promise.reject(new SyncPlatformError('state-mismatch')) };
    iphoneService(b, platform);
    await b.service.syncNow('manual');
    syncFolders(devices);
    await a.cycle();
    const status = b.service.status();
    expect(status.phase).not.toBe('error');
    expect(b.logger.entries.some((e) => e.event === 'orphan-epoch-abandon-failed')).toBe(true);
    expect(status.warnings).toContain('publish-blocked');
    expect(statusLine(status, b.clock.nowMs())).not.toContain('À jour');
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect(b.folder.devices.get(b.id)?.epochs.has(orphanEpochOf(b))).toBe(true);
  });

  it('suppression des fichiers de l’orpheline en échec : ni la lecture ni la publication n’attendent, journal avec le code, retentée à chaque cycle', async () => {
    const { a, b, testPc, localIphone } = await topology();
    let failing = true;
    const platform: SyncPlatform = {
      ...b.platform,
      deleteOwn: (files) => (failing && files.some((f) => f.kind === 'epoch') ? Promise.reject(new SyncPlatformError('io')) : b.platform.deleteOwn(files)),
    };
    iphoneService(b, platform);
    for (let i = 0; i < 4; i += 1) {
      await b.service.syncNow('manual');
      syncFolders(devices);
      await a.cycle();
      syncFolders(devices);
    }
    expect(b.service.status().phase).toBe('idle');
    expect((await b.task(testPc))?.carriedOver).toBe(true);
    expect((await a.task(localIphone))?.title).toBe('Écrite sur l’iPhone');
    expect(b.folder.devices.get(b.id)?.state ?? null).not.toBeNull();
    expect(b.logger.entries.filter((e) => e.event === 'orphan-epoch-delete-failed').length).toBeGreaterThan(1);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).not.toBeNull();
    failing = false;
    await b.service.syncNow('manual');
    expect(b.logger.entries.some((e) => e.event === 'orphan-epoch-deleted')).toBe(true);
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect(b.folder.devices.get(b.id)?.epochs.has(orphanEpochOf(b)) ?? false).toBe(false);
  });

  it('orpheline déjà absente du dossier : intention effacée (orphan-epoch-cleared)', async () => {
    const { a, b } = await topology();
    await converge([b, a], 2);
    await b.data.repos.sync.setMeta('orphanEpoch', JSON.stringify({ epoch: orphanEpochOf(b) }));
    await b.cycle();
    expect(await b.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect(b.logger.entries.some((e) => e.event === 'orphan-epoch-cleared')).toBe(true);
  });

  it('un troisième appareil s’associe pendant l’état orphelin : les trois convergent sur 56d4 sans perte', async () => {
    const { a, b, testPc, localIphone } = await topology();
    const c = await createSimDevice(C_ID, { name: 'Autre', clock: a.clock });
    devices.push(c);
    await pair(a, c);
    const fromC = (await c.createTask('Écrite sur C')).id as TaskId;
    await converge([c, b, a], 4);
    await converge([c, b, a], 2);
    for (const d of [a, b, c]) {
      expect((await d.task(testPc))?.carriedOver, d.name).toBe(true);
      expect((await d.task(localIphone))?.title, d.name).toBe('Écrite sur l’iPhone');
      expect((await d.task(fromC))?.title, d.name).toBe('Écrite sur C');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(c));
    hydrate(b.folder, a.id);
  });
});
