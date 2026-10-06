import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10, seconde revue point 1 (bloquant) : un instantané dont l'auteur est oublié n'est jamais proposé, ni à l'arrivée d'un appareil
 * (join.ts) ni à une reprise (resumeFromSnapshot). X, pas encore au courant de son oubli, écrit un instantané plus récent que celui de A,
 * avec des écritures au-delà de sa coupure ; N rejoint : il a la même base que A. Horloge commune contrôlée, aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const N_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
}

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task ORDER BY title')).map((r) => r.title);
const snapshotCount = (d: SimDevice, of: string): number => [...(d.folder.devices.get(of)?.epochs.values() ?? [])].reduce((n, e) => n + e.snapshots.size, 0);

/** A et X associés ; X écrit X1 lu par A ; A oublie X. X n'apprend rien. */
async function aForgetsX(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  const x = await createSimDevice(X_ID, { name: 'X', clock: a.clock });
  devices.push(x);
  await pair(a, x);
  await x.cycle();
  await settle([a, x]);
  await x.createTask('X1');
  await settle([a, x]);
  expect(await titles(a)).toEqual(['X1']);
  expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
  return [a, x];
}

/** X, sans rien savoir, écrit X2 puis un instantané (une semaine plus tard) ; seul son propre dossier le reçoit. */
async function xWritesNewerSnapshot(x: SimDevice): Promise<void> {
  await x.createTask('X2');
  x.clock.advance(8 * DAY);
  const before = snapshotCount(x, x.id);
  await x.cycle();
  expect(snapshotCount(x, x.id)).toBeGreaterThan(before);
  expect(await titles(x)).toEqual(['X1', 'X2']);
}

describe('instantané d’un auteur oublié jamais proposé (seconde revue, point 1)', () => {
  it('arrivée : X écrit un instantané plus récent avec X2 au-delà de sa coupure ; N rejoint par A : même base que A, sans X2', async () => {
    const [a, x] = await aForgetsX();
    // A ne lit plus X : sa coupure s'arrête à X1 ; il écrit son instantané avant la suppression.
    await xWritesNewerSnapshot(x);
    const n = await createSimDevice(N_ID, { name: 'N', clock: a.clock });
    devices.push(n);
    await pair(a, n);
    // iCloud remet à N le dossier de X (fichiers pas encore supprimés), avec l'instantané plus récent.
    propagate(x.folder, n.folder, x.id);
    expect(snapshotCount(n, x.id)).toBeGreaterThan(0);
    await n.cycle();
    await settle([a, n]);
    expect(await titles(a)).toEqual(['X1']);
    expect(await taskSnapshot(n)).toEqual(await taskSnapshot(a));
  });

  it('reprise : A, à reprendre depuis l’instantané, ne prend jamais celui de X même plus récent', async () => {
    const [a, x] = await aForgetsX();
    await xWritesNewerSnapshot(x);
    // A reçoit le dossier de X (instantané plus récent) avant de l'avoir supprimé, et doit reprendre depuis l'instantané.
    propagate(x.folder, a.folder, x.id);
    await a.data.repos.sync.setMeta('resume', 'true');
    await a.cycle();
    expect(await titles(a)).toEqual(['X1']);
  });
});

describe('finalisation en attente tant que Rust n’a pas inscrit la cible dans done (seconde revue, point 5)', () => {
  it('dossier de X disparu (supprimé ailleurs) mais B n’a pas encore republié : « finalisation en attente de B », jusqu’à done', async () => {
    const a = await createSimDevice(A_ID, { name: 'A' });
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const others: SimDevice[] = [];
    for (const id of ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', X_ID]) {
      const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: a.clock });
      devices.push(d);
      others.push(d);
      await pair(a, d);
      await d.cycle();
      syncFolders(devices);
    }
    await settle(devices);
    const [b, x] = others as [SimDevice, SimDevice];
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    // Le dossier de X disparaît d'iCloud (supprimé par un autre appareil) ; B n'a pas encore lu l'oubli.
    a.folder.devices.delete(x.id);
    a.clock.advance(1_000);
    await a.cycle();
    const line = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id);
    expect(line).toEqual({ deviceId: x.id, state: 'finalizing', waitingFor: b.id });
    expect(a.platform.testing.forgottenRegistry()?.done ?? []).not.toContain(x.id);
    // B lit l'oubli, republie la déclaration et accuse la coupure : Rust inscrit X dans done, la ligne s'efface.
    b.folder.devices.delete(x.id);
    await settle([a, b]);
    expect(a.platform.testing.forgottenRegistry()?.done ?? []).toContain(x.id);
    expect(a.service.status().forget?.deletions ?? []).toEqual([]);
  });
});
