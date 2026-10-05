import { afterEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../../../src/domain/id';
import type { TaskId } from '../../../../src/domain/types';
import { createTaskEntities } from '../../../../src/features/app/taskEntities';
import { createUndoStack } from '../../../../src/features/app/undo';
import { createSyncConflictUseCases, type SyncConflictUseCases } from '../../../../src/features/sync/syncConflictUseCases';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Parcours 10 en intégration (Y-04 critère 11 ; Y-02 critère 2, Y-05 critère 4 ; ADR 0011 §12) : deux appareils simulés (bases SQLite
 * Wasm, `HlcClock`, dossiers iCloud simulés), cas d'usage réels. Même tâche, même champ modifiés hors ligne (heure 10:00 sur le PC,
 * 09:00 sur l'iPhone) : le même conflit est inscrit des deux côtés ; le PC restaure ; au cycle suivant l'iPhone a la même valeur et
 * n'inscrit aucun nouveau conflit ; les appareils convergent. Deux champs différents : aucun conflit.
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

const conflictsOf = (d: SimDevice): SyncConflictUseCases =>
  createSyncConflictUseCases({ clock: d.clock, ids: uuidGenerator, data: d.data, undo: createUndoStack(), taskEntities: createTaskEntities(), logger: d.logger });

const conflictLog = (d: SimDevice) =>
  d.driver.select('SELECT table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc FROM conflict_log ORDER BY id');

/** Une tâche connue des deux appareils. */
async function sharedTask(pc: SimDevice, iphone: SimDevice): Promise<TaskId> {
  const task = await pc.createTask('Envoyer la facture', { time: '08:00' as never });
  await pc.cycle();
  syncFolders(devices);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  expect((await iphone.task(task.id))?.time).toBe('08:00');
  return task.id;
}

describe('parcours 10 : conflit hors ligne, consultation et restauration', () => {
  it('même tâche, même champ : même conflit des deux côtés ; restauration sur le PC ; l’iPhone suit sans nouveau conflit', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);

    // Hors ligne : chacun modifie l'heure et publie dans son propre dossier, sans recopie iCloud.
    pc.clock.advance(60_000);
    await pc.updateTask(id, { time: '10:00' as never });
    await pc.cycle();
    pc.clock.advance(6 * 60_000);
    await iphone.updateTask(id, { time: '09:00' as never });
    await iphone.cycle();

    // Retour en ligne : les deux se synchronisent.
    syncFolders(devices);
    await pc.cycle();
    await iphone.cycle();
    syncFolders(devices);

    for (const d of devices) expect((await d.task(id))?.time).toBe('09:00');
    const onPc = await conflictLog(pc);
    expect(onPc).toEqual([
      expect.objectContaining({ table_name: 'task', row_id: id, field: 'time', kept_value: '"09:00"', discarded_value: '"10:00"', kept_device: IPHONE_ID, discarded_device: PC_ID }),
    ]);
    expect(await conflictLog(iphone)).toEqual(onPc);

    // Consultation : le journal du PC montre la valeur gardée (iPhone) et la valeur écartée (PC).
    const pcConflicts = conflictsOf(pc);
    const [view] = (await pcConflicts.list(1)).items;
    expect(view).toMatchObject({ title: 'Envoyer la facture', restored: false, blocked: null });
    expect(view?.kept).toMatchObject({ value: '09:00', device: IPHONE_ID });
    expect(view?.discarded).toMatchObject({ value: '10:00', device: PC_ID });

    // Restauration sur le PC.
    pc.clock.advance(60_000);
    expect(await pcConflicts.restore(view?.id ?? 0)).toEqual({ status: 'restored' });
    expect((await pc.task(id))?.time).toBe('10:00');

    // Cycle suivant : l'iPhone a la même valeur, aucun nouveau conflit d'un côté ni de l'autre.
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    for (const d of devices) {
      expect((await d.task(id))?.time).toBe('10:00');
      expect(await d.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 1 }]);
    }
    expect(await taskSnapshot(iphone)).toEqual(await taskSnapshot(pc));
    expect(await iphone.driver.select('SELECT time FROM task ORDER BY id')).toEqual(await pc.driver.select('SELECT time FROM task ORDER BY id'));

    // Sur l'iPhone, la valeur écartée est déjà en place : « Restaurer » ne réécrit rien et marque le conflit résolu (critère 10).
    const iphoneConflicts = conflictsOf(iphone);
    const [onIphone] = (await iphoneConflicts.list(1)).items;
    expect(await iphoneConflicts.restore(onIphone?.id ?? 0)).toEqual({ status: 'already' });
    expect(await iphone.driver.select("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'task'")).toEqual([{ n: 0 }]);
    expect((await iphoneConflicts.list(1)).items[0]?.restored).toBe(true);
  });

  it('restauration puis annulation (5 s) : l’autre appareil converge sur la valeur gardée, sans conflit inventé', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);
    pc.clock.advance(60_000);
    await pc.updateTask(id, { time: '10:00' as never });
    await pc.cycle();
    pc.clock.advance(60_000);
    await iphone.updateTask(id, { time: '09:00' as never });
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    await iphone.cycle();

    const undo = createUndoStack();
    const useCases = createSyncConflictUseCases({ clock: pc.clock, ids: uuidGenerator, data: pc.data, undo, taskEntities: createTaskEntities(), logger: pc.logger });
    const [view] = (await useCases.list(1)).items;
    pc.clock.advance(1_000);
    await useCases.restore(view?.id ?? 0);
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
    pc.clock.advance(1_000);
    expect((await undo.undoLast()).status).toBe('undone');
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    for (const d of devices) {
      expect((await d.task(id))?.time).toBe('09:00');
      expect(await d.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 1 }]);
    }
  });

  it('supprimée sur l’iPhone, modifiée sur le PC : conflit « supprimé / modifié » ; « Restaurer » ramène la tâche partout (critère 7)', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);
    pc.clock.advance(60_000);
    await pc.updateTask(id, { title: 'Envoyer la facture corrigée' });
    await pc.cycle();
    pc.clock.advance(60_000);
    await iphone.deleteTask(id);
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    await iphone.cycle();
    syncFolders(devices);
    for (const d of devices) expect((await d.task(id))?.deletedAt).not.toBeNull();
    const useCases = conflictsOf(pc);
    const [view] = (await useCases.list(1)).items;
    expect(view?.column.name).toBe('deleted_at');
    expect(view?.discarded.value).toBe('modified');
    expect(view?.itemState).toBe('deleted');
    pc.clock.advance(1_000);
    expect(await useCases.restore(view?.id ?? 0)).toEqual({ status: 'restored' });
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    for (const d of devices) {
      const task = await d.task(id);
      expect(task?.deletedAt).toBeNull();
      expect(task?.title).toBe('Envoyer la facture corrigée');
    }
    const counts = await Promise.all(devices.map((d) => d.driver.select('SELECT COUNT(*) AS n FROM conflict_log')));
    expect(counts[1]).toEqual(counts[0]);
  });

  it('deux champs différents de la même tâche : les deux gardés, aucun conflit', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);
    pc.clock.advance(60_000);
    await pc.updateTask(id, { time: '10:00' as never });
    await pc.cycle();
    pc.clock.advance(60_000);
    await iphone.updateTask(id, { note: 'avec le devis' });
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    await iphone.cycle();
    for (const d of devices) {
      const task = await d.task(id);
      expect(task?.time).toBe('10:00');
      expect(task?.note).toBe('avec le devis');
      expect(await d.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
      expect((await conflictsOf(d).list(1)).items).toEqual([]);
    }
  });
});
