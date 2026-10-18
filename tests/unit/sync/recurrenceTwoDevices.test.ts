import { afterEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../../src/domain/id';
import { syncTable } from '../../../src/domain/sync/syncTables';
import type { TaskId } from '../../../src/domain/types';
import { createTaskEntities } from '../../../src/features/app/taskEntities';
import { createRecurrenceUseCases } from '../../../src/features/tasks/recurrenceUseCases';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';
import { bootDevice, createRecurringTask, type BootedDevice, type BootOptions } from '../../sim/syncStartup';

/**
 * T-TECH-01 (bloquant B8 de l'audit 1.0), scénarios à deux appareils : A est le PC, B l'iPhone. Les appareils partagent une horloge
 * manuelle (aucun délai) ; le démarrage suit l'ordre réel de `App.tsx` (`tests/sim/syncStartup.ts`).
 *
 * A : l'occurrence suivante d'une récurrence générée sur chaque appareil avant toute synchro ne doit exister qu'une fois.
 * B : une tâche terminée sur A ne doit pas être reportée par B qui ne l'avait pas encore lue (tâche simple : un seul défaut à la fois).
 * C : un report manuel sur A (date poussée au futur) ne doit pas être écrasé par le report automatique de B.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY_23 = '2026-10-23T12:00:00.000Z';
const DAY_24 = '2026-10-24T12:00:00.000Z';

let devices: SimDevice[] = [];
let booted: BootedDevice[] = [];
afterEach(async () => {
  for (const b of booted) b.dispose();
  booted = [];
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Deux appareils associés, le 23 à midi, bases identiques. */
async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const pc = await createSimDevice(PC_ID, { name: 'PC', start: DAY_23 });
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

/** Un tour complet de synchro dans les deux sens (iCloud à jour partout, chacun lit puis publie). */
async function settle(pc: SimDevice, iphone: SimDevice): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    syncFolders(devices);
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
  }
  syncFolders(devices);
  await pc.cycle();
}

async function start(device: SimDevice, options: BootOptions = {}): Promise<void> {
  const b = await bootDevice(device, options);
  booted.push(b);
  await b.settled();
}

const rows = (d: SimDevice, sql: string): Promise<unknown[]> => d.driver.select(sql);

describe('T-TECH-01 scénario A : occurrence générée des deux côtés avant toute synchro', () => {
  it('une seule ligne vivante pour (R, 1), même identifiant, un seul jeu de rappels, bases égales', async () => {
    const [pc, iphone] = await twoDevices();
    const { recurrenceId } = await createRecurringTask(pc, 'Prendre les vitamines', { date: '2026-10-23' as never, time: '09:00', offsets: [5, 60] });
    await settle(pc, iphone);

    // Le 24 sur les deux appareils, sans aucune synchro entre-temps : chacun génère (R, 1) et reporte de son côté.
    pc.clock.set(DAY_24);
    await start(pc);
    await start(iphone);
    await settle(pc, iphone);

    const occurrences = `SELECT id FROM task WHERE recurrence_id = '${recurrenceId}' AND series_index = 1 AND deleted_at IS NULL ORDER BY id`;
    const onPc = await rows(pc, occurrences);
    const onIphone = await rows(iphone, occurrences);
    expect(onPc).toHaveLength(1);
    expect(onIphone).toHaveLength(1);
    expect(onIphone).toEqual(onPc);
    const id = (onPc[0] as { id: string }).id;
    const reminders = `SELECT id, offset_min FROM reminder WHERE target_type = 'task' AND target_id = '${id}' AND deleted_at IS NULL ORDER BY offset_min`;
    expect(await rows(pc, reminders)).toHaveLength(2);
    expect(await rows(iphone, reminders)).toEqual(await rows(pc, reminders));
    // Égalité de structure (pas d'inclusion) : toutes les colonnes des tâches et des rappels.
    for (const table of ['task', 'reminder']) expect(await rows(iphone, `SELECT * FROM ${table} ORDER BY id`)).toEqual(await rows(pc, `SELECT * FROM ${table} ORDER BY id`));
  });
});

describe('T-TECH-01 scénario B : terminée sur A, report sur B', () => {
  it('la tâche reste terminée, datée du 23, non reportée, des deux côtés', async () => {
    const [pc, iphone] = await twoDevices();
    const task = await pc.createTask('Envoyer la facture', { date: '2026-10-23' as never });
    await settle(pc, iphone);

    pc.clock.advance(3 * 3_600_000);
    await pc.updateTask(task.id, { status: 'done', doneAt: new Date(pc.clock.nowMs()).toISOString() as never });
    await pc.cycle();
    syncFolders(devices); // iCloud a livré le journal de A à B, mais B ne l'a pas encore lu

    pc.clock.set(DAY_24);
    await start(iphone);
    await settle(pc, iphone);

    for (const d of [pc, iphone]) {
      const t = await d.task(task.id as TaskId);
      expect(t?.status).toBe('done');
      expect(t?.date).toBe('2026-10-23');
      expect(t?.carriedOver).toBe(false);
    }
  });
});

describe('T-TECH-01 scénario B : épreuve de détection (porte forcée ouverte)', () => {
  it('sans la porte, le banc voit le défaut : tâche terminée mais datée du 24 et reportée', async () => {
    const [pc, iphone] = await twoDevices();
    const task = await pc.createTask('Envoyer la facture', { date: '2026-10-23' as never });
    await settle(pc, iphone);
    pc.clock.advance(3 * 3_600_000);
    await pc.updateTask(task.id, { status: 'done', doneAt: new Date(pc.clock.nowMs()).toISOString() as never });
    await pc.cycle();
    syncFolders(devices);

    pc.clock.set(DAY_24);
    await start(iphone, { forceOpenGate: true });
    await settle(pc, iphone);

    for (const d of [pc, iphone]) {
      const t = await d.task(task.id as TaskId);
      expect(t?.status).toBe('done');
      expect(t?.date).toBe('2026-10-24');
      expect(t?.carriedOver).toBe(true);
    }
  });
});

describe('T-TECH-01 I2 : identifiant déterministe tombé sur une ligne purgée', () => {
  it('occurrence purgée sur les deux appareils puis régénérée : identifiant aléatoire, acceptée par l’autre appareil', async () => {
    const [pc, iphone] = await twoDevices();
    const { recurrenceId } = await createRecurringTask(pc, 'Prendre les vitamines', { date: '2026-10-23' as never, time: '09:00', offsets: [5, 60] });
    await settle(pc, iphone);
    pc.clock.set(DAY_24);
    const generate = (d: SimDevice) => createRecurrenceUseCases({ clock: d.clock, ids: uuidGenerator, data: d.data, taskEntities: createTaskEntities() }).generateDue();
    const [first] = await generate(iphone);
    await settle(pc, iphone);
    const zId = first?.id as TaskId;
    expect(await pc.task(zId)).not.toBeNull();

    // Purge physique de l'occurrence (et de ses rappels) sur les deux appareils : traces de suppression, plus de ligne.
    for (const d of [pc, iphone]) {
      const reminders = (await d.driver.select<{ id: string }>(`SELECT id FROM reminder WHERE target_id = '${zId}'`)).map((r) => r.id);
      await d.data.repos.sync.insertTombstones([{ table: 'task', rowId: zId, deletedHlc: d.hlc.now() }, ...reminders.map((rowId) => ({ table: 'reminder', rowId, deletedHlc: d.hlc.now() }))], new Date(d.clock.nowMs()).toISOString() as never);
      await d.data.repos.sync.deleteRows(syncTable('reminder') as never, reminders);
      await d.data.repos.sync.deleteRows(syncTable('task') as never, [zId]);
    }
    const [again] = await generate(iphone);
    await settle(pc, iphone);

    expect(again?.id).not.toBe(zId); // l'identifiant déterministe est purgé : identifiant aléatoire
    const live = `SELECT id FROM task WHERE recurrence_id = '${recurrenceId}' AND series_index = 1 AND deleted_at IS NULL`;
    expect(await rows(iphone, live)).toHaveLength(1);
    expect(await rows(pc, live)).toEqual(await rows(iphone, live)); // l'autre appareil a bien reçu la ligne
  });
});

describe('T-TECH-01 scénario C : report manuel sur A', () => {
  it('la tâche reste datée du 26, non reportée, des deux côtés', async () => {
    const [pc, iphone] = await twoDevices();
    const task = await pc.createTask('Appeler le garage', { date: '2026-10-23' as never });
    await settle(pc, iphone);

    pc.clock.advance(3 * 3_600_000);
    await pc.updateTask(task.id, { date: '2026-10-26' as never });
    await pc.cycle();
    syncFolders(devices);

    pc.clock.set(DAY_24);
    await start(iphone);
    await settle(pc, iphone);

    for (const d of [pc, iphone]) {
      const t = await d.task(task.id as TaskId);
      expect(t?.date).toBe('2026-10-26');
      expect(t?.carriedOver).toBe(false);
    }
  });
});
