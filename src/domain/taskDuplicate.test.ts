import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import { duplicateDefaultDate, duplicateTask } from './taskDuplicate';
import { asEntityId, asLocalDate, asLocalTime, type GoalId, type ProjectId, type ReminderId, type SpaceId, type TaskId, type RecurrenceId } from './types';

const source: Task = {
  id: asEntityId<TaskId>('10000000-0000-4000-8000-000000000001'),
  spaceId: asEntityId<SpaceId>('10000000-0000-4000-8000-0000000000a1'),
  projectId: asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000b1'),
  title: 'Courses',
  note: 'Pain, lait',
  date: asLocalDate('2026-09-24'),
  time: asLocalTime('10:00'),
  status: 'done',
  doneAt: '2026-09-24T09:00:00.000Z' as Task['doneAt'],
  sortOrder: 5,
  carriedOver: true,
  recurrenceId: asEntityId<RecurrenceId>('10000000-0000-4000-8000-0000000000c1'),
  seriesIndex: 3,
  seriesTemplate: null,
  goalId: asEntityId<GoalId>('10000000-0000-4000-8000-0000000000d1'),
  icon: { kind: 'emoji', value: '🛒' } as Task['icon'],
  someday: false,
  source: 'apple_reminders',
  externalId: 'ext-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  deletedAt: null,
  deviceId: '10000000-0000-4000-8000-0000000000e1',
  hlc: 'h',
} as unknown as Task;

let n = 0;
const opts = (date: ReturnType<typeof asLocalDate> | null, offsets: readonly (0 | 30 | 1440)[] = []) => ({
  taskId: asEntityId<TaskId>('20000000-0000-4000-8000-000000000001'),
  date,
  reminderOffsets: offsets,
  newReminderId: () => asEntityId<ReminderId>(`30000000-0000-4000-8000-00000000000${++n % 10}`),
  sortOrder: 99,
});

describe('duplicateTask (T-12)', () => {
  it('copie titre, note, icône, espace, projet, heure et pose la date choisie (critère 3)', () => {
    const { task } = duplicateTask(source, opts(asLocalDate('2026-09-25')));
    expect(task).toMatchObject({
      title: 'Courses',
      note: 'Pain, lait',
      icon: source.icon,
      spaceId: source.spaceId,
      projectId: source.projectId,
      date: '2026-09-25',
      time: '10:00',
      status: 'todo',
      doneAt: null,
      carriedOver: false,
      someday: false,
    });
  });

  it('ne copie ni récurrence, ni objectif, ni ordre manuel, ni origine externe (critère 4)', () => {
    const { task } = duplicateTask(source, opts(asLocalDate('2026-09-24')));
    expect(task.recurrenceId).toBeNull();
    expect(task.seriesIndex).toBeNull();
    expect(task.seriesTemplate).toBeNull();
    expect(task.goalId).toBeNull();
    expect(task.sortOrder).toBe(99);
    expect(task.source).toBe('local');
    expect(task.externalId).toBeNull();
  });

  it('copie chaque rappel avec la même avance, échéance recalculée, sans doublon', () => {
    const { reminders } = duplicateTask(source, opts(asLocalDate('2026-09-25'), [0, 30, 1440, 30]));
    expect(reminders.map((r) => [r.offsetMin, r.fireAt])).toEqual([
      [0, '2026-09-25T10:00'],
      [30, '2026-09-25T09:30'],
      [1440, '2026-09-24T10:00'],
    ]);
    expect(reminders.every((r) => r.targetType === 'task' && r.targetId === opts(null).taskId)).toBe(true);
  });

  it('« Un jour » : sans date, sans heure, sans rappel (critère 5)', () => {
    const { task, reminders } = duplicateTask(source, opts(null, [0, 30]));
    expect(task).toMatchObject({ date: null, time: null, someday: true });
    expect(reminders).toEqual([]);
  });

  it('une tâche sans heure n’a pas de rappel', () => {
    const { task, reminders } = duplicateTask({ ...source, time: null }, opts(asLocalDate('2026-09-25'), [0]));
    expect(task.time).toBeNull();
    expect(reminders).toEqual([]);
  });
});

describe('duplicateDefaultDate (Q8, critères 1 et 2)', () => {
  const today = asLocalDate('2026-09-23');
  it('même date que l’original', () => {
    expect(duplicateDefaultDate({ date: asLocalDate('2026-09-24'), someday: false }, today)).toBe('2026-09-24');
  });
  it('« Un jour » si l’original est dans Un jour', () => {
    expect(duplicateDefaultDate({ date: null, someday: true }, today)).toBeNull();
  });
  it('sans date hors Un jour : aujourd’hui', () => {
    expect(duplicateDefaultDate({ date: null, someday: false }, today)).toBe('2026-09-23');
  });
});
