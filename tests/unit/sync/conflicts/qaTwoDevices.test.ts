import { afterEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../../../src/domain/id';
import type { TaskId } from '../../../../src/domain/types';
import { createTaskEntities } from '../../../../src/features/app/taskEntities';
import { createUndoStack, type UndoStack } from '../../../../src/features/app/undo';
import { createSyncConflictUseCases, type SyncConflictUseCases } from '../../../../src/features/sync/syncConflictUseCases';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * QA de Y-04 (critères 5, 6, 7, 10 et 11) sur deux appareils simulés : restauration faite des deux côtés hors ligne, annulation après
 * une modification venue de l'autre appareil, suppression contre modification dans les deux sens, restauration puis nouvelle
 * modification concurrente. Les appareils partagent une horloge manuelle : aucun délai.
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

function conflictsOf(d: SimDevice, undo: UndoStack = createUndoStack()): SyncConflictUseCases {
  return createSyncConflictUseCases({ clock: d.clock, ids: uuidGenerator, data: d.data, undo, taskEntities: createTaskEntities(), logger: d.logger });
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

const conflictCount = async (d: SimDevice): Promise<number> => Number(((await d.driver.select('SELECT COUNT(*) AS n FROM conflict_log'))[0] as { n: number }).n);

async function sharedTask(pc: SimDevice, iphone: SimDevice, extra: { time?: string } = { time: '08:00' }): Promise<TaskId> {
  const task = await pc.createTask('Envoyer la facture', { time: (extra.time ?? '08:00') as never });
  await settle(pc, iphone);
  expect((await iphone.task(task.id))?.time).toBe(extra.time ?? '08:00');
  return task.id;
}

/** PC 10:00, puis iPhone 09:00 (le plus récent gagne) ; les deux ont le même conflit. */
async function timeConflict(pc: SimDevice, iphone: SimDevice): Promise<TaskId> {
  const id = await sharedTask(pc, iphone);
  pc.clock.advance(60_000);
  await pc.updateTask(id, { time: '10:00' as never });
  await pc.cycle();
  pc.clock.advance(60_000);
  await iphone.updateTask(id, { time: '09:00' as never });
  await iphone.cycle();
  await settle(pc, iphone);
  for (const d of devices) {
    expect((await d.task(id))?.time).toBe('09:00');
    expect(await conflictCount(d)).toBe(1);
  }
  return id;
}

describe('Y-04 critère 10 : valeur déjà restaurée par l’autre appareil', () => {
  it('Y-04 critère 10 : les deux appareils restaurent hors ligne la même valeur : même valeur partout, aucun nouveau conflit', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await timeConflict(pc, iphone);

    pc.clock.advance(60_000);
    const onPc = conflictsOf(pc);
    expect(await onPc.restore((await onPc.list(1)).items[0]?.id ?? 0)).toEqual({ status: 'restored' });
    pc.clock.advance(1_000);
    const onIphone = conflictsOf(iphone);
    expect(await onIphone.restore((await onIphone.list(1)).items[0]?.id ?? 0)).toEqual({ status: 'restored' });
    // Chacun publie dans son dossier, sans recopie : hors ligne l'un pour l'autre.
    await pc.cycle();
    await iphone.cycle();
    await settle(pc, iphone);

    for (const d of devices) {
      expect((await d.task(id))?.time).toBe('10:00');
      expect(await conflictCount(d)).toBe(1);
      expect((await conflictsOf(d).list(1)).items[0]).toMatchObject({ restored: true, blocked: null });
    }
  });

  it('Y-04 critère 10 : l’autre appareil a restauré avant moi : mon « Restaurer » ne fait aucune écriture et ne laisse rien en file', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await timeConflict(pc, iphone);
    pc.clock.advance(60_000);
    const onPc = conflictsOf(pc);
    await onPc.restore((await onPc.list(1)).items[0]?.id ?? 0);
    await settle(pc, iphone);
    expect((await iphone.task(id))?.time).toBe('10:00');
    const onIphone = conflictsOf(iphone);
    const before = Number(((await iphone.driver.select('SELECT COUNT(*) AS n FROM sync_outbox'))[0] as { n: number }).n);
    expect(await onIphone.restore((await onIphone.list(1)).items[0]?.id ?? 0)).toEqual({ status: 'already' });
    expect(Number(((await iphone.driver.select('SELECT COUNT(*) AS n FROM sync_outbox'))[0] as { n: number }).n)).toBe(before);
    expect(await conflictCount(iphone)).toBe(1);
  });
});

describe('Y-04 critère 6 : annulation et modifications venues de l’autre appareil', () => {
  it('Y-04 critère 6 : l’autre appareil modifie le champ après ma restauration et je le reçois : l’annulation est refusée (stale), rien n’est écrasé', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await timeConflict(pc, iphone);
    const undo = createUndoStack();
    const onPc = conflictsOf(pc, undo);
    pc.clock.advance(60_000);
    expect(await onPc.restore((await onPc.list(1)).items[0]?.id ?? 0)).toEqual({ status: 'restored' });
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
    // L'iPhone, qui a reçu 10:00, saisit 11:00.
    iphone.clock.advance(60_000);
    await iphone.updateTask(id, { time: '11:00' as never });
    await iphone.cycle();
    syncFolders(devices);
    await pc.cycle();
    expect((await pc.task(id))?.time).toBe('11:00');
    pc.clock.advance(1_000);
    expect((await undo.undoLast()).status).toBe('stale');
    expect((await pc.task(id))?.time).toBe('11:00');
    await settle(pc, iphone);
    for (const d of devices) expect((await d.task(id))?.time).toBe('11:00');
  });

  it('Y-04 critère 5 : restauration puis modification concurrente de l’autre appareil (qui n’a rien reçu) : un seul nouveau conflit, le même des deux côtés, rien de perdu', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await timeConflict(pc, iphone);
    const onPc = conflictsOf(pc);
    pc.clock.advance(60_000);
    await onPc.restore((await onPc.list(1)).items[0]?.id ?? 0);
    await pc.cycle();
    iphone.clock.advance(1_000);
    await iphone.updateTask(id, { time: '12:00' as never });
    await iphone.cycle();
    await settle(pc, iphone);
    const [a, b] = await Promise.all(devices.map((d) => d.driver.select('SELECT field, kept_value, discarded_value FROM conflict_log ORDER BY id')));
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect((await pc.task(id))?.time).toBe((await iphone.task(id))?.time);
    expect(['10:00', '12:00']).toContain((await pc.task(id))?.time);
  });
});

describe('Y-04 critère 7 : suppression contre modification, dans les deux sens', () => {
  it('Y-04 critère 7 : supprimée sur le PC, modifiée ensuite sur l’iPhone : les deux appareils convergent et rien n’est perdu (valeur modifiée gardée)', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);
    pc.clock.advance(60_000);
    await pc.deleteTask(id);
    await pc.cycle();
    pc.clock.advance(60_000);
    await iphone.updateTask(id, { title: 'Envoyer la facture corrigée' });
    await iphone.cycle();
    await settle(pc, iphone);
    const [onPc, onIphone] = await Promise.all(devices.map((d) => d.task(id)));
    expect(onPc?.deletedAt).toBe(onIphone?.deletedAt);
    expect(onPc?.title).toBe('Envoyer la facture corrigée');
    expect(onIphone?.title).toBe('Envoyer la facture corrigée');
    expect(await conflictCount(pc)).toBe(await conflictCount(iphone));
    // Un éventuel conflit « supprimé / modifié » se restaure partout.
    const useCases = conflictsOf(pc);
    const items = (await useCases.list(1)).items.filter((v) => v.column.name === 'deleted_at');
    for (const view of items) {
      pc.clock.advance(1_000);
      expect(await useCases.restore(view.id)).toMatchObject({ status: expect.stringMatching(/^(restored|already)$/) });
    }
    await settle(pc, iphone);
    expect(await conflictCount(pc)).toBe(await conflictCount(iphone));
    expect((await pc.task(id))?.deletedAt).toBe((await iphone.task(id))?.deletedAt);
  });

  it('Y-04 critère 7 : « Restaurer » un conflit supprimé / modifié puis « Annuler » : l’autre appareil converge sur la suppression, sans conflit inventé', async () => {
    const [pc, iphone] = await twoDevices();
    const id = await sharedTask(pc, iphone);
    pc.clock.advance(60_000);
    await pc.updateTask(id, { title: 'Corrigée' });
    await pc.cycle();
    pc.clock.advance(60_000);
    await iphone.deleteTask(id);
    await iphone.cycle();
    await settle(pc, iphone);
    const undo = createUndoStack();
    const useCases = conflictsOf(pc, undo);
    const view = (await useCases.list(1)).items.find((v) => v.column.name === 'deleted_at');
    expect(view).toBeDefined();
    const before = await conflictCount(pc);
    pc.clock.advance(1_000);
    expect(await useCases.restore(view?.id ?? 0)).toEqual({ status: 'restored' });
    await pc.cycle();
    pc.clock.advance(1_000);
    expect((await undo.undoLast()).status).toBe('undone');
    await settle(pc, iphone);
    for (const d of devices) {
      expect((await d.task(id))?.deletedAt).not.toBeNull();
      expect(await conflictCount(d)).toBe(before);
    }
  });
});
