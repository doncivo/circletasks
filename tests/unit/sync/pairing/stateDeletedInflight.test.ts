import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, setupFirst, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-FIX-02, revue B1 (option a) : voisin de `joinAfterRecords.test.ts:97` (§24 point 10, état supprimé après publication, `stateSeq`
 * local > 0), avec une intention d'ajout en cours (arrêt entre `appendJournal` et sa transaction). La publication reste refusée : aucune
 * reprise de l'intention, aucun état réécrit à `stateSeq + 1`, intention gardée et stable d'un cycle à l'autre ; avertissement visible.
 */

const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Appareil qui a publié son état (stateSeq 1), puis une tâche en file. */
async function published(): Promise<SimDevice> {
  const b = await createSimDevice(B_ID, { name: 'iPhone' });
  devices.push(b);
  await setupFirst(b);
  expect((await b.cycle()).phase).toBe('idle');
  await b.createTask('Écrite après la première publication');
  return b;
}

/** Rang de l'écriture qui suit le premier `appendJournal` du cycle (la transaction d'ajout), comptée sans arrêt. */
async function afterAppendRank(): Promise<number> {
  const b = await published();
  const probe = armCrash(b, null);
  const platform = b.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = platform['appendJournal'] as (...args: unknown[]) => Promise<unknown>;
  let rank: number | null = null;
  platform['appendJournal'] = (...args) => {
    rank ??= probe.writes + 2;
    return real.apply(b.platform, args);
  };
  await b.cycle();
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  if (rank === null) throw new Error('aucun ajout au journal');
  return rank;
}

const meta = async (d: SimDevice, key: string): Promise<unknown> => {
  const raw = await d.data.repos.sync.getMeta(key);
  return raw === null ? null : JSON.parse(raw);
};

describe('état supprimé après publication, intention d’ajout en cours (revue B1)', () => {
  it('publication refusée : intention gardée et stable, aucun état réécrit, avertissement, jamais « À jour »', async () => {
    const rank = await afterAppendRank();
    const b = await published();
    const probe = armCrash(b, rank);
    await b.cycle();
    expect(probe.crashed).toBe(true);
    probe.disarm();
    const inflight = await meta(b, 'inflight');
    expect(inflight).not.toBeNull();
    // Le dossier perd l'état publié ; l'historique local existe (stateSeq 1) et aucun autre appareil n'a d'accusé.
    const own = b.folder.devices.get(b.id);
    if (own) own.state = null;
    await b.restart();
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const blocked = await b.cycle();
      expect(blocked.warnings, `cycle ${String(cycle)}`).toContain('publish-blocked');
      expect(statusLine(blocked, b.clock.nowMs())).not.toContain('À jour');
      expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
      expect(await meta(b, 'inflight')).toEqual(inflight);
      expect(await meta(b, 'stateSeq')).toBe(1);
    }
    expect(b.logger.entries.filter((e) => e.event === 'inflight-resolved')).toHaveLength(0);
  });
});
