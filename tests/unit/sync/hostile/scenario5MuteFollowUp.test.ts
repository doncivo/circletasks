import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SyncStatus } from '../../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-IOS-05 (B6), critères 5 et 6 : suite du scénario 5 du banc (transport muet). L'échéance du faux (`MUTE_DEADLINE_TURNS` tours de
 * micro-tâche, memory.ts) rend `cloud-pending` ; le cycle suivant aboutit (`times: 1`), ou l'attente devient durable et visible
 * (`times: 3` : `errorStreak`, `retryAt`, `waiting-icloud`, `waitingSince`). Aucune attente réelle : chaque cycle est attendu jusqu'à sa fin.
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
interface Plan {
  readonly name: string;
  readonly faults: readonly Record<string, unknown>[];
}
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly Plan[] };
const scenario5 = fixture.plans.find((p) => p.name === 'scenario-5-transport-muet') as Plan;
const withTimes = (times: number): Plan => ({ ...scenario5, faults: scenario5.faults.map((f) => ({ ...f, times })) });

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function pairedPhone(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  await a.createTask('Tâche PC');
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders([a, b]);
  return b;
}

describe('Y-IOS-05 : après l’échéance du transport muet (critères 5 et 6)', () => {
  it('critère 5 : times 1, le cycle suivant aboutit (idle, plus de code ni de série d’échecs)', async () => {
    const b = await pairedPhone();
    b.folder.armFaults(withTimes(1));
    const first = await b.cycle();
    expect(first.errorCode).toBe('cloud-pending');
    expect(b.folder.mutedCalls()).toEqual([]);
    b.clock.advance(60_000);
    const second = await b.cycle();
    // Cycle abouti (`outcome: 'done'` du moteur, vu par l'état) : synchro complète datée de ce cycle.
    expect(second.lastSyncAt).toBeTruthy();
    expect(second.lastSyncAt).not.toBe(first.lastSyncAt);
    expect(second.phase).toBe('idle');
    expect(second.errorCode ?? null).toBeNull();
    expect(second.errorStreak).toBeUndefined();
    expect(b.folder.mutedCalls()).toEqual([]);
  });

  it('critère 6 : times 3, trois cycles : cloud-pending durable, errorStreak 3, retryAt posé, waiting-icloud, waitingSince gardé', async () => {
    const b = await pairedPhone();
    b.folder.armFaults(withTimes(3));
    const seen: SyncStatus[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(await b.cycle());
      b.clock.advance(60_000);
    }
    for (const status of seen) {
      expect(status.errorCode).toBe('cloud-pending');
      expect(status.phase).toBe('waiting-icloud');
    }
    expect(seen.map((s) => s.errorStreak ?? 1)).toEqual([1, 2, 3]);
    expect(seen[2]?.retryAt).toBeTruthy();
    expect(seen[0]?.waitingSince).toBeTruthy();
    expect(seen[1]?.waitingSince).toBe(seen[0]?.waitingSince);
    expect(seen[2]?.waitingSince).toBe(seen[0]?.waitingSince);
    expect(b.folder.mutedCalls()).toEqual([]);
  });
});
