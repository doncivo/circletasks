import type { QuietHours } from './model';
import { coveringRanges, effectiveFireAt, isAllDayRange } from './quietHours';
import { reminderFireAt } from './recurrenceNext';
import { plannedDates, type DateInterval, type RoutineRule } from './routineSchedule';
import { addDays, weekdayOf } from './localDate';
import type { LocalDateTime, LocalTime, Weekday } from './types';
import type { LocalDate } from './types';

/**
 * N-FIX-04 (décision d'Ali du 2026-10-27) : au moment où une heure de rappel tombe dans une plage silencieuse de l'espace, l'app le dit,
 * avec UNE cause ; et la ligne d'une routine dit si ses rappels sont tous, en partie, ou jamais décalés. Fonctions pures ; l'échéance
 * effective reste celle de `effectiveFireAt` (ES-07), rien n'est replanifié ici.
 */

/** La cause nommée d'un décalage : la plage qui couvre l'heure CHOISIE, pas celles traversées ensuite. */
export type QuietCause =
  /** Plage horaire commencée le jour même : « aucun rappel Pro après 19:00 ». */
  | { readonly kind: 'after'; readonly from: LocalTime }
  /** Plage horaire commencée la veille (partie du matin) : « aucun rappel Pro avant 08:00 ». */
  | { readonly kind: 'before'; readonly to: LocalTime }
  /** Journée entière le samedi et le dimanche exactement : « le week-end ». */
  | { readonly kind: 'weekend' }
  /** Journée entière sur d'autres jours : « le mercredi ». */
  | { readonly kind: 'all-day'; readonly weekdays: readonly Weekday[] };

export interface QuietShift {
  readonly fireAt: LocalDateTime;
  readonly effective: LocalDateTime;
  readonly cause: QuietCause;
}

const WEEKEND: readonly Weekday[] = [6, 7];
const isWeekend = (weekdays: readonly Weekday[]): boolean => weekdays.length === 2 && WEEKEND.every((day) => weekdays.includes(day));

/**
 * Décalage d'une échéance par les plages d'un espace, ou null si elle sonne à l'heure choisie (aucune plage, heure hors plage, ou silence
 * continu sur la semaine : l'échéance d'origine est rendue, ES-07 critère 7). Cause : parmi les plages qui couvrent l'heure choisie, une
 * journée entière l'emporte sur une plage horaire (un samedi 20:00 est décalé « par le week-end », pas « après 19:00 ») ; entre plages
 * horaires, celle commencée le jour même (« après ») l'emporte sur celle commencée la veille (« avant »).
 */
export function quietShift(fireAt: LocalDateTime, quietHours: readonly QuietHours[]): QuietShift | null {
  const effective = effectiveFireAt(fireAt, quietHours);
  if (effective === fireAt) return null;
  const covering = coveringRanges(fireAt, quietHours);
  const allDay = covering.find((item) => isAllDayRange(item.range));
  if (allDay !== undefined) {
    return { fireAt, effective, cause: isWeekend(allDay.range.weekdays) ? { kind: 'weekend' } : { kind: 'all-day', weekdays: allDay.range.weekdays } };
  }
  const today = covering.find((item) => !item.startedPreviousDay);
  if (today !== undefined) return { fireAt, effective, cause: { kind: 'after', from: today.range.from } };
  const yesterday = covering[0];
  if (yesterday !== undefined) return { fireAt, effective, cause: { kind: 'before', to: yesterday.range.to } };
  // Impossible en principe (une échéance décalée est couverte) ; rendu comme une plage horaire sans borne connue.
  return { fireAt, effective, cause: { kind: 'after', from: fireAt.slice(11, 16) as LocalTime } };
}

/** Cible commune des rappels décalés d'une routine : jour et heure si tous identiques, heure seule, ou rien. */
export interface QuietTarget {
  readonly weekday: Weekday | null;
  readonly time: LocalTime | null;
}

/** Les trois états de la ligne de l'écran Routines : jamais silencieux par défaut (demande d'Ali). */
export type RoutineQuietSummary =
  | { readonly state: 'none' }
  | { readonly state: 'all'; readonly time: LocalTime | null }
  | { readonly state: 'partial'; readonly weekdays: readonly Weekday[]; readonly target: QuietTarget };

/** Nombre d'occurrences examinées : une semaine de routine quotidienne, assez pour voir le week-end. */
export const ROUTINE_QUIET_LOOKAHEAD = 7;
/** Fenêtre de recherche de ces occurrences : quatre semaines (une routine « toutes les 2 semaines » y a ses deux prochaines). */
export const ROUTINE_QUIET_WINDOW_DAYS = 28;

type RoutineLike = RoutineRule & { readonly time: LocalTime | null };

/**
 * Résumé des décalages d'une routine sur ses `ROUTINE_QUIET_LOOKAHEAD` prochaines occurrences prévues à partir de `from` dans les
 * `ROUTINE_QUIET_WINDOW_DAYS` jours (pauses exclues), pour chaque avance : `all` si chaque couple (occurrence, avance) est décalé, `partial`
 * si certains le sont (jours des occurrences touchées, cible commune), `none` sinon ou sans heure, sans avance, sans occurrence.
 */
export function routineQuietSummary(routine: RoutineLike, offsets: readonly number[], quietHours: readonly QuietHours[], from: LocalDate, pauses: readonly DateInterval[] = []): RoutineQuietSummary {
  const time = routine.time;
  if (time === null || offsets.length === 0 || quietHours.length === 0) return { state: 'none' };
  const occurrences = plannedDates(routine, from, addDays(from, ROUTINE_QUIET_WINDOW_DAYS - 1), pauses).slice(0, ROUTINE_QUIET_LOOKAHEAD);
  if (occurrences.length === 0) return { state: 'none' };
  let total = 0;
  const shifted: { readonly date: LocalDate; readonly effective: LocalDateTime }[] = [];
  for (const date of occurrences) {
    for (const offset of offsets) {
      total += 1;
      const shift = quietShift(reminderFireAt(date, time, offset), quietHours);
      if (shift !== null) shifted.push({ date, effective: shift.effective });
    }
  }
  if (shifted.length === 0) return { state: 'none' };
  const times = new Set(shifted.map((item) => item.effective.slice(11, 16)));
  const commonTime = times.size === 1 ? ([...times][0] as LocalTime) : null;
  if (shifted.length === total) return { state: 'all', time: commonTime };
  const weekdays = [...new Set(shifted.map((item) => weekdayOf(item.date)))].sort((a, b) => a - b);
  const days = new Set(shifted.map((item) => weekdayOf(item.effective.slice(0, 10) as LocalDate)));
  const commonDay = days.size === 1 ? ([...days][0] as Weekday) : null;
  return { state: 'partial', weekdays, target: { weekday: commonTime === null ? null : commonDay, time: commonTime } };
}
