import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../../src/domain/types';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-05 critère 6, point laissé non prouvé par la QA du lot Y2 et repris par Y-04 (critère 13 b) : **un cycle interrompu reprend où il
 * s'est arrêté** sur une file de 5 000 opérations. Le cycle de publication du PC est d'abord compté (écritures : ajouts au journal,
 * `state.ctx`, transactions), puis rejoué en mourant juste avant les écritures qui encadrent le premier ajout, celui du milieu et le dernier (avant l'ajout,
 * et entre l'ajout et le retrait de la file, là où l'intention `inflight` sert). Après redémarrage : file vide, chaque tâche publiée **une seule
 * fois** dans le journal du PC (aucun doublon), les 5 000 présentes sur l'iPhone (aucune perte). Aucun délai : arrêts par compteur.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COUNT = 5_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** PC et iPhone associés ; le PC a 5 000 tâches accumulées hors ligne, pas encore publiées. */
async function largeQueue(): Promise<[SimDevice, SimDevice]> {
  const pc = await createSimDevice(PC_ID, { name: 'PC' });
  const iphone = await createSimDevice(IPHONE_ID, { name: 'iPhone', clock: pc.clock });
  devices = [pc, iphone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, iphone);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  pc.clock.advance(1_000);
  const model = await pc.createTask('Modèle');
  await pc.data.transaction(async (repos) => {
    await repos.tasks.createMany(
      Array.from({ length: COUNT - 1 }, (_, i) => ({ ...model, id: `${String(i).padStart(8, '0')}-2222-4222-8222-aaaaaaaaaaaa` as TaskId, title: `Tâche ${String(i)}`, note: 'x'.repeat(400) })),
    );
  });
  expect(await pc.data.repos.sync.outboxCount()).toBe(COUNT);
  return [pc, iphone];
}

/** Opérations publiées par le PC dans son propre dossier : nombre de fois où chaque tâche apparaît (création complète). */
function publishedTasks(pc: SimDevice): Map<string, number> {
  const seen = new Map<string, number>();
  for (const epoch of pc.folder.devices.get(PC_ID)?.epochs.values() ?? []) {
    for (const segment of epoch.segments.values()) {
      for (const line of segment.lines) {
        const record = JSON.parse(line.text) as { k: string; ops?: { t: string; id: string; f: Record<string, unknown> }[] };
        for (const op of record.ops ?? []) {
          if (op.t !== 'task' || !('title' in op.f)) continue;
          seen.set(op.id, (seen.get(op.id) ?? 0) + 1);
        }
      }
    }
  }
  return seen;
}

/** Nombre d'écritures du cycle de publication et rang de celles qui encadrent un ajout au journal. */
async function measure(): Promise<{ writes: number; appendRanks: number[] }> {
  const [pc] = await largeQueue();
  const probe = armCrash(pc, null);
  const ranks: number[] = [];
  const platform = pc.platform as unknown as { appendJournal: (...args: unknown[]) => Promise<unknown> };
  const wrapped = platform.appendJournal;
  platform.appendJournal = (...args) => {
    // `armCrash` compte l'ajout dans `wrapped` : son rang est le compteur actuel + 1.
    ranks.push(probe.writes + 1);
    return wrapped(...args);
  };
  const status = await pc.cycle();
  expect(status.phase).toBe('idle');
  probe.disarm();
  const writes = probe.writes;
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  return { writes, appendRanks: ranks };
}

const { writes, appendRanks } = await measure();
/**
 * Premier ajout, ajout du milieu (« à mi-publication ») et dernier ajout : arrêt juste avant l'ajout, et juste après (avant la
 * transaction qui retire la file). Le cycle compte plusieurs dizaines d'ajouts ; ces trois-là couvrent début, milieu et fin.
 */
const SAMPLED = [...new Set([appendRanks[0], appendRanks[Math.floor(appendRanks.length / 2)], appendRanks.at(-1)])].filter((rank): rank is number => rank !== undefined);
const CRASH_POINTS = SAMPLED.flatMap((rank) => [rank, rank + 1]).filter((rank) => rank <= writes);

describe('Y-05 critère 6 : un cycle interrompu reprend où il s’est arrêté (5 000 opérations)', () => {
  it('la file part en plusieurs ajouts (plusieurs points d’arrêt possibles)', () => {
    expect(appendRanks.length).toBeGreaterThan(2);
    expect(CRASH_POINTS).toHaveLength(6);
  });

  it.each(CRASH_POINTS)('arrêt avant l’écriture n° %i : aucune perte, aucun doublon après redémarrage', async (crashAt) => {
    const [pc, iphone] = await largeQueue();
    const probe = armCrash(pc, crashAt);
    await pc.cycle();
    expect(probe.crashed).toBe(true);
    probe.disarm();
    // Le processus repart (nouvelle instance de l'app sur la même base et le même dossier).
    await pc.restart();
    expect((await pc.cycle()).phase).toBe('idle');
    expect(await pc.data.repos.sync.outboxCount()).toBe(0);
    expect(await pc.data.repos.sync.getMeta('inflight')).toBeNull();
    const published = publishedTasks(pc);
    expect(published.size).toBe(COUNT);
    expect([...published.values()].every((n) => n === 1)).toBe(true);
    syncFolders(devices);
    expect((await iphone.cycle()).phase).toBe('idle');
    expect(await iphone.driver.select('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL')).toEqual([{ n: COUNT }]);
    expect(await iphone.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
  }, 120_000);
});
