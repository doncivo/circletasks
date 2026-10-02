import { describe, expect, it } from 'vitest';
import type { Routine, Task } from './model';
import { moveTaskRow } from './taskReorder';
import { buildTodayList, type TodayRow } from './todayList';
import { asEntityId, asLocalDate, asLocalTime, type SpaceId } from './types';

const SPACE = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const DAY = asLocalDate('2026-09-23');

function task(id: string, sortOrder: number, time: string | null = null): Task {
  return { id, spaceId: SPACE, title: id, date: DAY, time: time === null ? null : asLocalTime(time), status: 'todo', sortOrder, someday: false, deletedAt: null } as unknown as Task;
}

function rowsOf(tasks: Task[], routines: Routine[] = []): readonly TodayRow[] {
  return buildTodayList({ date: DAY, filter: 'all', tasks, routines: routines.map((routine) => ({ routine, done: false })) }).rows;
}

const routine = (id: string, time: string): Routine =>
  ({ id, spaceId: SPACE, title: id, time: asLocalTime(time), paused: false, archived: false, deletedAt: null }) as unknown as Routine;

/** Applique les changements et recalcule l'ordre affiché. */
function apply(tasks: Task[], changes: readonly { id: string; sortOrder: number }[]): string[] {
  const next = tasks.map((t) => {
    const change = changes.find((c) => c.id === t.id);
    return change ? ({ ...t, sortOrder: change.sortOrder } as Task) : t;
  });
  return rowsOf(next).map((r) => r.id);
}

describe('moveTaskRow (A-02, Q11)', () => {
  it('D glissé au-dessus de C : 09:00, 14:00, D, C (critère 5)', () => {
    const tasks = [task('9h', 1, '09:00'), task('14h', 2, '14:00'), task('C', 10), task('D', 20)];
    const outcome = moveTaskRow(rowsOf(tasks), 'D', 2);
    expect(outcome).toMatchObject({ fromIndex: 3, toIndex: 2, total: 4, clamped: false });
    expect(apply(tasks, outcome?.changes ?? [])).toEqual(['9h', '14h', 'D', 'C']);
  });

  it('une tâche sans heure ne passe pas au-dessus d’une tâche horodatée : elle reste à sa place (critère 5)', () => {
    const tasks = [task('9h', 1, '09:00'), task('C', 10), task('D', 20)];
    const outcome = moveTaskRow(rowsOf(tasks), 'C', 0);
    expect(outcome).toMatchObject({ fromIndex: 1, toIndex: 1, clamped: true, changes: [] });
  });

  it('une tâche horodatée ne passe pas parmi les sans-heure (critère 5)', () => {
    const tasks = [task('9h', 1, '09:00'), task('C', 10), task('D', 20)];
    const outcome = moveTaskRow(rowsOf(tasks), '9h', 2);
    expect(outcome).toMatchObject({ toIndex: 0, clamped: true, changes: [] });
  });

  it('deux tâches de même heure s’échangent (critère 5)', () => {
    const tasks = [task('a', 1, '10:00'), task('b', 2, '10:00'), task('autre', 3, '11:00')];
    const outcome = moveTaskRow(rowsOf(tasks), 'b', 0);
    expect(outcome?.toIndex).toBe(0);
    expect(apply(tasks, outcome?.changes ?? [])).toEqual(['b', 'a', 'autre']);
  });

  it('insère par le milieu des voisins, sans toucher aux autres tâches', () => {
    const tasks = [task('a', 10), task('b', 20), task('c', 30)];
    const outcome = moveTaskRow(rowsOf(tasks), 'c', 1);
    expect(outcome?.changes).toEqual([{ id: 'c', sortOrder: 15 }]);
  });

  it('placé en tête : avant le premier ; en queue : après le dernier', () => {
    const tasks = [task('a', 10), task('b', 20), task('c', 30)];
    expect(moveTaskRow(rowsOf(tasks), 'c', 0)?.changes).toEqual([{ id: 'c', sortOrder: 9 }]);
    expect(moveTaskRow(rowsOf(tasks), 'a', 2)?.changes).toEqual([{ id: 'a', sortOrder: 31 }]);
  });

  it('une destination hors liste est ramenée aux bornes', () => {
    const tasks = [task('a', 10), task('b', 20)];
    expect(moveTaskRow(rowsOf(tasks), 'a', 99)).toMatchObject({ toIndex: 1, clamped: true });
    expect(moveTaskRow(rowsOf(tasks), 'b', -5)).toMatchObject({ toIndex: 0, clamped: true });
  });

  it('renumérote le groupe quand les voisins sont confondus (même sortOrder)', () => {
    const tasks = [task('a', 5), task('b', 5), task('c', 5)];
    const outcome = moveTaskRow(rowsOf(tasks), 'c', 0);
    expect(apply(tasks, outcome?.changes ?? [])).toEqual(['c', 'a', 'b']);
  });

  it('renumérote quand l’écart devient trop fin', () => {
    const tasks = [task('a', 1), task('b', 1 + 1e-9), task('c', 100)];
    const outcome = moveTaskRow(rowsOf(tasks), 'c', 1);
    expect(apply(tasks, outcome?.changes ?? [])).toEqual(['a', 'c', 'b']);
  });

  it('les routines ne sont pas déplaçables et se placent par leur heure (critère 6)', () => {
    const rows = rowsOf([task('t', 1, '09:00')], [routine('eau', '08:30')]);
    expect(rows.map((r) => r.id)).toEqual(['eau', 't']);
    expect(moveTaskRow(rows, 'eau', 1)).toBeNull();
    // Une tâche ne passe pas au-dessus d'une routine placée par son heure.
    expect(moveTaskRow(rows, 't', 0)).toMatchObject({ toIndex: 1, changes: [] });
  });

  it('une routine sans heure précède les tâches sans heure, qui ne la dépassent pas', () => {
    const rows = rowsOf([task('a', 1), task('b', 2)], [{ ...routine('r', '08:00'), time: null } as Routine]);
    expect(rows.map((r) => r.id)).toEqual(['r', 'a', 'b']);
    expect(moveTaskRow(rows, 'b', 0)).toMatchObject({ toIndex: 1 });
  });

  it('un élément absent ou terminé n’est pas déplaçable (critère 7)', () => {
    const rows = rowsOf([task('a', 1)]);
    expect(moveTaskRow(rows, 'inconnu', 0)).toBeNull();
    const done = buildTodayList({ date: DAY, filter: 'all', tasks: [{ ...task('x', 1), status: 'done' } as Task] }).doneRows;
    expect(moveTaskRow(done, 'x', 0)).toBeNull();
  });

  it('même position : aucun changement', () => {
    const rows = rowsOf([task('a', 1), task('b', 2)]);
    expect(moveTaskRow(rows, 'a', 0)).toMatchObject({ changes: [], toIndex: 0, clamped: false });
  });
});
