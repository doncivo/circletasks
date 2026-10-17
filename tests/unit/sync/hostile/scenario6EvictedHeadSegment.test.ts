import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-TECH-03 (B13), scénario 6 du banc (revue S6, défaut nouveau n° 1 de la fiche) : iOS évince le segment de tête de l'iPhone (« optimiser
 * le stockage » : seul le substitut `.<nom>.icloud` reste). L'ajout suivant lit ce segment sans hydratation (`store.rs:1185`, même règle
 * dans `memory.ts`) et répond `cloud-pending` ; le moteur ne rouvre un segment que sur `segment-full` ou `segment-mismatch`
 * (`publisher.ts:450`) et `pin` ne fait rien sur iOS (`bookmark.rs:331`). Attendu : les écritures de l'iPhone arrivent au PC (téléchargement
 * du segment ou segment suivant), jamais « iCloud ne répond pas » pour toujours alors que le téléchargement est possible. Panne armée par le
 * plan (substitut présenté au premier listage du segment), téléchargement simulé de 1 s ; aucun délai réel. Rouge avec le code actuel :
 * gardé non suivi, livré avec la story de son correctif (à créer, gravité à trancher par Ali).
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 6 : segment de tête de l’iPhone évincé (défaut nouveau n° 1)', () => {
  it('les écritures suivantes de l’iPhone arrivent au PC, jamais « iCloud ne répond pas » pour toujours', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
    devices.push(a, b);
    await setupFirst(a);
    await a.createTask('Tâche PC');
    await a.cycle();
    await pair(a, b);
    await b.createTask('iPhone 1');
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    syncFolders([a, b]);
    expect(b.folder.fileNames(b.id).filter((f) => f.endsWith('.ctj'))).toHaveLength(1);
    // iOS évince le segment de tête de l'iPhone ; le téléchargement est possible (1 s).
    b.folder.armFaults({ name: 'tete-evincee', faults: [{ id: 'head-placeholder', op: 'list', file: `devices/${B_ID}/*/j-*.ctj`, nth: 1, effect: 'placeholder' }] });
    b.platform.testing.setHydrationDelay(1_000);
    const late = await b.createTask('iPhone 2');
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(60_000);
      statuses.push(await b.cycle());
      syncFolders([a, b]);
    }
    await a.cycle();
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['head-placeholder']);
    const last = statuses.at(-1);
    if (!last) throw new Error('aucun cycle');
    expect(b.logger.entries.filter((e) => e.event === 'publish-failed').length, 'publish-failed { cloud-pending } à chaque cycle').toBeLessThan(3);
    expect(last.phase).not.toBe('waiting-icloud');
    expect(statusLine(last, b.clock.nowMs())).toContain('À jour');
    expect((await a.task(late.id))?.title).toBe('iPhone 2');
  });
});
