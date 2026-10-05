import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecurrenceId } from '../../../../src/domain/types';
import { openConflictBench, type ConflictBench } from './kit';

/**
 * Revue 2 de Y-04 : restaurer l'état d'une tâche passe par terminer / rouvrir (T-04 : date de fin écrite avec l'état ; T-09 : occurrence
 * suivante d'une série ; T-06 : badge « reportée » effacé), et l'annulation défait tout cela.
 */

let bench: ConflictBench;
beforeEach(async () => {
  bench = await openConflictBench();
});
afterEach(async () => {
  await bench.close();
});

const row = async (id: string) => (await bench.select<{ status: string; done_at: string | null; carried_over: number }>('SELECT status, done_at, carried_over FROM task WHERE id = ?', [id]))[0];

describe('état d’une tâche restauré (revue 2)', () => {
  it('« terminée » restaurée : date de fin posée, badge « reportée » effacé ; annulation : à faire, sans date de fin, badge rendu', async () => {
    const task = await bench.createTask('Envoyer la facture', { carriedOver: true });
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'status', kept: 'todo', discarded: 'done' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await row(task.id)).toEqual({ status: 'done', done_at: new Date(bench.clock.nowMs()).toISOString(), carried_over: 0 });
    expect(bench.taskEntities.get(task.id)?.status).toBe('done');
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect(await row(task.id)).toEqual({ status: 'todo', done_at: null, carried_over: 1 });
  });

  it('« terminée » restaurée sur une tâche d’une série : l’occurrence suivante est créée ; l’annulation la retire', async () => {
    const recurrenceId = '60000000-0000-4000-8000-0000000000f1' as RecurrenceId;
    await bench.data.repos.recurrences.create({ id: recurrenceId, freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
    const task = await bench.createTask('Arroser', { recurrenceId, seriesIndex: 0 });
    const live = () => bench.select<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE recurrence_id = ? AND deleted_at IS NULL AND status = 'todo'", [recurrenceId]);
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'status', kept: 'todo', discarded: 'done' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await live()).toEqual([{ n: 1 }]);
    expect(await bench.select('SELECT date FROM task WHERE recurrence_id = ? AND id <> ? AND deleted_at IS NULL', [recurrenceId, task.id])).toEqual([{ date: '2026-10-06' }]);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect(await bench.select('SELECT id FROM task WHERE recurrence_id = ? AND deleted_at IS NULL', [recurrenceId])).toEqual([{ id: task.id }]);
    expect((await row(task.id))?.status).toBe('todo');
  });

  it('« à faire » restaurée sur une tâche terminée : rouverte sans date de fin ; annulation : terminée avec sa date de fin d’origine', async () => {
    const task = await bench.createTask('Payer');
    await bench.data.repos.tasks.complete(task.id, '2026-10-04T18:00:00.000Z' as never);
    bench.clock.advance(1_000);
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'status', kept: 'done', discarded: 'todo' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect(await row(task.id)).toEqual({ status: 'todo', done_at: null, carried_over: 0 });
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect(await row(task.id)).toEqual({ status: 'done', done_at: '2026-10-04T18:00:00.000Z', carried_over: 0 });
  });
});
