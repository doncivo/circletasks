import type { NewReminder, NewTask, ReminderOffsetMin, Task } from './model';
import { reminderFireAt } from './recurrenceNext';
import type { LocalDate, ReminderId, TaskId } from './types';

/**
 * Duplication d'une tâche (T-12, Q8).
 *
 * Copié : titre, note, icône, espace, projet, heure (si la copie est datée) et une copie de
 * chaque rappel (même avance, échéance recalculée sur la nouvelle date).
 * Non copié : récurrence (la copie est « Une fois »), rattachement à l'objectif, statut
 * terminé (la copie est à faire), badge « reportée », ordre manuel (la copie se place à la fin
 * de son jour : `sortOrder` fourni par l'appelant), origine externe (la copie est locale).
 * `date` null : la copie est rangée dans « Un jour » (sans date, sans heure, sans rappel).
 */
export interface DuplicateTaskOptions {
  readonly taskId: TaskId;
  /** Date choisie ; null = « Un jour ». */
  readonly date: LocalDate | null;
  /** Avances des rappels de l'original (une copie par avance, sans doublon). */
  readonly reminderOffsets: readonly ReminderOffsetMin[];
  readonly newReminderId: () => ReminderId;
  /** Ordre manuel de la copie : fin de liste du jour. */
  readonly sortOrder: number;
}

export interface DuplicatedTask {
  readonly task: NewTask;
  readonly reminders: readonly NewReminder[];
}

export function duplicateTask(source: Task, options: DuplicateTaskOptions): DuplicatedTask {
  const date = options.date;
  const dated = date !== null;
  const time = dated ? source.time : null;
  const task: NewTask = {
    id: options.taskId,
    spaceId: source.spaceId,
    projectId: source.projectId,
    title: source.title,
    note: source.note,
    date,
    time,
    status: 'todo',
    doneAt: null,
    sortOrder: options.sortOrder,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: source.icon,
    someday: !dated,
    source: 'local',
    externalId: null,
    appleListId: null,
    appleRecurring: false,
    externalEventId: null,
  };
  const offsets = [...new Set(options.reminderOffsets)];
  const reminders: NewReminder[] =
    date === null || time === null
      ? []
      : offsets.map((offsetMin) => ({
          id: options.newReminderId(),
          targetType: 'task' as const,
          targetId: options.taskId,
          offsetMin,
          fireAt: reminderFireAt(date, time, offsetMin),
        }));
  return { task, reminders };
}

/**
 * Date présélectionnée dans le sélecteur à la duplication (Q8) : celle de l'original,
 * null (« Un jour ») si l'original est dans « Un jour ». Sans date hors Un jour : aujourd'hui.
 */
export function duplicateDefaultDate(source: Pick<Task, 'date' | 'someday'>, today: LocalDate): LocalDate | null {
  if (source.someday) return null;
  return source.date ?? today;
}
