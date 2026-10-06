import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRO, STAMP_AT, STAMP_DEVICE, STAMP_HLC, openConflictBench, type ConflictBench } from './kit';

/**
 * Revue 1 de Y-04 (bloquant) : restaurer la date ou l'heure d'une tâche, l'heure d'une routine ou la date d'un événement recalcule
 * l'échéance (`fire_at`) de ses rappels dans la même transaction (N-02 critère 5), à la restauration comme à l'annulation.
 * Horloge : lundi 5 octobre 2026, 08:00 UTC.
 */

let bench: ConflictBench;
beforeEach(async () => {
  bench = await openConflictBench();
});
afterEach(async () => {
  await bench.close();
});

const fireAts = (type: string, id: string) =>
  bench.select<{ fire_at: string; offset_min: number }>('SELECT fire_at, offset_min FROM reminder WHERE target_type = ? AND target_id = ? AND deleted_at IS NULL ORDER BY offset_min', [type, id]);

describe('rappels recalculés à la restauration et à l’annulation', () => {
  it('heure d’une tâche : 10:00 restaurée → rappel 15 min avant à 09:45 ; annulation → 08:45', async () => {
    const task = await bench.createTask('Envoyer la facture', { time: '09:00' as never });
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000011' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: '10:00' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await fireAts('task', task.id)).toEqual([{ fire_at: '2026-10-05T09:45', offset_min: 15 }]);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect(await fireAts('task', task.id)).toEqual([{ fire_at: '2026-10-05T08:45', offset_min: 15 }]);
  });

  it('date d’une tâche : 12 oct. restaurée → rappel la veille le 11 oct.', async () => {
    const task = await bench.createTask('Payer le loyer', { time: '09:00' as never });
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000012' as never, targetType: 'task', targetId: task.id, offsetMin: 1440, fireAt: '2026-10-04T09:00' as never },
    ]);
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'date', kept: '2026-10-05', discarded: '2026-10-12' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await fireAts('task', task.id)).toEqual([{ fire_at: '2026-10-11T09:00', offset_min: 1440 }]);
  });

  it('heure d’une routine quotidienne : 18:00 restaurée → rappel à l’heure à 18:00 (prochaine occurrence) ; annulation → 07:00', async () => {
    const routine = '30000000-0000-4000-8000-000000000021';
    await bench.stamped(
      "INSERT INTO routine (id, space_id, title, schedule_type, start_date, time, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Méditer', 'daily', '2026-10-01', '07:00', ?, ?, ?, ?)",
      [routine, PRO, STAMP_AT, STAMP_AT, STAMP_DEVICE, STAMP_HLC],
    );
    await bench.data.repos.reminders.replaceForTarget({ type: 'routine', id: routine as never }, [
      { id: '70000000-0000-4000-8000-000000000021' as never, targetType: 'routine', targetId: routine as never, offsetMin: 0, fireAt: '2026-10-06T07:00' as never },
    ]);
    const id = await bench.conflict({ table: 'routine', rowId: routine, field: 'time', kept: '07:00', discarded: '18:00' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await fireAts('routine', routine)).toEqual([{ fire_at: '2026-10-05T18:00', offset_min: 0 }]);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect(await fireAts('routine', routine)).toEqual([{ fire_at: '2026-10-05T07:00', offset_min: 0 }]);
  });

  it('date d’un événement : 20 oct. restaurée → rappel la veille le 19 oct.', async () => {
    const event = '50000000-0000-4000-8000-000000000031';
    await bench.stamped(
      "INSERT INTO event (id, space_id, title, start_date, start_time, end_date, end_time, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Dentiste', '2026-10-15', '10:00', '2026-10-15', '11:00', ?, ?, ?, ?)",
      [event, PRO, STAMP_AT, STAMP_AT, STAMP_DEVICE, STAMP_HLC],
    );
    await bench.data.repos.reminders.replaceForTarget({ type: 'event', id: event as never }, [
      { id: '70000000-0000-4000-8000-000000000031' as never, targetType: 'event', targetId: event as never, offsetMin: 1440, fireAt: '2026-10-14T10:00' as never },
    ]);
    const id = await bench.conflict({ table: 'event', rowId: event, field: 'start_date', kept: '2026-10-15', discarded: '2026-10-20' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await fireAts('event', event)).toEqual([{ fire_at: '2026-10-19T10:00', offset_min: 1440 }]);
  });

  it('champ sans effet sur l’échéance (titre) : rappels inchangés', async () => {
    const task = await bench.createTask('Titre', { time: '09:00' as never });
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000013' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    const before = await bench.select('SELECT hlc FROM reminder');
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'Titre', discarded: 'Autre titre' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await bench.select('SELECT hlc FROM reminder')).toEqual(before);
  });
});
