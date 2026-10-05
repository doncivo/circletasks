import { afterEach, describe, expect, it } from 'vitest';
import { routineLogId } from '../../../src/domain/sync/naturalIds';
import type { IsoDateTime, LocalDate, RoutineId, RoutineLogId } from '../../../src/domain/types';
import { createSimDevice, pair, PRO, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Purge des autres tables et identifiants naturels après purge (ADR 0011, sections 5.4 et 8 ; Y-09 critères 3, 4 et 6) : les journaux
 * de routine sont purgés par le moteur comme les tâches ; cocher de nouveau un jour purgé est une recréation complète acceptée.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;
const ROUTINE = '33333333-3333-4333-8333-333333333333' as RoutineId;
const DATE = '2026-10-03' as LocalDate;
const LOG = routineLogId(ROUTINE, DATE) as RoutineLogId;

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
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    for (const d of devices) await d.cycle();
    syncFolders(devices);
  }
}

const doneAt = (d: SimDevice): IsoDateTime => new Date(d.clock.nowMs()).toISOString() as IsoDateTime;

/** Une routine, un jour coché puis décoché (ligne supprimée), tout lu par les deux appareils. */
async function routineWithDeletedLog(): Promise<[SimDevice, SimDevice]> {
  const [a, b] = await twoDevices();
  await a.data.repos.routines.create({ id: ROUTINE, spaceId: PRO, title: 'Lire', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-10-01', time: null, archived: false } as never);
  a.clock.advance(1_000);
  await a.data.repos.routineLogs.markDone(ROUTINE, DATE, doneAt(a), LOG);
  await settle();
  a.clock.advance(1_000);
  await a.data.repos.routineLogs.unmark(ROUTINE, DATE);
  await settle();
  return [a, b];
}

describe('purge des autres tables par le moteur (Y-09 critères 3 et 6)', () => {
  it('journal de routine supprimé, lu par tous, 30 jours : purgé des deux côtés, identifiant déterministe tracé sans contenu', async () => {
    const [a, b] = await routineWithDeletedLog();
    for (const d of devices) expect(await d.driver.select('SELECT id FROM routine_log'), `${d.name} avant`).toEqual([{ id: LOG }]);
    a.clock.advance(29 * DAY);
    await settle();
    for (const d of devices) expect(await d.driver.select('SELECT id FROM routine_log'), `${d.name} à 29 jours`).toHaveLength(1);
    a.clock.advance(2 * DAY);
    await settle();
    for (const d of devices) {
      expect(await d.driver.select('SELECT id FROM routine_log'), `${d.name} à 31 jours`).toEqual([]);
      expect(await d.driver.select('SELECT table_name, row_id FROM sync_tombstone'), d.name).toEqual([{ table_name: 'routine_log', row_id: LOG }]);
      expect(await d.driver.select("SELECT * FROM sync_field_clock WHERE table_name = 'routine_log'"), d.name).toEqual([]);
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('cocher de nouveau un jour purgé : recréation complète acceptée par l’autre appareil, trace retirée là-bas', async () => {
    const [a, b] = await routineWithDeletedLog();
    a.clock.advance(31 * DAY);
    await settle();
    a.clock.advance(1_000);
    await a.data.repos.routineLogs.markDone(ROUTINE, DATE, doneAt(a), LOG);
    await settle();
    expect(await b.driver.select('SELECT id, deleted_at FROM routine_log'), 'B voit la journée cochée').toEqual([{ id: LOG, deleted_at: null }]);
    expect(await b.driver.select('SELECT * FROM sync_tombstone'), 'trace retirée chez B').toEqual([]);
  });

  /**
   * DÉFAUT D3 (signalé, voir le rapport de QA du lot Y2) : A recrée localement un jour de routine purgé (INSERT) ; sa propre trace
   * `sync_tombstone` reste en base (aucun code local ne la retire : seul `apply.ts` le fait, pour une opération reçue). Quand B décoche
   * ensuite ce jour, l'opération partielle `deleted_at` reçue par A vise une ligne qui existe et un identifiant tracé : `apply.ts`
   * (condition `row.exists`) la rejette. A reste coché, B décoché : divergence permanente.
   */
  it.fails('DÉFAUT D3 : jour purgé recoché sur A puis décoché sur B : décoché partout', async () => {
    const [a, b] = await routineWithDeletedLog();
    a.clock.advance(31 * DAY);
    await settle();
    a.clock.advance(1_000);
    await a.data.repos.routineLogs.markDone(ROUTINE, DATE, doneAt(a), LOG);
    await settle();
    a.clock.advance(1_000);
    await b.data.repos.routineLogs.unmark(ROUTINE, DATE);
    await settle();
    expect(await b.driver.select('SELECT deleted_at IS NOT NULL AS deleted FROM routine_log')).toEqual([{ deleted: 1 }]);
    expect(await a.driver.select('SELECT deleted_at IS NOT NULL AS deleted FROM routine_log'), 'A voit le décochage de B').toEqual([{ deleted: 1 }]);
  });
});

describe('nouvel appareil après une recréation (Y-09 critères 4 et 11)', () => {
  it('jour purgé puis recoché : un appareil qui rejoint par l’instantané voit la journée cochée (la trace de A ne l’efface pas)', async () => {
    const [a] = await routineWithDeletedLog();
    a.clock.advance(31 * DAY);
    await settle();
    a.clock.advance(1_000);
    await a.data.repos.routineLogs.markDone(ROUTINE, DATE, doneAt(a), LOG);
    await settle();
    a.clock.advance(8 * DAY);
    await settle();
    const c = await createSimDevice('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await settle();
    await settle();
    expect(await c.driver.select('SELECT id, deleted_at FROM routine_log')).toEqual([{ id: LOG, deleted_at: null }]);
    expect(await a.driver.select('SELECT id, deleted_at FROM routine_log')).toEqual([{ id: LOG, deleted_at: null }]);
  });
});
