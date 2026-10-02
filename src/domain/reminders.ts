import type { NewReminder, Reminder, ReminderOffsetMin, ReminderTarget } from './model';
import { reminderFireAt } from './recurrenceNext';
import { normalizeReminderOffsets } from './routineReminder';
import type { LocalDate, LocalDateTime, LocalTime, ReminderId } from './types';

/**
 * Rappels (N-02) : règles pures. Ordre 1 = données seulement ; l'envoi est sur l'iPhone, à l'ordre 5 (jamais sur le PC).
 * `REMINDER_OFFSETS_MIN` (src/domain/model) reste la seule source des avances.
 */

/** Avances montrées d'emblée (Ajout.html : « À l'heure », « 30 min », « 1 heure ») ; les autres sont sous « Plus… ». */
export const REMINDER_QUICK_OFFSETS: readonly ReminderOffsetMin[] = [0, 30, 60];

/** Échéance (heure locale flottante, T-11) : date + heure − avance. */
export function computeFireAt(date: LocalDate, time: LocalTime, offsetMin: number): LocalDateTime {
  return reminderFireAt(date, time, offsetMin);
}

/** Un rappel n'a de sens qu'avec une date et une heure (QB-07) ; sans elles, le bloc Rappel est grisé et les rappels existants sont inactifs (QB-10). */
export function canHaveReminders(schedule: { readonly date: LocalDate | null; readonly time: LocalTime | null }): boolean {
  return schedule.date !== null && schedule.time !== null;
}

/** Coche / décoche une avance : sans doublon, de la plus proche à la plus lointaine. */
export function toggleReminderOffset(current: readonly ReminderOffsetMin[], offset: ReminderOffsetMin): ReminderOffsetMin[] {
  const next = current.includes(offset) ? current.filter((value) => value !== offset) : [...current, offset];
  return normalizeReminderOffsets(next, '00:00' as LocalTime);
}

/** Avances à afficher / enregistrer : valides, sans doublon, triées. */
export function sortReminderOffsets(offsets: readonly number[]): ReminderOffsetMin[] {
  return normalizeReminderOffsets(offsets, '00:00' as LocalTime);
}

/**
 * Avances après un changement d'heure dans un formulaire (QB-08) : quand on donne une heure pour la première fois et que les cases n'ont
 * pas été touchées, les avances par défaut sont cochées ; effacer l'heure ne décoche rien (les cases sont seulement grisées, QB-07).
 */
export function offsetsAfterTimeChange(
  current: readonly ReminderOffsetMin[],
  previousTime: LocalTime | null,
  nextTime: LocalTime | null,
  touched: boolean,
  defaults: readonly ReminderOffsetMin[],
): ReminderOffsetMin[] {
  if (nextTime !== null && previousTime === null && !touched && current.length === 0) return sortReminderOffsets(defaults);
  return [...current];
}

export interface BuildRemindersInput {
  readonly target: ReminderTarget;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly offsets: readonly number[];
  readonly newReminderId: () => ReminderId;
}

/** Lignes `reminder` d'un élément : aucune sans date et heure (QB-07) ; une ligne par avance valide. */
export function buildReminders(input: BuildRemindersInput): NewReminder[] {
  const { date, time } = input;
  if (date === null || time === null) return [];
  return normalizeReminderOffsets(input.offsets, time).map((offsetMin) => ({
    id: input.newReminderId(),
    targetType: input.target.type,
    targetId: input.target.id,
    offsetMin,
    fireAt: computeFireAt(date, time, offsetMin),
  }));
}

/**
 * Recalcul après un changement de date ou d'heure (N-02 critère 5) : lignes à réécrire (avance conservée, nouvelle échéance), ou
 * `null` si rien ne change. Sans date et heure, les rappels restent tels quels mais inactifs (QB-07, QB-10).
 */
export function recomputeReminders(
  schedule: { readonly date: LocalDate | null; readonly time: LocalTime | null },
  reminders: readonly Reminder[],
): NewReminder[] | null {
  const { date, time } = schedule;
  if (date === null || time === null || reminders.length === 0) return null;
  const rewritten = reminders.map((reminder) => ({
    id: reminder.id,
    targetType: reminder.targetType,
    targetId: reminder.targetId,
    offsetMin: reminder.offsetMin,
    fireAt: computeFireAt(date, time, reminder.offsetMin),
  }));
  return rewritten.some((row, index) => row.fireAt !== reminders[index]?.fireAt) ? rewritten : null;
}

/** Rappels dus : ceux d'un élément qui a encore une date et une heure (ordre 5 : à filtrer avant toute planification). */
export function dueReminders<R extends Reminder>(
  reminders: readonly R[],
  schedule: { readonly date: LocalDate | null; readonly time: LocalTime | null },
): R[] {
  return canHaveReminders(schedule) ? [...reminders] : [];
}
