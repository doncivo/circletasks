import { occurrenceStarts } from './eventOccurrences';
import { addDays } from './localDate';
import type { CalendarEvent } from './model';
import { daysBetween } from './routineSchedule';
import type { LocalDate } from './types';

/**
 * Compte à rebours « J-12 » (E-04). Tout se calcule en jours CALENDAIRES locaux entre deux dates civiles (arithmétique UTC sur 'YYYY-MM-DD'),
 * jamais en divisant des millisecondes : un changement d'heure (23 h ou 25 h dans la journée) ou de fuseau ne décale aucun compte.
 * « Aujourd'hui » est fourni par l'appelant (horloge injectable) : le compte se met à jour au passage de minuit sans relancer l'app.
 */

/** Jours de `today` à `date` : 12 pour dans 12 jours, 0 le jour même, négatif si la date est passée. */
export function daysUntil(date: LocalDate, today: LocalDate): number {
  return daysBetween(today, date);
}

/**
 * Compte à rebours d'un événement qui couvre [date, endDate] : 0 pendant l'événement (« Aujourd'hui »), n pour dans n jours, null une fois
 * l'événement passé (E-04 critère 2 : après, aucun tag).
 */
export function countdownOf(span: { readonly date: LocalDate; readonly endDate: LocalDate }, today: LocalDate): number | null {
  if (span.date <= today && span.endDate >= today) return 0;
  const days = daysUntil(span.date, today);
  return days > 0 ? days : null;
}

/** Horizon de recherche de la prochaine occurrence (annuel : un an, plus de la marge). */
const LOOKAHEAD_DAYS = 800;

/**
 * Compte à rebours d'une planification (début, fin, répétition) vers sa prochaine occurrence (E-04 critère 6) : 0 si une occurrence a lieu
 * aujourd'hui, n pour la prochaine à venir (série mensuelle ou annuelle), null pour un événement unique passé. Sert aussi à l'aperçu
 * « Compte à rebours (J-2) » du formulaire, avant l'enregistrement.
 */
export function scheduleCountdown(schedule: Pick<CalendarEvent, 'startDate' | 'endDate' | 'repeat'>, today: LocalDate): number | null {
  if (occurrenceStarts(schedule, today, today).length > 0) return 0;
  const [next] = occurrenceStarts(schedule, today, addDays(today, LOOKAHEAD_DAYS)).filter((start) => start >= today);
  return next === undefined ? null : daysUntil(next, today);
}

/** Compte à rebours d'un événement local vers sa prochaine occurrence (E-04 critère 6). */
export function nextCountdown(event: CalendarEvent, today: LocalDate): number | null {
  return scheduleCountdown(event, today);
}
