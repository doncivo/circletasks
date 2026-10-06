import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02, ADR 0011 §21 point 2 (simulation, rouge avant) : iCloud transfère les fichiers dans le désordre ; un segment clos livré dans
 * une version ancienne n'est plus sauté (attente, puis lecture complète) ; une ligne incomplète dans un segment clos ne fait plus attendre
 * sans fin. Horloge simulée, aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  for (let r = 0; r < 2; r += 1) {
    for (const d of devices) {
      syncFolders(devices);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  syncFolders(devices);
  return [a, b];
}

/** Le prochain ajout de A est refusé une fois avec `code` : le moteur ouvre le segment suivant. */
function refuseNextAppend(a: SimDevice, code: 'segment-full' | 'segment-mismatch'): void {
  const real = a.platform.appendJournal.bind(a.platform);
  let refused = false;
  a.platform.appendJournal = async (request) => {
    if (!refused) {
      refused = true;
      throw new SyncPlatformError(code);
    }
    return real(request);
  };
}

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
const segmentOne = (d: SimDevice, of: string) => {
  const epochs = d.folder.devices.get(of)?.epochs;
  const [, dir] = [...(epochs ?? new Map())].at(-1) as [string, { segments: Map<number, unknown> }];
  return dir;
};

describe('segments clos et désordre d’iCloud (§21 point 2)', () => {
  it('B reçoit l’état et j-(k+1) avant la dernière version de j-k : attente, puis lecture complète, bases identiques', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('T1');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    // Version de j-1 que B garde (iCloud ne lui livrera la suivante que plus tard).
    const old = structuredClone(segmentOne(b, a.id).segments.get(1));
    a.clock.advance(1_000);
    await a.createTask('T2');
    await a.cycle();
    refuseNextAppend(a, 'segment-full');
    a.clock.advance(1_000);
    await a.createTask('T3');
    await a.cycle();
    expect([...segmentOne(a, a.id).segments.keys()]).toEqual([1, 2]);
    propagate(a.folder, b.folder, a.id);
    segmentOne(b, a.id).segments.set(1, old);
    const waiting = await b.cycle();
    expect(waiting.phase).toBe('waiting-icloud');
    expect(await titles(b)).toEqual(['T1']);
    // La dernière version de j-1 arrive : B lit tout, dans l'ordre.
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await titles(b)).toEqual(['T1', 'T2', 'T3']);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('ajout interrompu sur une ligne incomplète, puis rotation : B lit tout, aucune attente sans fin', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('T1');
    await a.cycle();
    // Arrêt pendant un ajout : une ligne incomplète reste à la fin de j-1 ; l'ajout suivant est refusé (segment-mismatch), le moteur
    // ouvre j-2.
    const file = segmentOne(a, a.id).segments.get(1) as { partialTail: boolean };
    file.partialTail = true;
    a.clock.advance(1_000);
    await a.createTask('T2');
    await a.cycle();
    expect([...segmentOne(a, a.id).segments.keys()]).toEqual([1, 2]);
    syncFolders(devices);
    const status = await b.cycle();
    expect(status.phase).toBe('idle');
    expect(await titles(b)).toEqual(['T1', 'T2']);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});
