import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-TECH-01 (vérification du coordinateur) : une lecture authentifiée qui fonde une décision met l'anti-rejeu à jour. `sync_forgotten_delete`
 * lit l'état de chaque appareil connu ; un état plus récent qu'il a lu (sans scan entre-deux) entre dans l'anti-rejeu, et un ancien état
 * remis ensuite par un tiers est `rollback`. Même règle que Rust (`read_all_states`, `sync_forget.rs`). Horloge simulée.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
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

describe('Y-TECH-01 : anti-rejeu mis à jour par les lectures de la suppression d’un oublié', () => {
  it('état de B lu seulement par la suppression, puis ancien état remis : rollback', async () => {
    const a = await createSimDevice(A_ID, { name: 'A' });
    const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
    const x = await createSimDevice(X_ID, { name: 'X', clock: a.clock });
    devices = [a, b, x];
    await setupFirst(a);
    await a.cycle();
    for (const d of [b, x]) {
      await pair(a, d);
      await d.cycle();
      syncFolders(devices);
    }
    await x.createTask('X1');
    await settle(devices);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b], 4);
    // B publie un nouvel état ; A le reçoit mais ne le lit que par la suppression (aucun scan entre-deux).
    const old = a.folder.takeState(b.id);
    await b.createTask('B après');
    b.clock.advance(1_000);
    await b.cycle();
    propagate(b.folder, a.folder, b.id);
    await a.platform.forget.deleteFiles(x.id as DeviceId);
    // Un tiers remet l'ancien état de B chez A.
    a.folder.putState(old);
    const scan = await a.platform.scan({ keep: [] });
    expect(scan.devices.find((d) => d.deviceId === b.id)?.stateStatus).toBe('rollback');
  });
});
