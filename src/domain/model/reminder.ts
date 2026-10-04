import type { Id, LocalDateTime, ReminderId, RoutineId, SyncMeta, TaskId, EventId } from '../types';

/** Avances proposées (N-02), en minutes : à l'heure, 5, 15, 30, 60 min, 1 jour. */
export const REMINDER_OFFSETS_MIN = [0, 5, 15, 30, 60, 1440] as const;

/**
 * Avances propres aux événements (E-01, AjoutEvenement.html), de la plus lointaine à la plus proche : « 1 semaine avant » (10080 min),
 * « La veille » (1440), « Le jour même » (0). 10080 n'est pas dans la liste de N-02 : écart de maquette suivi (migration 0009) ; il
 * n'est jamais proposé ni accepté pour une tâche ou une routine (`isReminderOffset` reste limité à REMINDER_OFFSETS_MIN).
 */
export const EVENT_REMINDER_OFFSETS_MIN = [10080, 1440, 0] as const;

/** Toute avance que la base accepte (`reminder.offset_min`). */
export type ReminderOffsetMin = (typeof REMINDER_OFFSETS_MIN)[number] | (typeof EVENT_REMINDER_OFFSETS_MIN)[number];

/** Avance de la liste de N-02 (tâches et routines) ; exclut « 1 semaine avant ». */
export function isReminderOffset(value: number): value is ReminderOffsetMin {
  return (REMINDER_OFFSETS_MIN as readonly number[]).includes(value);
}

/** Avance d'un événement (E-01) : 10080, 1440 ou 0 minute. */
export function isEventReminderOffset(value: number): value is ReminderOffsetMin {
  return (EVENT_REMINDER_OFFSETS_MIN as readonly number[]).includes(value);
}

/** Élément ciblé par un rappel. */
export type ReminderTarget =
  | { readonly type: 'task'; readonly id: TaskId }
  | { readonly type: 'routine'; readonly id: RoutineId }
  | { readonly type: 'event'; readonly id: EventId };

export type ReminderTargetType = ReminderTarget['type'];

/**
 * Rappel (M5). Table `reminder`. Ordre 1 : données et réglages seulement ; l'envoi
 * (planification des notifications locales) est fait à l'ordre 5 sur l'iPhone
 * uniquement : le PC n'émet jamais de rappel (CLAUDE.md).
 *
 * - `fireAt` : échéance en heure locale flottante, calculée par domain-logic à partir
 *   de la date / heure de la cible et de `offsetMin` ; recalculée quand la cible change ;
 * - `delivered` : posé par l'iPhone après planification / délivrance (ordre 5).
 */
export interface Reminder extends SyncMeta {
  readonly id: ReminderId;
  readonly targetType: ReminderTargetType;
  readonly targetId: Id;
  readonly offsetMin: ReminderOffsetMin;
  readonly fireAt: LocalDateTime;
  readonly delivered: boolean;
}

export type NewReminder = Omit<Reminder, keyof SyncMeta | 'delivered'> & { readonly id: ReminderId };
