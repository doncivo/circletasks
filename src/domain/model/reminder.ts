import type { Id, LocalDateTime, ReminderId, RoutineId, SyncMeta, TaskId, EventId } from '../types';

/** Avances proposées (N-02), en minutes : à l'heure, 5, 15, 30, 60 min, 1 jour. */
export const REMINDER_OFFSETS_MIN = [0, 5, 15, 30, 60, 1440] as const;
export type ReminderOffsetMin = (typeof REMINDER_OFFSETS_MIN)[number];

export function isReminderOffset(value: number): value is ReminderOffsetMin {
  return (REMINDER_OFFSETS_MIN as readonly number[]).includes(value);
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
