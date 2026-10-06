import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskId } from '../../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-05 critère 6 (« sans bloquer l'interface »), défaut 1 de la QA de Y-04 : pendant la mise en forme d'une grosse file, la base n'est
 * jamais tenue par une transaction ; une lecture ou une écriture de l'interface demandée à un retour à la boucle d'événements aboutit
 * avant le retour suivant. Aucun délai réel : `performance.now` est piloté par un compteur et `scheduler.yield` passe par `setImmediate`.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COUNT = 1_100;
const taskId = (i: number): TaskId => `${String(i).padStart(8, '0')}-3333-4333-8333-aaaaaaaaaaaa` as TaskId;
const globals = globalThis as { scheduler?: unknown };

let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete globals.scheduler;
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function seeded(): Promise<[SimDevice, SimDevice]> {
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
  const model = await pc.createTask('Tâche 0', { id: taskId(0) });
  await pc.data.transaction((repos) => repos.tasks.createMany(Array.from({ length: COUNT - 1 }, (_, i) => ({ ...model, id: taskId(i + 1), title: `Tâche ${String(i + 1)}` }))));
  return [pc, iphone];
}

describe('Y-05 critère 6 : la publication libère la base entre deux tranches', () => {
  it.each([2, 5, 10])('lecture et écriture de l’interface demandées au retour n° %i : abouties avant le retour suivant, écriture publiée au cycle suivant', async (at) => {
    const [pc, iphone] = await seeded();
    let tick = 0;
    let yields = 0;
    let readDoneAt: number | null = null;
    let writeDoneAt: number | null = null;
    vi.spyOn(performance, 'now').mockImplementation(() => (tick += 1));
    globals.scheduler = {
      yield: async () => {
        yields += 1;
        if (yields === at) {
          void pc.data.repos.tasks.getById(taskId(7)).then(() => (readDoneAt = yields));
          void pc.updateTask(taskId(8), { title: 'Écrite pendant la publication' }).then(() => (writeDoneAt = yields));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
    await pc.cycle();
    expect(yields).toBeGreaterThan(at + 1);
    expect(readDoneAt).toBe(at);
    expect(writeDoneAt).toBe(at);
    vi.restoreAllMocks();
    delete globals.scheduler;
    for (let i = 0; i < 2; i += 1) {
      syncFolders(devices);
      await pc.cycle();
      syncFolders(devices);
      await iphone.cycle();
    }
    expect(await pc.data.repos.sync.outboxCount()).toBe(0);
    expect((await iphone.task(taskId(8)))?.title).toBe('Écrite pendant la publication');
    expect(await iphone.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
    expect(await taskSnapshot(iphone)).toEqual(await taskSnapshot(pc));
  }, 120_000);
});
