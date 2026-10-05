import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Arrêt pendant la reprise depuis l'instantané (ADR 0011 section 5.5 ; Y-02 critère 12, Y-09 critère 7 ; revue Y2 point 2) : la reprise
 * est mémorisée avant toute modification, les curseurs ne sont posés qu'avec la dernière transaction (lignes et traces appliquées). Un
 * arrêt à n'importe quelle transaction de la reprise est rattrapé au redémarrage, sans perte.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/**
 * Arrêt simulé : la `n`-ième transaction ouverte après la lecture de l'instantané échoue (l'app s'arrête), puis plus rien n'échoue.
 * Indépendant du code de la reprise : la base n'est touchée que par transactions.
 */
function crashAfterSnapshotRead(device: SimDevice, n: number): void {
  const read = device.platform.readSnapshot.bind(device.platform);
  let snapshotRead = false;
  device.platform.readSnapshot = async (request) => {
    snapshotRead = true;
    return read(request);
  };
  const transaction = device.data.transaction.bind(device.data);
  let count = 0;
  let crashed = false;
  (device.data as { transaction: typeof transaction }).transaction = async (work) => {
    if (snapshotRead && !crashed) {
      count += 1;
      if (count === n) {
        crashed = true;
        throw new Error('arrêt simulé');
      }
    }
    return transaction(work);
  };
}

/** A seul pendant 40 jours : une tâche supprimée puis purgée (trace), une tâche gardée, un instantané hebdomadaire. */
async function folderWithSnapshot(): Promise<{ a: SimDevice; kept: string; purged: string }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  const gone = await a.createTask('Purgée');
  await a.cycle();
  a.clock.advance(1_000);
  await a.deleteTask(gone.id);
  await a.cycle();
  a.clock.advance(31 * DAY);
  await a.cycle();
  expect(await a.task(gone.id)).toBeNull();
  const kept = await a.createTask('Gardée');
  await a.cycle();
  a.clock.advance(8 * DAY);
  await a.cycle();
  return { a, kept: kept.id, purged: gone.id };
}

describe('arrêt pendant la reprise depuis l’instantané (revue Y2, point 2)', () => {
  for (const n of [1, 2]) {
    it(`arrêt à la transaction ${String(n)} de la reprise d’un nouvel appareil : au redémarrage, la reprise est rejouée, rien ne manque`, async () => {
      const { a, kept, purged } = await folderWithSnapshot();
      const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs()) });
      devices.push(b);
      await pair(a, b);
      crashAfterSnapshotRead(b, n);
      expect((await b.cycle()).phase).toBe('error');
      // Redémarrage de l'app : même base, même dossier.
      await b.restart();
      expect((await b.cycle()).phase).toBe('idle');
      expect((await b.task(kept as never))?.title).toBe('Gardée');
      expect(await b.driver.select('SELECT row_id FROM sync_tombstone')).toEqual([{ row_id: purged }]);
      expect(await b.data.repos.sync.getMeta('resume')).toBeNull();
      syncFolders(devices);
      await a.cycle();
      expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    });
  }
});
