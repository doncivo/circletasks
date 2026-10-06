import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseStoredAcks, SyncStateUnreadableError } from '../../../src/db/repositories/syncRepository';
import { FOLDER_WARN_BYTES, NONCE_WARN_RECORDS } from '../../../src/domain/sync/limits';
import type { DeviceId } from '../../../src/domain/types';
import type { FolderScan, SyncPlatform } from '../../../src/platform/sync/types';
import { META } from '../../../src/sync/meta';
import { FORGET_META } from '../../../src/sync/forget';
import { mirrorDeviceFolder } from '../../sim/syncCloudSim';
import { syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { B_ID, C_ID, closeAll, publishedState, reassociate, setupRoom, settle, titles, type Room } from './reset/resetKit';

/**
 * Y-TECH-02 (QA), points C et avertissements : oubli d'un appareil après une réassociation en fusion (la suppression aboutit),
 * avertissements visibles puis disparus, `state-unreadable` sur chaque valeur JSON stockée corrompue. Horloge simulée, aucun délai réel.
 */

const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(() => closeAll(room));

function patchScan(d: SimDevice, extra: (scan: FolderScan) => FolderScan): void {
  const platform = d.platform as unknown as SyncPlatform & Record<string, unknown>;
  const real = platform.scan.bind(platform);
  platform['scan'] = async (r: Parameters<SyncPlatform['scan']>[0]) => extra(await real(r));
}

describe('C : réinitialisation en fusion, puis oubli de l’appareil absent', () => {
  it('B se réassocie (X jamais relu), A oublie X : A bascule, la suppression des fichiers de X aboutit partout, aucun accusé {n+1, 0, 0}', async () => {
    const [a, b, x] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await x.createTask('X1');
    await x.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await b.cycle();
    await a.createTask('A1');
    await settle([a, b], 2);

    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    // X est resté sans position chez B (jamais lu dans cette base) au moment de la fusion.
    await b.driver.execute('UPDATE sync_state SET epoch = NULL, cursor_segment = 0, cursor_record = 0, ack_hlc = NULL WHERE device_id = ?', [x.id]);
    await reassociate(a, b, [a, b]);
    await b.cycle();
    const target = publishedState(b, b.id, 'next')?.epoch;
    expect(target).toMatch(/^e0002-/);
    const acksOfB = (JSON.parse(b.folder.devices.get(b.id)?.nextState?.lines[0]?.text ?? '{}') as { acks?: Record<string, { epoch: string; segment: number; record: number }> }).acks ?? {};
    expect(acksOfB[x.id]).not.toMatchObject({ epoch: target, segment: 0, record: 0 });
    syncFolders([a, b]);
    await a.cycle();
    expect(a.service.status().reset?.waiting).toEqual([x.id]);

    // X ne reviendra pas : A l'oublie ; la réinitialisation n'attend plus personne, B suit.
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b], 4);
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    expect(b.service.status().reset).toMatchObject({ step: 'done' });
    // Suppression : un actif retire le dossier de X, iCloud la propage, plus aucune ligne en attente ni échec gardé.
    const deleter = [a, b].find((d) => !d.folder.devices.has(x.id));
    expect(deleter, 'un appareil actif a supprimé les fichiers de X').toBeDefined();
    for (const d of [a, b]) if (d !== deleter) mirrorDeviceFolder((deleter as SimDevice).folder, d.folder, x.id);
    await settle([a, b], 2);
    for (const d of [a, b]) {
      expect(d.folder.devices.has(x.id), d.name).toBe(false);
      expect(d.service.status().forget?.deletions ?? [], d.name).toEqual([]);
      expect(d.service.status().forget?.failure ?? null, d.name).toBeNull();
      expect(d.service.status().devices.find((s) => s.deviceId === x.id)?.status, d.name).toBe('forgotten');
    }
    expect(await titles(a)).toEqual(await titles(b));
    expect(await titles(a)).toContain('A1');
  });
});

describe('avertissements visibles puis disparus', () => {
  const warned = (d: SimDevice): readonly string[] => d.service.status().warnings ?? [];

  it('chacun apparaît à son cycle et disparaît au premier scan sans lui, séparément (pas de reste d’un cycle à l’autre)', async () => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    expect(warned(a)).toEqual([]);
    a.folder.padFolder(FOLDER_WARN_BYTES);
    expect((await a.cycle()).warnings).toEqual(['folder-large']);
    // Le dossier a encore sa taille mais le scan suivant est incomplet seulement.
    patchScan(a, (scan) => ({ ...scan, folderLarge: false, incomplete: true }));
    expect((await a.cycle()).warnings).toEqual(['scan-incomplete']);
    patchScan(a, (scan) => ({ ...scan, folderLarge: false, incomplete: false, tooManyDevices: true }));
    expect((await a.cycle()).warnings).toEqual(['too-many-devices']);
    patchScan(a, (scan) => ({ ...scan, folderLarge: false, incomplete: false, tooManyDevices: false, nonceWarning: false }));
    expect((await a.cycle()).warnings ?? []).toEqual([]);
  });

  it('dossier de plus de 1 Gio : disparaît quand la taille repasse sous le seuil (memory.ts)', async () => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    a.folder.padFolder(FOLDER_WARN_BYTES);
    expect((await a.cycle()).warnings).toEqual(['folder-large']);
    a.folder.padFolder(-FOLDER_WARN_BYTES);
    expect((await a.cycle()).warnings ?? []).toEqual([]);
  });

  it('budget de nonces : disparaît avec la réinitialisation (nouvelle clé, compteur reparti de zéro)', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    expect((await a.cycle()).warnings).toEqual(['nonce-budget']);
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders([a, b]);
    await b.cycle();
    await reassociate(a, b, [a, b]);
    await b.cycle();
    await settle([a, b], 3);
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    expect(warned(a)).not.toContain('nonce-budget');
    expect((await a.platform.scan({ keep: [] })).nonceWarning).toBe(false);
  });

  it('scan en échec : les avertissements connus sont gardés (pas de disparition par défaut), puis retirés au scan réussi', async () => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    patchScan(a, (scan) => ({ ...scan, tooManyDevices: true }));
    expect((await a.cycle()).warnings).toEqual(['too-many-devices']);
    const platform = a.platform as unknown as Record<string, unknown>;
    const scanning = platform['scan'];
    platform['scan'] = () => Promise.reject(new Error('dossier injoignable'));
    const failed = await a.cycle();
    expect(failed.phase).toBe('error');
    expect(failed.warnings).toEqual(['too-many-devices']);
    platform['scan'] = scanning;
    patchScan(a, (scan) => ({ ...scan, tooManyDevices: false }));
    expect((await a.cycle()).warnings ?? []).toEqual([]);
  });
});

describe('state-unreadable : chaque valeur JSON stockée corrompue est signalée, jamais lue comme « aucune »', () => {
  const CORRUPT = '{pas du json';

  it.each([META.epoch, META.stateSeq, META.head, META.lastState, META.snapshot, META.purgeHorizon, META.epochSwitch, META.segments])('sync_meta.%s illisible : state-unreadable au cycle, retiré une fois la valeur réparée', async (key) => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    const saved = await a.data.repos.sync.getMeta(key);
    await a.data.repos.sync.setMeta(key, CORRUPT);
    const status = await a.cycle();
    expect(status.stateUnreadable, `${key} lu comme « aucune valeur » sans signal`).toBe(true);
    expect(JSON.stringify(a.logger.entries)).not.toContain('pas du json');
    await a.data.repos.sync.setMeta(key, saved);
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });

  it.each([FORGET_META.deletions, FORGET_META.failure, FORGET_META.revived, FORGET_META.declarations, FORGET_META.snapshotWait])('sync_meta.%s (oubli) illisible : state-unreadable, pas « aucune suppression »', async (key) => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    await a.data.repos.sync.setMeta(key, CORRUPT);
    const status = await a.cycle();
    expect(status.stateUnreadable, key).toBe(true);
  });

  it('accusés stockés : JSON valide mais forme invalide (accusé sans époque, valeur négative) refusés comme le JSON corrompu', () => {
    const log = { entries: [] as unknown[], log(event: string): void { this.entries.push(event); } };
    for (const raw of ['{"cccccccc-cccc-4ccc-8ccc-cccccccccccc":{"epoch":"x"}}', '{"cccccccc-cccc-4ccc-8ccc-cccccccccccc":null}', 'null', '"x"']) {
      expect(() => parseStoredAcks(raw, 'sync_state.last_acks', log as never), raw).toThrow(SyncStateUnreadableError);
    }
  });
});
