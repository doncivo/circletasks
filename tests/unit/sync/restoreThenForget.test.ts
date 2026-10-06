import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareEpochs, epochId, type EpochId } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { mirrorDeviceFolder } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-01 (dettes, revue de Y-11) : restauration « Appliquer partout » puis oubli. Le mode `replace` du changement d'époque et
 * `applyEverywhere` remettaient toutes les lignes de `sync_state` à {époque cible, 0, 0} : un accusé « début de la nouvelle époque » était
 * publié sur un appareil qui n'y a rien publié. Oublié ensuite, sa coupure pouvait être relevée dans la nouvelle époque, où personne ne
 * peut plus le lire : condition (f) jamais remplie pour l'appareil qui le gardait à sa position de l'ancienne époque, suppression de ses
 * fichiers bloquée sans fin. Règle appliquée (même règle que Y-11, aucun accusé {époque, 0, 0} sur un appareil qui n'a rien publié
 * dans cette époque) : position de l'ancienne époque, celle de l'instantané d'ouverture (`covers`), jusqu'à sa première lecture dans la
 * nouvelle. Horloge simulée seulement.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const N_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function setup(): Promise<[SimDevice, SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  const c = await createSimDevice(C_ID, { name: 'C', clock: a.clock });
  devices = [a, b, c];
  await setupFirst(a);
  expect((await a.cycle()).phase).toBe('idle');
  for (const d of [b, c]) {
    await pair(a, d);
    expect((await d.cycle()).phase).toBe('idle');
    syncFolders(devices);
  }
  await settle(devices);
  return [a, b, c];
}

async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  syncFolders(list);
}

/** Copie de la base (sauvegarde P-04) : toutes les tables. */
async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

/** Restauration P-04 de la copie, marqueur posé, puis « Appliquer cette version sur tous mes appareils ». */
async function restoreAndApplyEverywhere(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((col) => row[col] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261005.db', backupTakenAt: '2026-10-05T07:00:00.000Z' as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
  expect((await device.cycle()).phase).toBe('restore-choice');
  await device.service.chooseRestoreOption('apply-everywhere');
  expect(device.service.status().phase).toBe('idle');
}

interface Ack {
  readonly epoch: EpochId;
  readonly segment: number;
  readonly record: number;
}

function publishedAcks(of: SimDevice): Record<string, Ack> {
  const text = of.folder.devices.get(of.id)?.state?.lines[0]?.text;
  if (text === undefined) throw new Error(`aucun état publié par ${of.name}`);
  return (JSON.parse(text) as { acks: Record<string, Ack> }).acks;
}

function publishedEpoch(of: SimDevice, by: SimDevice): EpochId {
  const text = by.folder.devices.get(of.id)?.state?.lines[0]?.text;
  if (text === undefined) throw new Error(`état de ${of.name} absent chez ${by.name}`);
  return (JSON.parse(text) as { epoch: EpochId }).epoch;
}

/** Suppression faite par l'un : iCloud la propage aux autres. */
async function deleteForgotten(list: readonly SimDevice[], target: SimDevice): Promise<void> {
  for (let round = 0; round < 6 && list.every((d) => d.folder.devices.has(target.id)); round += 1) await settle(list, 1);
  const deleter = list.find((d) => !d.folder.devices.has(target.id));
  expect(deleter, 'aucun appareil n’a pu supprimer les fichiers de l’oublié').toBeDefined();
  for (const d of list) if (d !== deleter) mirrorDeviceFolder((deleter as SimDevice).folder, d.folder, target.id);
  await settle(list);
  for (const d of list) {
    expect(d.folder.devices.has(target.id), d.name).toBe(false);
    expect(d.service.status().forget?.deletions ?? [], d.name).toEqual([]);
  }
}

/** Nouvel appareil associé par `owner` : il arrive par l'instantané éligible et finit avec la même base. */
async function joinAndCompare(owner: SimDevice, others: readonly SimDevice[]): Promise<void> {
  const n = await createSimDevice(N_ID, { name: 'N', clock: owner.clock });
  devices.push(n);
  await pair(owner, n);
  const list = [...others, n];
  await settle(list);
  expect(n.service.status().phase).toBe('idle');
  for (const d of others) expect(await taskSnapshot(n), d.name).toEqual(await taskSnapshot(d));
}

describe('Y-TECH-01 : « Appliquer partout » puis oubli', () => {
  it('aucun accusé de la nouvelle époque sur un appareil qui n’y a rien publié ; oublié ensuite : coupure dans l’ancienne époque, fichiers supprimés, arrivée possible', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    // C n'est plus ouvert (perdu) ; A restaure sa sauvegarde et l'applique partout ; B suit la nouvelle époque par remplacement.
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    const e2 = epochId(2, a.id);
    expect(publishedEpoch(b, a)).toBe(e2);
    expect(compareEpochs(publishedEpoch(c, a), e2)).toBeLessThan(0);
    for (const d of [a, b]) {
      const ack = publishedAcks(d)[c.id];
      if (ack !== undefined) expect(compareEpochs(ack.epoch, e2), `${d.name} publie un accusé de ${e2} sur C`).toBeLessThan(0);
    }
    // A oublie C : coupure prise dans l'ancienne époque (position de l'instantané d'ouverture), la même chez A et B.
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    const onA = publishedAcks(a)[c.id];
    const onB = publishedAcks(b)[c.id];
    expect(onA).toBeDefined();
    expect(compareEpochs((onA as Ack).epoch, e2)).toBeLessThan(0);
    expect(onB).toEqual(onA);
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });

  it('oubli déclaré sur B avant qu’il lise la restauration de A : jamais bloqué (condition (f) remplie par tous)', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    // B oublie C (perdu) ; A n'a pas encore lu la déclaration quand il applique sa sauvegarde partout.
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    const e2 = epochId(2, a.id);
    for (const d of [a, b]) {
      const ack = publishedAcks(d)[c.id];
      expect(ack, d.name).toBeDefined();
      expect(compareEpochs((ack as Ack).epoch, e2), `${d.name} publie un accusé de ${e2} sur C`).toBeLessThan(0);
    }
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });
});
