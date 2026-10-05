import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * QA de Y-05 critère 4 (« une modification qui succède à une valeur connue n'est jamais un conflit ») et critère 3 (aucune perte) :
 * l'utilisateur réécrit un champ d'une ligne **créée et pas encore publiée** pendant que sa publication est en cours (entre la lecture
 * de la file et le retrait de ses entrées). La valeur finale est juste partout ; mais l'autre appareil ne doit inscrire aucun conflit :
 * les deux valeurs viennent du même appareil, l'une après l'autre.
 *
 * Cause : le déclencheur de modification (0015_sync_tables.ts, `perColumn`) reprend la base du champ (aucune : la ligne vient d'être
 * créée) tant qu'une entrée `'*'` attend dans la file ; `clearPublished` (sql/syncRepository.ts) retire ensuite l'entrée `'*'` sans
 * rattacher la base des champs réécrits depuis (`if (entry.field === '*') continue;`). La valeur publiée plus tard annonce donc « je
 * n'ai connu aucune valeur » alors que l'autre appareil a déjà reçu la création.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const pc = await createSimDevice(PC_ID, { name: 'PC' });
  const iphone = await createSimDevice(IPHONE_ID, { name: 'iPhone', clock: pc.clock });
  devices = [pc, iphone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, iphone);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  return [pc, iphone];
}

async function settle(pc: SimDevice, iphone: SimDevice): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    syncFolders(devices);
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
  }
}

describe('Y-05 critère 4 : réécriture d’un champ pendant la publication de la création de sa ligne', () => {
  it('Y-05 critère 4 : titre réécrit entre la lecture de la file et l’ajout au journal : valeur juste partout, aucun conflit sur l’autre appareil', async () => {
    const [pc, iphone] = await twoDevices();
    pc.clock.advance(1_000);
    const task = await pc.createTask('Envoyer la facture');
    const platform = pc.platform as unknown as { appendJournal: (...args: unknown[]) => Promise<unknown> };
    const real = platform.appendJournal.bind(pc.platform);
    let first = true;
    platform.appendJournal = async (...args) => {
      if (first) {
        first = false;
        pc.clock.advance(1_000);
        await pc.updateTask(task.id as TaskId, { title: 'Envoyer la facture de septembre' });
      }
      return real(...args);
    };
    await pc.cycle();
    await settle(pc, iphone);
    for (const d of devices) expect((await d.task(task.id))?.title).toBe('Envoyer la facture de septembre');
    expect(await iphone.driver.select('SELECT table_name, field, kept_device, discarded_device FROM conflict_log')).toEqual([]);
    expect(await pc.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
  });
});
