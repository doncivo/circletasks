import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../tests/sim/syncDevice';

/** @perf (ADR 0011 section 10.2 ; Y-02 critère 3) : cycle sans changement < 300 ms ; nouvel appareil de 5 000 tâches < 15 s. */

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('@perf synchro', () => {
  it('nouvel appareil de 5 000 tâches en moins de 15 s ; cycle sans changement en moins de 300 ms', async () => {
    const a = await createSimDevice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const b = await createSimDevice('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { clock: a.clock });
    devices = [a, b];
    await setupFirst(a);
    const model = await a.createTask('Modèle');
    await a.data.transaction(async (repos) => {
      for (let i = 0; i < 4_999; i += 1) await repos.tasks.create({ ...model, id: `${String(i).padStart(8, '0')}-2222-4222-8222-aaaaaaaaaaaa` as TaskId, title: `Tâche ${String(i)}` });
    });
    await a.cycle();
    await pair(a, b);
    const started = performance.now();
    await b.cycle();
    const join = performance.now() - started;
    expect((await b.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task'))[0]?.n).toBe(5_000);
    syncFolders(devices);
    await b.cycle();
    const idleStart = performance.now();
    await b.cycle();
    const idle = performance.now() - idleStart;
    expect(join).toBeLessThan(15_000);
    expect(idle).toBeLessThan(300);
  }, 120_000);
});
