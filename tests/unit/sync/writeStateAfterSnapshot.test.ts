import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { createSimDevice, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * TRI-03 (audit 1.0, « writeState refusé en silence ») : l'étape 6 est déjà couverte (Y-IOS-02-FIX-02, `publish-blocked`). Restait l'écriture de
 * l'état juste après un instantané (étape 7) : son refus (`state-mismatch`, Rust maître) était ignoré, « snapshot-written » journalisé, aucun
 * avertissement, et l'appareil affichait « À jour » avec un état jamais annoncé.
 */
const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Après l'écriture d'un instantané, tout `writeState` est refusé `state-mismatch`. */
function refuseStateAfterSnapshot(d: SimDevice): void {
  const realSnapshot = d.platform.writeSnapshot.bind(d.platform);
  const realState = d.platform.writeState.bind(d.platform);
  let snapshotWritten = false;
  d.platform.writeSnapshot = async (request) => {
    await realSnapshot(request);
    snapshotWritten = true;
  };
  d.platform.writeState = async (request) => {
    if (snapshotWritten) throw new SyncPlatformError('state-mismatch');
    return realState(request);
  };
}

describe('TRI-03 : état refusé juste après un instantané', () => {
  it('le refus est visible (publish-blocked), jamais « À jour » ni silence', async () => {
    const a = await createSimDevice(A_ID, { name: 'A' });
    devices.push(a);
    await setupFirst(a);
    await a.createTask('T0');
    await a.cycle();
    a.clock.advance(8 * DAY);
    refuseStateAfterSnapshot(a);
    const status = await a.cycle();
    expect(a.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(true);
    expect(a.logger.entries.some((e) => e.event === 'write-state-failed')).toBe(true);
    expect(status.warnings ?? []).toContain('publish-blocked');
  });

  it('un état accepté après l’instantané ne lève rien (garde-fou contre un avertissement permanent)', async () => {
    const a = await createSimDevice(A_ID, { name: 'A' });
    devices.push(a);
    await setupFirst(a);
    await a.createTask('T0');
    await a.cycle();
    a.clock.advance(8 * DAY);
    const status = await a.cycle();
    expect(a.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(true);
    expect(status.warnings ?? []).not.toContain('publish-blocked');
  });
});
