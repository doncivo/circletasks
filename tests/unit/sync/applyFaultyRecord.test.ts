import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * TRI-24 (audit 1.0, « un enregistrement fautif bloque toute la synchro ») : une opération reçue que la base locale refuse (contrainte
 * d'unicité, NOT NULL, CHECK…) faisait échouer le lot entier (500 opérations en une transaction) ; le curseur restait avant le lot, rejoué et
 * refusé à chaque cycle : plus rien d'autre n'arrivait. Désormais l'opération fautive est isolée, journalisée (table et code, jamais le
 * contenu), le reste du lot est appliqué, le curseur avance et l'avertissement `received-unapplied` reste visible jusqu'à la reprise complète.
 */
const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs()) });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

const titlesOf = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);

/** Deux tâches de même titre chez A ; B refuse la seconde (index unique propre à B : la violation que ferait une règle de la base locale). */
async function faultyBatch(a: SimDevice, b: SimDevice): Promise<void> {
  await b.driver.execute('CREATE UNIQUE INDEX ux_tri24_title ON task(title)');
  for (const title of ['Avant', 'Doublon', 'Doublon', 'Après']) {
    a.clock.advance(1_000);
    await a.createTask(title);
  }
  await a.cycle();
  syncFolders(devices);
}

describe('TRI-24 : une opération refusée par la base locale ne bloque pas le reste', () => {
  it('le reste du lot est appliqué, l’avertissement est visible, le curseur avance', async () => {
    const [a, b] = await twoDevices();
    await faultyBatch(a, b);
    const status = await b.cycle();
    expect(await titlesOf(b)).toEqual(['Après', 'Avant', 'Doublon']);
    expect(status.phase).not.toBe('error');
    expect(status.warnings ?? []).toContain('received-unapplied');
    expect(b.logger.entries.filter((e) => e.event === 'apply-rejected').map((e) => e.detail)).toEqual([expect.objectContaining({ table: 'task', code: 'constraint' })]);
    // Aucun contenu dans le journal : ni titre, ni identifiant.
    expect(JSON.stringify(b.logger.entries)).not.toContain('Doublon');
  });

  it('la synchro continue : une tâche créée ensuite arrive, et l’avertissement survit à un redémarrage', async () => {
    const [a, b] = await twoDevices();
    await faultyBatch(a, b);
    await b.cycle();
    a.clock.advance(1_000);
    await a.createTask('Encore');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect(await titlesOf(b)).toContain('Encore');
    await b.restart();
    const after = await b.cycle();
    expect(after.warnings ?? []).toContain('received-unapplied');
  });

  it('garde-fou : sans opération refusée, aucun avertissement ni journal de rejet', async () => {
    const [a, b] = await twoDevices();
    for (const title of ['Un', 'Deux']) {
      a.clock.advance(1_000);
      await a.createTask(title);
    }
    await a.cycle();
    syncFolders(devices);
    const status = await b.cycle();
    expect(await titlesOf(b)).toEqual(['Deux', 'Un']);
    expect(status.warnings ?? []).not.toContain('received-unapplied');
    expect(b.logger.entries.some((e) => e.event === 'apply-rejected')).toBe(false);
  });
});
