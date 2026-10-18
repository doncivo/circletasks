import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import type { SyncStatus } from '../../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-TECH-03 (B13), scénario 5 du banc, critère 23 (B6) : un appel au transport iCloud ne répond jamais (listage du dossier du PC, panne
 * « muette » du plan `scenario-5-transport-muet` : promesse jamais résolue côté memory.ts). Attendu : le transport sort par `cloud-pending`
 * à l'échéance de l'appel et la synchro n'affiche pas « Synchro en cours » indéfiniment. L'échéance est simulée par un compteur du test
 * (tours de micro-tâches comptés, `CALL_DEADLINE_TURNS`), jamais par une attente réelle. Si ce scénario est rouge avec le code actuel, il
 * est livré sur la branche de Y-IOS-05 (`call_with_deadline` sur le transport, et sa modélisation dans memory.ts).
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** Échéance d'un appel au transport, en tours de micro-tâches (compteur, jamais une durée). */
const CALL_DEADLINE_TURNS = 500;
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 5 : transport muet (critère 23, B6)', () => {
  it('le cycle sort par cloud-pending à l’échéance de l’appel, jamais « Synchro en cours » indéfiniment', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
    devices.push(a, b);
    await setupFirst(a);
    await a.createTask('Tâche PC');
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders([a, b]);
    b.folder.armFaults(fixture.plans.find((p) => p.name === 'scenario-5-transport-muet'));
    let settled: SyncStatus | null = null;
    const cycle = b.cycle().then((status) => {
      settled = status;
      return status;
    });
    let turns = 0;
    while (settled === null && turns < CALL_DEADLINE_TURNS) {
      await Promise.resolve();
      turns += 1;
    }
    const muted = b.folder.mutedCalls();
    try {
      // Le correctif (Y-IOS-05) devra COMPTER l'échéance de l'appel (rang, tours, cycles du faux), jamais la chronométrer : aucun
      // setTimeout ni horloge réelle dans memory.ts ni dans ce test. Attendu d'abord : le cycle s'est terminé, par cloud-pending.
      expect(settled, 'le cycle ne s’est pas terminé à l’échéance comptée de l’appel').not.toBeNull();
      const status = settled as SyncStatus | null;
      expect(status?.errorCode ?? (status?.pendingFiles.length ? 'cloud-pending' : null)).toBe('cloud-pending');
      expect(status?.phase).not.toBe('syncing');
      expect(muted).toEqual([]);
      expect(statusLine(b.service.status(), b.clock.nowMs())).not.toContain('Synchro en cours');
    } finally {
      // Jamais de promesse laissée en suspens après le test : l'appel muet est rejoué (entrée consommée) et le cycle se termine.
      for (const call of muted) b.folder.releaseMuted(call.id, 'complete');
      await cycle;
    }
  });
});
