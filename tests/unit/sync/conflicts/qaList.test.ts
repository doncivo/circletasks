import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFLICTS_PAGE_SIZE } from '../../../../src/features/sync/syncConflictUseCases';
import { openConflictBench, otherHlc, type ConflictBench } from './kit';

/**
 * QA de Y-04 (critère 4) : bornes de la pagination (50 exactement, 51), fenêtre de 12 mois au jour près, ordre stable entre les pages,
 * restauration d'un conflit de la deuxième page. Horloge manuelle : aucun délai.
 */

let bench: ConflictBench;

beforeEach(async () => {
  bench = await openConflictBench();
});

afterEach(async () => {
  await bench.close();
});

async function many(count: number): Promise<number[]> {
  const task = await bench.createTask('Beaucoup');
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: `k${String(i)}`, discarded: `d${String(i)}`, keptHlc: otherHlc(i + 10) }));
  }
  return ids;
}

describe('Y-04 critère 4 : pagination', () => {
  it('Y-04 critère 4 : exactement 50 conflits : une page, pas de « Afficher plus »', async () => {
    await many(CONFLICTS_PAGE_SIZE);
    const page = await bench.useCases.list(1);
    expect(page.items).toHaveLength(CONFLICTS_PAGE_SIZE);
    expect(page.hasMore).toBe(false);
  });

  it('Y-04 critère 4 : 51 conflits : 50 puis « Afficher plus » donne le 51e, sans doublon ni trou, du plus récent au plus ancien', async () => {
    const ids = await many(CONFLICTS_PAGE_SIZE + 1);
    const one = await bench.useCases.list(1);
    expect(one.hasMore).toBe(true);
    expect(one.items.map((v) => v.id)).toEqual(ids.slice(1).reverse());
    const two = await bench.useCases.list(2);
    expect(two.hasMore).toBe(false);
    expect(two.items.map((v) => v.id)).toEqual([...ids].reverse());
    expect(new Set(two.items.map((v) => v.id)).size).toBe(two.items.length);
  });

  it('Y-04 critère 4 : un conflit de la deuxième page se restaure comme les autres', async () => {
    const ids = await many(CONFLICTS_PAGE_SIZE + 1);
    const oldest = (await bench.useCases.list(2)).items.at(-1);
    expect(oldest?.id).toBe(ids[0]);
    expect(await bench.useCases.restore(oldest?.id ?? 0)).toEqual({ status: 'restored' });
    const after = await bench.useCases.list(2);
    expect(after.items.at(-1)).toMatchObject({ id: ids[0], restored: true });
    expect(after.items).toHaveLength(CONFLICTS_PAGE_SIZE + 1);
  });

  it('Y-04 critère 4 : page demandée à 0 ou négative : au moins une page, jamais une liste vide à tort', async () => {
    await many(3);
    expect((await bench.useCases.list(0)).items).toHaveLength(3);
    expect((await bench.useCases.list(-2)).items).toHaveLength(3);
  });
});

describe('Y-04 critère 4 : fenêtre de 12 mois', () => {
  const DAY = 86_400_000;
  it('Y-04 critère 4 : un conflit de 364 jours est listé, un conflit de 366 jours ne l’est pas', async () => {
    const task = await bench.createTask('Fenêtre');
    const now = bench.clock.nowMs();
    const at = (ms: number) => new Date(ms).toISOString();
    const recent = await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'a', discarded: 'b', detectedAt: at(now - 364 * DAY), keptHlc: otherHlc(10) });
    await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'c', discarded: 'd', detectedAt: at(now - 366 * DAY), keptHlc: otherHlc(11) });
    expect((await bench.useCases.list(1)).items.map((v) => v.id)).toEqual([recent]);
  });

  it('Y-04 critère 4 : la fenêtre glisse avec l’horloge (un conflit listé aujourd’hui ne l’est plus un an plus tard)', async () => {
    const task = await bench.createTask('Glissante');
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'a', discarded: 'b' });
    expect((await bench.useCases.list(1)).items.map((v) => v.id)).toEqual([id]);
    bench.clock.advance(364 * DAY);
    expect((await bench.useCases.list(1)).items.map((v) => v.id)).toEqual([id]);
    bench.clock.advance(2 * DAY);
    expect((await bench.useCases.list(1)).items).toEqual([]);
  });
});
