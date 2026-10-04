import { checkBirthYear, isAnnualKind, type BirthYearError } from './eventKinds';
import type { EventFields } from './model';
import { addDays, parseLocalDate } from './localDate';
import type { LocalDate, LocalTime, Result } from './types';

/**
 * Règles métier des événements locaux (M7, E-01 à E-04). Aucun accès base : les cas d'usage (src/features/events) appellent ces
 * fonctions puis écrivent par les repositories.
 */

/** Longueur maximale d'un titre d'événement (E-01 critère 6 : 1 à 200 caractères). */
export const EVENT_TITLE_MAX = 200;

/** Durée proposée d'un événement à heures (E-01 critère 3 : 1 h). */
export const EVENT_DEFAULT_DURATION_MIN = 60;

/** Heure locale d'un rappel d'événement « journée entière » (E-01 critère 5, D3). */
export const EVENT_ALL_DAY_REMINDER_TIME = '09:00' as LocalTime;

export type EventError = 'empty-title' | 'title-too-long' | 'missing-time' | 'end-before-start' | BirthYearError;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const minutesOf = (time: LocalTime): number => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export interface LocalMoment {
  readonly date: LocalDate;
  readonly time: LocalTime;
}

/** Date et heure `minutes` minutes après (ou avant, si négatif) le moment donné ; passe au jour suivant au besoin. */
export function addMinutesTo(date: LocalDate, time: LocalTime, minutes: number): LocalMoment {
  const total = minutesOf(time) + minutes;
  const dayShift = Math.floor(total / 1440);
  const inDay = total - dayShift * 1440;
  return { date: addDays(date, dayShift), time: `${pad2(Math.floor(inDay / 60))}:${pad2(inDay % 60)}` as LocalTime };
}

/** Fin proposée quand on choisit un début : une heure plus tard (E-01 critère 3). */
export function defaultEventEnd(startDate: LocalDate, startTime: LocalTime): LocalMoment {
  return addMinutesTo(startDate, startTime, EVENT_DEFAULT_DURATION_MIN);
}

/** Minutes écoulées entre deux moments locaux (début et fin d'un événement à heures). */
export function eventDurationMin(start: LocalMoment, end: LocalMoment): number {
  const absolute = (p: LocalMoment): number => Math.round(Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10))) / 60_000) + minutesOf(p.time);
  return absolute(end) - absolute(start);
}

/**
 * Nouveau début choisi dans le formulaire : la fin suit pour garder la même durée (critère 3 : « fin >= début »), ou une heure
 * plus tard si la durée précédente était négative.
 */
export function endAfterStartChange(previousStart: LocalMoment, nextStart: LocalMoment, end: LocalMoment): LocalMoment {
  const duration = eventDurationMin(previousStart, end);
  return addMinutesTo(nextStart.date, nextStart.time, duration >= 0 ? duration : EVENT_DEFAULT_DURATION_MIN);
}

/** Titre nettoyé (espaces de bord retirés) : 1 à 200 caractères. */
export function validateEventTitle(raw: string): Result<string, 'empty-title' | 'title-too-long'> {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, error: 'empty-title' };
  if (title.length > EVENT_TITLE_MAX) return { ok: false, error: 'title-too-long' };
  return { ok: true, value: title };
}

export interface ValidateEventOptions {
  /** Aujourd'hui : l'année de naissance ne peut pas être future (E-02 critère 4) ; absent : cette règle n'est pas vérifiée. */
  readonly today?: LocalDate;
}

/**
 * Valide et normalise les champs d'un événement local (E-01 critères 3 et 6, D1 ; E-02) :
 * - titre de 1 à 200 caractères ;
 * - anniversaire et date importante : annuel, journée entière, année de naissance facultative (1900 à aujourd'hui) ;
 * - « journée entière » : un seul jour, sans heure (la fin vaut le début) ;
 * - sinon début et fin avec heure, fin >= début (une plage peut passer minuit).
 * Un événement ordinaire n'a pas d'année de naissance.
 */
export function validateEvent(fields: EventFields, options: ValidateEventOptions = {}): Result<EventFields, EventError> {
  const title = validateEventTitle(fields.title);
  if (!title.ok) return title;
  if (isAnnualKind(fields.kind)) {
    const birth = checkBirthYear(fields.birthYear, options.today ? parseLocalDate(options.today).year : null);
    if (birth !== null) return { ok: false, error: birth };
    return { ok: true, value: { ...fields, title: title.value, repeat: 'yearly', allDay: true, startTime: null, endDate: fields.startDate, endTime: null } };
  }
  if (fields.birthYear !== null) return validateEvent({ ...fields, birthYear: null }, options);
  if (fields.allDay) {
    return { ok: true, value: { ...fields, title: title.value, endDate: fields.startDate, startTime: null, endTime: null } };
  }
  if (fields.startTime === null || fields.endTime === null) return { ok: false, error: 'missing-time' };
  if (eventDurationMin({ date: fields.startDate, time: fields.startTime }, { date: fields.endDate, time: fields.endTime }) < 0) return { ok: false, error: 'end-before-start' };
  return { ok: true, value: { ...fields, title: title.value } };
}

interface Sortable {
  readonly date: LocalDate;
  readonly allDay: boolean;
  readonly startTime: LocalTime | null;
  readonly title: string;
  readonly id: string;
}

/** Tri chronologique stable : jour, journée entière avant les heures, heure de début, titre, id. */
export function compareByStart(a: Sortable, b: Sortable): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const ta = a.startTime ?? '';
  const tb = b.startTime ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
