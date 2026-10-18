import { afterEach, describe, expect, it } from 'vitest';
import type { RecurrenceId, TaskId } from '../../../src/domain/types';
import { runRecurrenceDedupOnce } from '../../../src/features/tasks/recurrenceDedup';
import { createTaskEntities } from '../../../src/features/app/taskEntities';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * T-TECH-01, critère 14 : SPIKE d'une heure, technique du nettoyage des doublons existants. Deux candidats appliqués à deux appareils aux
 * données volontairement différentes (X terminée sur A seulement, pas encore lue par B) :
 *   1. migration SQL pure sous `sync_guard` (comme la 0016) : écritures sans hlc, donc jamais publiées ;
 *   2. passage JavaScript (`runRecurrenceDedupOnce`) : vrais hlc, entrées d'envoi normales.
 * Lancé par la suite comme preuve de la décision (fiche T-TECH-01, « Preuves »).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X = '10000000-0000-4000-8000-00000000000a' as TaskId;
const Y = '10000000-0000-4000-8000-00000000000b' as TaskId;

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

/** Doublons hérités : X créée sur A, Y sur B, même (R, 1), les deux appareils les connaissent ; puis X terminée sur A, pas encore lue par B. */
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
  const recurrenceId = '30000000-0000-4000-8000-000000000001' as RecurrenceId;
  await a.data.repos.recurrences.create({ id: recurrenceId, freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
  await settle(a, b);
  await a.createTask('Vitamines', { id: X, recurrenceId, seriesIndex: 1, date: '2026-10-24' as never });
  a.clock.advance(1000);
  await b.createTask('Vitamines', { id: Y, recurrenceId, seriesIndex: 1, date: '2026-10-24' as never });
  await settle(a, b);
  a.clock.advance(1000);
  await a.updateTask(X, { status: 'done', doneAt: new Date(a.clock.nowMs()).toISOString() as never });
  a.clock.advance(1000);
  return [a, b];
}

const state = async (d: SimDevice): Promise<unknown[]> => d.driver.select(`SELECT id, status, deleted_at IS NOT NULL AS deleted FROM task WHERE id IN ('${X}', '${Y}') ORDER BY id`);

/** Migration candidate : survivant par ROW_NUMBER (terminée, hlc récent, id petit), écarts par `deleted_at` sans hlc, sous `sync_guard`. */
const SQL_CANDIDATE = [
  'INSERT OR IGNORE INTO sync_guard (id) VALUES (1)',
  `UPDATE task SET deleted_at = updated_at WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY recurrence_id, series_index ORDER BY (status = 'done') DESC, hlc DESC, id ASC) AS rn
     FROM task WHERE deleted_at IS NULL AND recurrence_id IS NOT NULL AND series_index >= 0) WHERE rn > 1)`,
  'DELETE FROM sync_guard',
];

describe('T-TECH-01 spike : technique du nettoyage (critère 14)', () => {
  it('1. migration SQL pure : les deux appareils divergent (chacun garde une ligne différente)', async () => {
    const [a, b] = await legacyDuplicates();
    for (const d of [a, b]) for (const sql of SQL_CANDIDATE) await d.driver.execute(sql);
    await settle(a, b);
    const onA = await state(a);
    const onB = await state(b);
    // eslint-disable-next-line no-console -- relevé du spike, copié dans la fiche
    console.info('[spike SQL] A', JSON.stringify(onA), 'B', JSON.stringify(onB));
    expect(onB).not.toEqual(onA);
  });

  it('2. passage JavaScript : mêmes états des deux côtés après synchronisation', async () => {
    const [a, b] = await legacyDuplicates();
    const results = [await runRecurrenceDedupOnce({ data: a.data, taskEntities: createTaskEntities() }), await runRecurrenceDedupOnce({ data: b.data, taskEntities: createTaskEntities() })];
    await settle(a, b);
    const onA = await state(a);
    const onB = await state(b);
    // eslint-disable-next-line no-console -- relevé du spike, copié dans la fiche
    console.info('[spike JS] A', JSON.stringify(onA), 'B', JSON.stringify(onB), JSON.stringify(results));
    const conflicts = async (d: SimDevice) => d.driver.select('SELECT table_name, field, kept_value, discarded_value FROM conflict_log');
    console.info('[spike JS conflits] A', JSON.stringify(await conflicts(a)), 'B', JSON.stringify(await conflicts(b)));
    expect(onB).toEqual(onA);
    // Démarrage suivant : la vérification rétablit la ligne terminée écartée par erreur.
    const again = [await runRecurrenceDedupOnce({ data: a.data, taskEntities: createTaskEntities() }), await runRecurrenceDedupOnce({ data: b.data, taskEntities: createTaskEntities() })];
    await settle(a, b);
    console.info('[spike JS après vérification] A', JSON.stringify(await state(a)), 'B', JSON.stringify(await state(b)), JSON.stringify(again));
    expect(await state(b)).toEqual(await state(a));
  });
});
