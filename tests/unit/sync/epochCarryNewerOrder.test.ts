import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HexColor, ProjectId, TaskId } from '../../../src/domain/types';
import { setEpochSwitchTestHooks } from '../../../src/sync/epochSwitch';
import { PRO, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { applyEverywhere, backupOf, readByBoth, rounds, rowsOf, tasksUnder, twoDevices } from './epochCarryKit';

/**
 * Y-FIX-04 (critère 4, revue I3) : \`carryNewer\` (\`src/sync/epochSwitch.ts\`) parque les écritures faites pendant le changement d'époque
 * dans l'ordre du catalogue (parents avant enfants), pas dans l'ordre de la file. Écritures de B pendant son changement, juste après
 * l'étape (a) : la tâche T est modifiée (la table \`task\` entre la première dans la file), le projet Q est créé, T est déplacée sous Q.
 * Dans l'ordre de la file, T serait parquée avant Q et \`reapply\` la croirait sous un parent remplacé (rattachée à tort) ; dans l'ordre du
 * catalogue, Q passe avant T et T garde son projet.
 */

const Q_ID = '0f000000-0000-4000-8000-00000000002f' as ProjectId;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  setEpochSwitchTestHooks({});
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-FIX-04 : ordre de `carryNewer`', () => {
  it('écritures pendant le changement (T modifiée, Q créé, T sous Q) : Q parqué avant T, T garde project_id = Q', async () => {
    const [a, b] = await twoDevices();
    devices = [a, b];
    // T créée par B et lue par A avant la sauvegarde : elle est dans la base restaurée, rien n'est reporté par la matérialisation.
    const [t] = await b.data.repos.tasks.createMany(tasksUnder(null, 1, '3'));
    const id = t?.id as TaskId;
    await b.cycle();
    syncFolders(devices);
    await readByBoth(a, b);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await applyEverywhere(a, copy);
    syncFolders(devices);

    let wrote = false;
    const order: string[] = [];
    setEpochSwitchTestHooks({
      afterStep: async (step) => {
        if (step === 'a' && !wrote) {
          wrote = true;
          await b.updateTask(id, { title: 'Modifiée pendant le changement' });
          await b.data.repos.projects.create({ id: Q_ID, spaceId: PRO, name: 'Q', color: '#123456' as HexColor, archived: false, sortOrder: 1 });
          await b.updateTask(id, { projectId: Q_ID });
        }
        if (step === 'b' && order.length === 0) {
          for (const row of await b.driver.select<{ row_id: string }>("SELECT row_id FROM sync_parked WHERE reason = 'epoch-carry' ORDER BY id")) order.push(row.row_id);
        }
      },
    });
    await b.cycle();
    expect(wrote).toBe(true);
    expect(order).toContain(Q_ID);
    expect(order).toContain(id);
    expect(order.indexOf(Q_ID)).toBeLessThan(order.indexOf(id));
    await rounds(devices);
    for (const d of [a, b]) {
      expect((await d.task(id))?.projectId, d.name).toBe(Q_ID);
      expect((await d.task(id))?.title, d.name).toBe('Modifiée pendant le changement');
    }
    expect(b.logger.entries.filter((e) => e.event === 'epoch-carry-reattached')).toEqual([]);
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
    expect(await rowsOf(a, 'project')).toEqual(await rowsOf(b, 'project'));
  });
});
