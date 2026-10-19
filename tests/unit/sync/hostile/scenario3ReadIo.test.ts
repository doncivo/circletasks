import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-TECH-03 (B13), scénario 3 du banc, critère 21 (B3) : la lecture du journal d'un autre appareil échoue en `io` (verrou iCloud, fréquent
 * sous Windows) pendant un cycle. Attendu : l'appareil lu est signalé, `lastSyncAt` n'avance pas, le statut n'est pas « À jour » et
 * l'entretien est sauté visiblement ; au cycle suivant (panne consommée), tout se lit et « À jour » revient. Panne armée au rang 1 par le
 * plan `scenario-3-lecture-io` de la fixture. Si ce scénario est rouge avec le code actuel, il est livré sur la branche de Y-FIX-03.
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 3 : lecture d’un journal en échec io pendant un cycle (critère 21, B3)', () => {
  it('appareil signalé, lastSyncAt figé, jamais « À jour » ; lu et « À jour » au cycle suivant', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
    devices.push(a, b);
    await setupFirst(a);
    await a.createTask('Tâche PC 1');
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    syncFolders([a, b]);
    const before = await b.cycle();
    expect(statusLine(before, b.clock.nowMs())).toContain('À jour');
    const lastSyncAt = before.lastSyncAt;
    // Nouvelle écriture du PC, recopiée chez l'iPhone ; la lecture de son journal échoue au rang 1.
    a.clock.advance(60_000);
    const late = await a.createTask('Tâche PC 2');
    await a.cycle();
    syncFolders([a, b]);
    b.folder.armFaults(fixture.plans.find((p) => p.name === 'scenario-3-lecture-io'));
    const failed = await b.cycle();
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['read-journal-io']);
    expect(b.logger.entries.find((e) => e.event === 'read-failed')?.detail).toMatchObject({ code: 'io' });
    expect(await b.task(late.id)).toBeNull();
    // Attendus de B3 : rien n'indique une synchro complète.
    expect(failed.lastSyncAt).toBe(lastSyncAt);
    expect(statusLine(failed, b.clock.nowMs())).not.toContain('À jour');
    const pc = failed.devices.find((d) => d.deviceId === a.id);
    const signalled = failed.phase === 'error' || (failed.warnings?.length ?? 0) > 0 || (pc !== undefined && pc.status !== 'active');
    expect(signalled).toBe(true);
    // Panne consommée : lu, « À jour ».
    a.clock.advance(60_000);
    const ok = await b.cycle();
    expect((await b.task(late.id))?.title).toBe('Tâche PC 2');
    expect(statusLine(ok, b.clock.nowMs())).toContain('À jour');
    expect(ok.lastSyncAt).not.toBe(lastSyncAt);
  });
});
