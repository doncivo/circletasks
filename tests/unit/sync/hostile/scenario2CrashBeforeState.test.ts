import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-TECH-03 (B13), scénario 2 du banc, critère 20 (B2, cousin S2 de B1) : arrêt brutal entre l'ajout du premier segment et l'écriture de
 * `state.ctx` lors de la première publication d'un appareil associé. Au redémarrage, l'appareil doit détecter l'état manquant et publier (ou
 * le signaler visiblement), jamais rester `publish-blocked` pour toujours. Arrêt armé par compteur d'écritures (`armCrash`), jamais par le
 * temps. Si ce scénario est rouge avec le code actuel, il est livré sur la branche de Y-FIX-02 (règle d'Ali).
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** PC qui publie, iPhone associé avec une tâche locale, jamais publié. */
async function joined(): Promise<{ a: SimDevice; b: SimDevice }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  await a.createTask('Tâche PC');
  await a.cycle();
  await pair(a, b);
  await b.createTask('Écrite sur l’iPhone avant la première publication');
  return { a, b };
}

/**
 * Rang de l'écriture de `state.ctx` qui suit le premier ajout au journal pendant le premier cycle de l'iPhone (comptage sans arrêt sur un
 * jeu identique : le simulateur est déterministe).
 */
async function stateWriteRank(): Promise<number> {
  const { b } = await joined();
  const probe = armCrash(b, null);
  const platform = b.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let appended = false;
  let rank: number | null = null;
  for (const name of ['appendJournal', 'writeState'] as const) {
    const real = platform[name] as (...args: unknown[]) => Promise<unknown>;
    platform[name] = (...args) => {
      if (name === 'appendJournal') appended = true;
      if (name === 'writeState' && appended && rank === null) rank = probe.writes + 1;
      return real.apply(b.platform, args);
    };
  }
  await b.cycle();
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  if (rank === null) throw new Error('aucune écriture de state.ctx après un ajout au premier cycle');
  return rank;
}

describe('Y-TECH-03 scénario 2 : arrêt entre le premier segment et state.ctx (critère 20, B2)', () => {
  it('au redémarrage, l’appareil publie son état (ou le signale), jamais publish-blocked pour toujours', async () => {
    const rank = await stateWriteRank();
    const { a, b } = await joined();
    const probe = armCrash(b, rank);
    await b.cycle();
    expect(probe.crashed).toBe(true);
    probe.disarm();
    // État laissé par l'arrêt : un segment de l'iPhone dans iCloud, aucun state.ctx.
    expect(b.folder.fileNames(b.id).some((f) => f.endsWith('.ctj'))).toBe(true);
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    await b.restart();
    const statuses: Awaited<ReturnType<SimDevice['cycle']>>[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(await b.cycle());
      syncFolders([a, b]);
    }
    const last = statuses.at(-1);
    expect(b.folder.fileNames(b.id)).toContain('state.ctx');
    expect(last?.warnings ?? []).not.toContain('publish-blocked');
    if (!last) throw new Error('aucun cycle');
    expect(statusLine(last, b.clock.nowMs())).toContain('À jour');
    await a.cycle();
    expect((await a.data.repos.sync.getStates()).some((r) => r.deviceId === b.id)).toBe(true);
  });
});
