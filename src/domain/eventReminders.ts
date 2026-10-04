import { EVENT_REMINDER_OFFSETS_MIN, isEventReminderOffset, type CalendarEvent, type NewReminder, type ReminderOffsetMin } from './model';
import { nextOccurrence } from './eventOccurrences';
import { EVENT_ALL_DAY_REMINDER_TIME } from './eventRules';
import { reminderFireAt } from './recurrenceNext';
import type { EventId, LocalDate, LocalTime, ReminderId } from './types';

/**
 * Rappels d'un événement (E-01 critère 5) : « 1 semaine avant » (10080 min), « La veille » (1440), « Le jour même » (0), écrits comme
 * lignes `reminder` (target_type `event`). L'envoi est à l'ordre 5, sur l'iPhone : ici, des données seulement.
 */

/** Avances proposées, de la plus lointaine à la plus proche (ordre de AjoutEvenement.html). */
export const EVENT_REMINDER_CHOICES: readonly ReminderOffsetMin[] = EVENT_REMINDER_OFFSETS_MIN;

/** Heure du rappel : celle du début d'un événement à heures, 09:00 pour une journée entière (E-01 D3). */
export function eventReminderTime(event: Pick<CalendarEvent, 'allDay' | 'startTime'>): LocalTime {
  return event.allDay || event.startTime === null ? EVENT_ALL_DAY_REMINDER_TIME : event.startTime;
}

/** Avances valides, sans doublon, de la plus proche à la plus lointaine (même ordre que les autres rappels). */
export function normalizeEventReminderOffsets(offsets: readonly number[]): ReminderOffsetMin[] {
  return [...new Set(offsets.filter(isEventReminderOffset))].sort((a, b) => a - b);
}

/** Active ou retire une avance. */
export function toggleEventReminderOffset(current: readonly ReminderOffsetMin[], offset: ReminderOffsetMin): ReminderOffsetMin[] {
  return normalizeEventReminderOffsets(current.includes(offset) ? current.filter((value) => value !== offset) : [...current, offset]);
}

/**
 * Jour auquel les rappels sont calculés : prochaine occurrence à partir d'aujourd'hui (un événement répété), sinon la date de début
 * (un événement passé garde ses rappels sur son jour). L'ordre 5 recalculera l'échéance de chaque occurrence.
 */
export function reminderAnchorDate(event: CalendarEvent, today: LocalDate): LocalDate {
  return nextOccurrence(event, today)?.date ?? event.startDate;
}

export interface BuildEventRemindersInput {
  readonly event: CalendarEvent;
  readonly offsets: readonly number[];
  readonly today: LocalDate;
  readonly newReminderId: () => ReminderId;
}

/** Lignes `reminder` d'un événement : une par avance valide. */
export function buildEventReminders(input: BuildEventRemindersInput): NewReminder[] {
  const { event } = input;
  const date = reminderAnchorDate(event, input.today);
  const time = eventReminderTime(event);
  return normalizeEventReminderOffsets(input.offsets).map((offsetMin) => ({
    id: input.newReminderId(),
    targetType: 'event' as const,
    targetId: event.id as EventId,
    offsetMin,
    fireAt: reminderFireAt(date, time, offsetMin),
  }));
}
