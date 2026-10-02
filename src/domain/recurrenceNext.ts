import type { NewReminder, NewTask, RecurrenceFields, ReminderOffsetMin, Task } from './model';
import { nextOccurrenceDate } from './recurrenceRules';
import type { LocalDate, LocalDateTime, ReminderId, TaskId } from './types';

/** Champs de la tâche lus pour décider de créer l'occurrence suivante. */
export type RecurringTaskState = Pick<Task, 'date' | 'status' | 'recurrenceId' | 'seriesIndex'>;

export type NextOccurrenceSkipReason =
  | 'no_recurrence'
  | 'no_date'
  | 'not_due'
  | 'already_generated'
  | 'series_ended';

export type NextOccurrenceDecision =
  | { readonly create: true; readonly date: LocalDate; readonly seriesIndex: number }
  | { readonly create: false; readonly reason: NextOccurrenceSkipReason };

export interface NextOccurrenceInput {
  readonly task: RecurringTaskState;
  readonly rule: RecurrenceFields | null;
  /** Jour local courant, fourni par l'appelant. */
  readonly today: LocalDate;
  /**
   * `seriesIndex` de toutes les tâches déjà présentes dans la série (corbeille comprise) :
   * garantit l'absence de doublon après redémarrage ou double déclenchement (critère 12).
   */
  readonly existingSeriesIndexes?: readonly number[];
  /**
   * Génère la suivante même si l'occurrence n'est ni terminée ni passée : suppression « cette
   * occurrence » d'une occurrence à venir (T-10 critère 7).
   */
  readonly ignoreDue?: boolean;
}

/**
 * Faut-il créer l'occurrence suivante ? Oui dès que l'occurrence est terminée (même en avance)
 * ou passée (à faire, datée avant aujourd'hui), qu'elle soit reportée ou non (Q2) ; la date
 * suivante est calculée depuis la date prévue. Une série rattrapée après une longue absence
 * se rejoue en rappelant la fonction sur chaque occurrence créée.
 */
export function decideNextOccurrence(input: NextOccurrenceInput): NextOccurrenceDecision {
  const { task, rule, today } = input;
  if (rule === null || task.recurrenceId === null) return { create: false, reason: 'no_recurrence' };
  if (task.date === null) return { create: false, reason: 'no_date' };
  if (input.ignoreDue !== true && task.status === 'todo' && task.date >= today) return { create: false, reason: 'not_due' };
  const index = task.seriesIndex ?? 0;
  if ((input.existingSeriesIndexes ?? []).some((i) => i > index)) {
    return { create: false, reason: 'already_generated' };
  }
  const date = nextOccurrenceDate(rule, task.date, index);
  if (date === null) return { create: false, reason: 'series_ended' };
  return { create: true, date, seriesIndex: index + 1 };
}

/** Échéance de rappel en heure locale flottante : date + heure - avance, sans fuseau ni heure d'été. */
export function reminderFireAt(date: LocalDate, time: string, offsetMin: number): LocalDateTime {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const ms = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, (mi ?? 0) - offsetMin);
  return new Date(ms).toISOString().slice(0, 16) as LocalDateTime;
}

export interface BuildNextOccurrenceOptions {
  readonly taskId: TaskId;
  readonly date: LocalDate;
  readonly seriesIndex: number;
  /** Avances des rappels de l'occurrence terminée, à recopier. */
  readonly reminderOffsets?: readonly ReminderOffsetMin[];
  readonly newReminderId: () => ReminderId;
  /** Ordre dans la liste ; par défaut celui de l'occurrence précédente. */
  readonly sortOrder?: number;
}

export interface NextOccurrence {
  readonly task: NewTask;
  readonly reminders: readonly NewReminder[];
}

/**
 * Construit l'occurrence suivante : titre, note, icône, espace, projet, objectif, heure et
 * récurrence identiques ; non terminée, non reportée, `seriesIndex` fourni (précédent + 1).
 * Les rappels sont recopiés avec une échéance recalculée ; sans heure, ils sont omis
 * (un rappel exige une heure).
 */
export function buildNextOccurrence(previous: Task, options: BuildNextOccurrenceOptions): NextOccurrence {
  const task: NewTask = {
    id: options.taskId,
    spaceId: previous.spaceId,
    projectId: previous.projectId,
    title: previous.title,
    note: previous.note,
    date: options.date,
    time: previous.time,
    status: 'todo',
    doneAt: null,
    sortOrder: options.sortOrder ?? previous.sortOrder,
    carriedOver: false,
    recurrenceId: previous.recurrenceId,
    seriesIndex: options.seriesIndex,
    seriesTemplate: null,
    goalId: previous.goalId,
    icon: previous.icon,
    someday: false,
    source: 'local',
    externalId: null,
  };
  const time = previous.time;
  const reminders: NewReminder[] =
    time === null
      ? []
      : (options.reminderOffsets ?? []).map((offsetMin) => ({
          id: options.newReminderId(),
          targetType: 'task',
          targetId: options.taskId,
          offsetMin,
          fireAt: reminderFireAt(options.date, time, offsetMin),
        }));
  return { task, reminders };
}
