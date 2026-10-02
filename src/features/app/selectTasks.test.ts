import { describe, expect, it } from 'vitest';
import type { Task } from '../../domain/model';
import { asEntityId, asLocalDate, type TaskId } from '../../domain/types';
import { selectTasks } from './selectTasks';

const id = (n: number) => asEntityId<TaskId>(`00000000-0000-4000-8000-00000000000${String(n)}`);
const task = (n: number, over: Partial<Task> = {}): Task => ({ id: id(n), date: asLocalDate('2026-10-02'), deletedAt: null, ...over }) as Task;

describe('selectTasks', () => {
  it('garde l’ordre des ids, ignore les ids inconnus et les tâches supprimées', () => {
    const entities = new Map<TaskId, Task>([[id(1), task(1)], [id(2), task(2, { deletedAt: '2026-10-02T08:00:00.000Z' as never })], [id(3), task(3)]]);
    expect(selectTasks([id(3), id(2), id(9), id(1)], entities, () => true).map((t) => t.id)).toEqual([id(3), id(1)]);
  });
  it('applique le filtre de la vue : une tâche reportée sort aussitôt', () => {
    const entities = new Map<TaskId, Task>([[id(1), task(1, { date: asLocalDate('2026-10-03') })], [id(2), task(2)]]);
    expect(selectTasks([id(1), id(2)], entities, (t) => t.date === '2026-10-02').map((t) => t.id)).toEqual([id(2)]);
  });
});
