import { clampedDay } from './eventOccurrences';
import { daysInMonth, makeLocalDate, parseLocalDate } from './localDate';
import type { CalendarEvent, EventFields, EventKind, IconRef, ReminderOffsetMin } from './model';
import type { LocalDate } from './types';

/**
 * Types d'événement (E-02) : « Événement », « Anniversaire », « Date importante ». Un anniversaire et une date importante sont
 * annuels à vie, sur une journée entière, avec rappels « La veille » et « Le jour même » et compte à rebours par défaut.
 */

/** Plus ancienne année de naissance proposée (roue des années, validation). */
export const MIN_BIRTH_YEAR = 1900;

export const EVENT_KINDS: readonly EventKind[] = ['event', 'birthday', 'important'];

/** Anniversaire ou date importante : répétition annuelle imposée, journée entière implicite (E-02 critère 1). */
export function isAnnualKind(kind: EventKind): boolean {
  return kind === 'birthday' || kind === 'important';
}

/** Icône du catalogue (T-03) proposée par défaut : un gâteau pour un anniversaire, une étoile pour une date importante (critère 1). */
export function defaultIconFor(kind: EventKind): IconRef | null {
  if (kind === 'birthday') return { kind: 'lucide', name: 'cake' };
  if (kind === 'important') return { kind: 'lucide', name: 'star' };
  return null;
}

/** Rappels cochés d'office à la création d'un anniversaire ou d'une date importante (critère 6) : « La veille » et « Le jour même ». */
export const ANNUAL_DEFAULT_REMINDERS: readonly ReminderOffsetMin[] = [0, 1440];

/** Compte à rebours (E-04 D2) : activé d'office pour un anniversaire et une date importante, désactivé pour un événement. */
export function defaultCountdown(kind: EventKind): boolean {
  return isAnnualKind(kind);
}

/** Bissextile ? */
export function isLeapYear(year: number): boolean {
  return daysInMonth(year, 2) === 29;
}

/**
 * Date de début stockée d'un événement annuel : le jour et le mois choisis, dans l'année de naissance si elle est connue (l'événement
 * existe depuis cette année, la liste montre les années antérieures), sinon dans l'année en cours. Le 29 févr. d'une année non bissextile
 * devient le 28 ; sans année de naissance, on retient la dernière année bissextile pour que le 29 févr. soit conservé (critère 5).
 */
export function annualStartDate(month: number, day: number, birthYear: number | null, todayYear: number): LocalDate {
  if (birthYear !== null) return clampedDay(birthYear, month, day);
  if (month === 2 && day === 29) {
    let year = todayYear;
    while (!isLeapYear(year)) year -= 1;
    return makeLocalDate(year, 2, 29);
  }
  return clampedDay(todayYear, month, day);
}

/** Prochaine date (aujourd'hui compris) d'un jour et d'un mois : sert à repasser un anniversaire en événement ordinaire. */
export function nextAnnualDate(month: number, day: number, today: LocalDate): LocalDate {
  const { year } = parseLocalDate(today);
  const thisYear = clampedDay(year, month, day);
  return thisYear >= today ? thisYear : clampedDay(year + 1, month, day);
}

/** Âge ou années écoulées à l'occurrence affichée (D3 : calculé sur l'année de l'occurrence) ; null sans année de naissance (critère 3). */
export function ageAtOccurrence(event: Pick<CalendarEvent, 'kind' | 'birthYear'>, occurrenceDate: LocalDate): number | null {
  if (!isAnnualKind(event.kind) || event.birthYear === null) return null;
  const age = parseLocalDate(occurrenceDate).year - event.birthYear;
  return age >= 0 ? age : null;
}

export type BirthYearError = 'birth-year-invalid' | 'birth-year-future';

/** Année de naissance facultative : un entier de 1900 à l'année en cours, jamais future (critère 4). */
export function checkBirthYear(birthYear: number | null, todayYear: number | null): BirthYearError | null {
  if (birthYear === null) return null;
  if (!Number.isInteger(birthYear) || birthYear < MIN_BIRTH_YEAR) return 'birth-year-invalid';
  if (todayYear !== null && birthYear > todayYear) return 'birth-year-future';
  return null;
}

/**
 * Champs d'un événement après un changement de type (critère 7) : le titre, l'espace et l'icône sont conservés (l'icône n'est
 * remplacée que si elle était absente ou celle par défaut du type précédent). Annuel : répétition « Annuel » et journée entière
 * imposées. Les rappels et le compte à rebours par défaut sont gérés par le formulaire.
 */
export function applyKind(fields: EventFields, next: EventKind): EventFields {
  const previousDefault = defaultIconFor(fields.kind);
  const keepIcon = fields.icon !== null && !(previousDefault !== null && fields.icon.kind === 'lucide' && previousDefault.kind === 'lucide' && fields.icon.name === previousDefault.name);
  const icon = keepIcon ? fields.icon : defaultIconFor(next);
  if (!isAnnualKind(next)) return { ...fields, kind: next, icon, birthYear: null };
  return { ...fields, kind: next, icon, repeat: 'yearly', allDay: true, startTime: null, endTime: null, endDate: fields.startDate };
}
