import { afterEach, describe, expect, it } from 'vitest';
import type { RecurrenceId, TaskId } from '../../../src/domain/types';
import { createTaskEntities } from '../../../src/features/app/taskEntities';
import { runRecurrenceDedupOnce } from '../../../src/features/tasks/recurrenceDedup';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * T-TECH-01 critère 17 : le nettoyage des doublons sur deux appareils. Doublons hérités des versions d'avant les identifiants
 * déterministes : X créée sur A, Y sur B, même (R, 1), connues des deux appareils.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X = '10000000-0000-4000-8000-00000000000a' as TaskId;
const Y = '10000000-0000-4000-8000-00000000000b' as TaskId;
const R = '30000000-0000-4000-8000-000000000001' as RecurrenceId;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function settle(a: SimDevice, b: SimDevice): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
  }
  syncFolders(devices);
  await a.cycle();
}

async function legacyDuplicates(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A', start: '2026-10-23T12:00:00.000Z' });
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  await a.data.repos.recurrences.create({ id: R, freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
  await settle(a, b);
  await a.createTask('Vitamines', { id: X, recurrenceId: R, seriesIndex: 1, date: '2026-10-24' as never, time: '09:00' as never });
  a.clock.advance(1000);
  await b.createTask('Vitamines', { id: Y, recurrenceId: R, seriesIndex: 1, date: '2026-10-24' as never, time: '09:00' as never });
  await settle(a, b);
  return [a, b];
}

const pass = (d: SimDevice) => runRecurrenceDedupOnce({ data: d.data, taskEntities: createTaskEntities(), log: () => undefined });
const rowsOf = (d: SimDevice): Promise<unknown[]> => d.driver.select('SELECT * FROM task ORDER BY id');
const liveOf = (d: SimDevice): Promise<unknown[]> => d.driver.select(`SELECT id, status FROM task WHERE recurrence_id = '${R}' AND series_index = 1 AND deleted_at IS NULL ORDER BY id`);

describe('nettoyage sur deux appareils (T-TECH-01 critère 17)', () => {
  it('mêmes doublons des deux côtés : mêmes survivants, bases identiques après synchronisation', async () => {
    const [a, b] = await legacyDuplicates();
    await pass(a);
    await pass(b);
    await settle(a, b);
    expect(await liveOf(a)).toEqual([{ id: Y, status: 'todo' }]); // Y créée après X : hlc le plus récent
    expect(await liveOf(b)).toEqual(await liveOf(a));
    expect(await rowsOf(b)).toEqual(await rowsOf(a));
  });

  it('données différentes (complétion lue par A seulement) : bases identiques, complétion rétablie au démarrage suivant', async () => {
    const [a, b] = await legacyDuplicates();
    a.clock.advance(1000);
    await a.updateTask(X, { status: 'done', doneAt: new Date(a.clock.nowMs()).toISOString() as never });
    a.clock.advance(1000);
    await pass(a); // A garde X (terminée), écarte Y
    await pass(b); // B ne connaît pas la complétion : garde Y, écarte X
    await settle(a, b);
    // Les deux suppressions sont de vraies écritures : états identiques, X (terminée) dans la Corbeille, jamais effacée.
    expect(await rowsOf(b)).toEqual(await rowsOf(a));
    expect((await a.task(X))?.status).toBe('done');
    expect(await liveOf(a)).toEqual([]);

    // Démarrage suivant : la vérification rétablit la complétion écartée par erreur.
    await pass(a);
    await pass(b);
    await settle(a, b);
    expect(await liveOf(a)).toEqual([{ id: X, status: 'done' }]);
    expect(await liveOf(b)).toEqual(await liveOf(a));
    expect(await rowsOf(b)).toEqual(await rowsOf(a));
  });

  it('un nouvel appareil qui reçoit le nettoyage ne le refait pas et ne rétablit rien', async () => {
    const [a, b] = await legacyDuplicates();
    await pass(a);
    await settle(a, b);
    expect(await pass(b)).toEqual({ groups: 0, removed: 0, restored: 0 }); // B ne voit plus de doublon vivant
    await settle(a, b);
    expect(await liveOf(b)).toEqual(await liveOf(a));
    expect(await liveOf(a)).toHaveLength(1);
  });
});
