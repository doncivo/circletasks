import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskId } from '../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';
// Simulation à deux bases SQLite Wasm : marge pour une machine chargée (plusieurs lots en parallèle).
vi.setConfig({ testTimeout: 30_000 });

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  expect((await a.cycle()).phase).toBe('idle');
  await pair(a, b);
  expect((await b.cycle()).phase).toBe('idle');
  syncFolders(devices);
  return [a, b];
}

describe('deux appareils simulés (Y-02 critère 2)', () => {
  it('une tâche créée sur A arrive sur B avec les mêmes champs', async () => {
    const [a, b] = await twoDevices();
    const task = await a.createTask('Payer le loyer');
    a.clock.advance(1_000);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    const onB = await b.task(task.id);
    expect(onB?.title).toBe('Payer le loyer');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(b.changes.some((c) => c.tables.has('task'))).toBe(true);
  });

  it('deux champs différents modifiés des deux côtés : les deux gardés ; même champ : le plus grand hlc gagne, conflit des deux côtés', async () => {
    const [a, b] = await twoDevices();
    const task = await a.createTask('Courses');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    a.clock.advance(1_000);
    await a.updateTask(task.id, { title: 'Courses du samedi' });
    await b.updateTask(task.id as TaskId, { note: 'Lait, pain' });
    await a.cycle();
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    for (const d of devices) {
      const t = await d.task(task.id);
      expect(t?.title).toBe('Courses du samedi');
      expect(t?.note).toBe('Lait, pain');
    }
    // Même champ : B écrit après A (horloge plus tard) et gagne partout.
    await a.updateTask(task.id, { title: 'Titre A' });
    a.clock.advance(1_000);
    await b.updateTask(task.id, { title: 'Titre B' });
    await a.cycle();
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    expect((await a.task(task.id))?.title).toBe('Titre B');
    expect((await b.task(task.id))?.title).toBe('Titre B');
    const conflictsOf = (d: SimDevice) => d.driver.select('SELECT field, kept_value, discarded_value FROM conflict_log');
    expect(await conflictsOf(a)).toEqual([{ field: 'title', kept_value: '"Titre B"', discarded_value: '"Titre A"' }]);
    expect(await conflictsOf(b)).toEqual(await conflictsOf(a));
  });
});
