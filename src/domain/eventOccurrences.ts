import { addDays, daysInMonth, makeLocalDate, parseLocalDate } from './localDate';
import type { CalendarEvent } from './model';
import { daysBetween } from './routineSchedule';
import type { LocalDate } from './types';

/**
 * Occurrences d'un événement local (E-01 critère 4, E-02 critère 5). Une occurrence couvre autant de jours que l'événement d'origine
 * (`span`) ; elle commence :
 * - Une fois : à la date de début ;
 * - Mensuel : le même quantième chaque mois, à partir du mois du début ; le 29, 30 ou 31 devient le dernier jour d'un mois plus court ;
 * - Annuel : le même jour et le même mois chaque année, à partir de l'année du début ; le 29 févr. devient le 28 les années non bissextiles.
 * Jamais d'occurrence avant la date de début. Calcul sur des dates civiles, sans fuseau (aucun effet de changement d'heure).
 */
export interface EventOccurrence {
  readonly event: CalendarEvent;
  /** Premier jour de l'occurrence. */
  readonly date: LocalDate;
  /** Dernier jour de l'occurrence (égal à `date` pour une journée entière). */
  readonly endDate: LocalDate;
}

type Recurring = Pick<CalendarEvent, 'startDate' | 'endDate' | 'repeat'>;

/** Nombre de jours que l'événement couvre en plus de son premier jour (0 : un seul jour). */
function spanDays(event: Pick<CalendarEvent, 'startDate' | 'endDate'>): number {
  return Math.max(0, daysBetween(event.startDate, event.endDate));
}

/** Jour d'un mois : le quantième demandé, ramené au dernier jour d'un mois plus court (31 → 30 ou 28, 29 févr. → 28). */
export function clampedDay(year: number, month: number, day: number): LocalDate {
  return makeLocalDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/** Dates de début des occurrences dont les jours touchent la plage [from, to] (bornes incluses), dans l'ordre. */
export function occurrenceStarts(event: Recurring, from: LocalDate, to: LocalDate): LocalDate[] {
  const span = spanDays(event);
  const first = event.startDate;
  // Une occurrence qui commence avant `from` mais finit après le touche encore.
  const earliestStart = addDays(from, -span);
  const touches = (start: LocalDate): boolean => start >= first && start >= earliestStart && start <= to;
  if (event.repeat === 'once') return touches(first) ? [first] : [];

  const origin = parseLocalDate(first);
  const out: LocalDate[] = [];
  const lo = parseLocalDate(earliestStart);
  const hi = parseLocalDate(to);
  if (event.repeat === 'monthly') {
    for (let index = lo.year * 12 + (lo.month - 1); index <= hi.year * 12 + (hi.month - 1); index += 1) {
      const date = clampedDay(Math.floor(index / 12), (index % 12) + 1, origin.day);
      if (touches(date)) out.push(date);
    }
    return out;
  }
  for (let year = lo.year; year <= hi.year; year += 1) {
    const date = clampedDay(year, origin.month, origin.day);
    if (touches(date)) out.push(date);
  }
  return out;
}

/** Occurrences de l'événement qui touchent la plage [from, to]. */
export function occurrencesInRange(event: CalendarEvent, from: LocalDate, to: LocalDate): EventOccurrence[] {
  const span = spanDays(event);
  return occurrenceStarts(event, from, to).map((date) => ({ event, date, endDate: addDays(date, span) }));
}

/** Occurrences de plusieurs événements dans la plage (même règle), non triées. */
export function occurrencesOfEvents(events: readonly CalendarEvent[], from: LocalDate, to: LocalDate): EventOccurrence[] {
  return events.flatMap((event) => occurrencesInRange(event, from, to));
}

/** Horizon de recherche de la prochaine occurrence (annuel : un an, plus de la marge). */
const LOOKAHEAD_DAYS = 800;

/** Première occurrence qui COMMENCE à `from` ou après (compte à rebours, rappels, E-04 critère 6) ; null si un événement unique est passé. */
export function nextOccurrence(event: CalendarEvent, from: LocalDate): EventOccurrence | null {
  const [date] = occurrenceStarts(event, from, addDays(from, LOOKAHEAD_DAYS)).filter((start) => start >= from);
  return date === undefined ? null : { event, date, endDate: addDays(date, spanDays(event)) };
}
