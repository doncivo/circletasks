import { isReminderOffset, REMINDER_OFFSETS_MIN, type ReminderOffsetMin } from './model';
import { reminderFireAt } from './recurrenceNext';
import { nextOccurrences, type RoutineRule } from './routineSchedule';
import type { LocalDate, LocalDateTime, LocalTime } from './types';

/**
 * Rappels d'une routine (R-02) : données seulement à l'ordre 1 (CLAUDE.md : l'envoi est sur l'iPhone, ordre 5, jamais sur le PC).
 * Aucun rappel sans heure (QB-07). Une routine a une occurrence par jour mais un rappel n'a qu'une échéance (`fireAt`) : celle de
 * la PROCHAINE occurrence, recalculée par l'ordre 5 au fil des jours (heure locale flottante, T-11).
 */

/** Avances montrées d'emblée par le formulaire de routine (ModifierRoutine.html : « À l'heure » et « 30 min »). */
export const ROUTINE_QUICK_OFFSETS: readonly ReminderOffsetMin[] = [0, 30];

/** Avances que le formulaire de routine peut poser (N-02) : les six, les quatre autres sous « Plus… ». */
export const ROUTINE_FORM_OFFSETS: readonly ReminderOffsetMin[] = REMINDER_OFFSETS_MIN;

/**
 * Avances à enregistrer : aucune sans heure (QB-07) ; sinon les avances valides, sans doublon, de la plus courte à la plus longue.
 */
export function normalizeReminderOffsets(offsets: readonly number[], time: LocalTime | null): ReminderOffsetMin[] {
  if (time === null) return [];
  return [...new Set(offsets.filter(isReminderOffset))].sort((a, b) => a - b);
}

/**
 * Avances après un enregistrement du formulaire : les cases cochées parmi celles du formulaire, plus les avances que le formulaire
 * ne montre pas (posées ailleurs, N-02) qui restent inchangées.
 */
export function mergeReminderOffsets(existing: readonly ReminderOffsetMin[], checked: readonly ReminderOffsetMin[]): ReminderOffsetMin[] {
  const hidden = existing.filter((offset) => !ROUTINE_FORM_OFFSETS.includes(offset));
  return [...hidden, ...checked.filter((offset) => ROUTINE_FORM_OFFSETS.includes(offset))];
}

/**
 * Échéance (heure locale flottante) d'un rappel de routine : prochaine occurrence prévue à partir de `from` (aujourd'hui inclus),
 * à l'heure de la routine moins l'avance. Null si aucune occurrence n'est à venir (règle incohérente).
 */
export function routineReminderFireAt(rule: RoutineRule, time: LocalTime, from: LocalDate, offsetMin: number): LocalDateTime | null {
  const [next] = nextOccurrences(rule, from, 1);
  return next === undefined ? null : reminderFireAt(next, time, offsetMin);
}
