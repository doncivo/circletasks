import { isReminderOffset, type Reminder, type ReminderOffsetMin } from '../../domain/model';
import type { RoutineId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * N-FIX-04 : avances vivantes de chaque routine, pour la ligne « Rappels décalés » de la carte. Chargé par l'écran Routines (à la demande),
 * jamais par le store du départ : une avance par (routine, avance), comme le planificateur.
 */
export function groupRoutineOffsets(reminders: readonly Reminder[]): Map<RoutineId, readonly ReminderOffsetMin[]> {
  const out = new Map<RoutineId, ReminderOffsetMin[]>();
  for (const reminder of reminders) {
    if (reminder.targetType !== 'routine' || reminder.deletedAt !== null || !isReminderOffset(reminder.offsetMin)) continue;
    const id = reminder.targetId as RoutineId;
    const known = out.get(id) ?? [];
    if (!known.includes(reminder.offsetMin)) out.set(id, [...known, reminder.offsetMin].sort((a, b) => a - b));
  }
  return out;
}

/** Lit les rappels vivants et les regroupe par routine ; ne rejette jamais (aucune ligne en cas d'échec de lecture). */
export async function loadRoutineOffsets(container: Pick<AppContainer, 'data'>): Promise<Map<RoutineId, readonly ReminderOffsetMin[]>> {
  try {
    return groupRoutineOffsets(await container.data.repos.reminders.listLive());
  } catch {
    return new Map<RoutineId, readonly ReminderOffsetMin[]>();
  }
}
