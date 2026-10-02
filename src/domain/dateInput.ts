import { addDays, daysInMonth, makeLocalDate, parseLocalDate, weekdayOf } from './localDate';
import { nextWeekFrom } from './taskPostpone';
import type { LocalDate, LocalTime, Result, Weekday } from './types';

/**
 * Saisie d'une date et d'une heure (T-14) : analyse du français libre (24 h), sans dépendance externe
 * (chrono-node : Q-02, titre des tâches). Fonctions pures : « aujourd'hui » est fourni par l'appelant.
 *
 * Exemples compris : « demain », « après-demain », « lun. 10h », « ven 10h », « lundi prochain »,
 * « semaine prochaine », « 25/09 », « 25/09/2026 », « 25.09 », « 2026-09-25 », « 25 sept. 14:30 »,
 * « ven. 25 sept. », « le 1er octobre », « dans 3 jours », « dans 2 semaines », « dans 1 mois »,
 * « 10h » (aujourd'hui à 10:00), « un jour » (sans date).
 * Décisions : un jour de semaine seul (« ven ») donne la prochaine occurrence STRICTEMENT après aujourd'hui
 * (« aujourd'hui » a son propre mot) ; « lundi prochain » est le lundi de la semaine suivante (comme
 * « Semaine prochaine », Q4) ; une date sans année (« 25/09 ») est la prochaine occurrence à partir
 * d'aujourd'hui (aujourd'hui compris).
 */

/** Choix d'un sélecteur de date : `date` null = « Un jour » (sans date, donc sans heure : invariant M18). */
export interface DateChoice {
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
}

export type DateInputError = 'empty' | 'unparsable';

/** Normalise : minuscules, sans accents ni ponctuation superflue, espaces simples. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/(\d)\.(\d)/g, '$1/$2')
    .replace(/\./g, ' ')
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WEEKDAYS: Readonly<Record<string, Weekday>> = {
  lun: 1, lundi: 1,
  mar: 2, mardi: 2,
  mer: 3, mercredi: 3,
  jeu: 4, jeudi: 4,
  ven: 5, vendredi: 5,
  sam: 6, samedi: 6,
  dim: 7, dimanche: 7,
};

const MONTHS: Readonly<Record<string, number>> = {
  janv: 1, janvier: 1, jan: 1,
  fev: 2, fevr: 2, fevrier: 2,
  mars: 3, mar: 3,
  avr: 4, avril: 4,
  mai: 5,
  juin: 6,
  juil: 7, juillet: 7,
  aout: 8,
  sept: 9, sep: 9, septembre: 9,
  oct: 10, octobre: 10,
  nov: 11, novembre: 11,
  dec: 12, decembre: 12,
};

function validTime(hours: number, minutes: number): LocalTime | null {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` as LocalTime;
}

/**
 * Champ « Heure » : « 10 », « 10h », « 10h30 », « 10:00 », « 1030 », « 930 » ; vide = sans heure (`null`).
 * Heures de 0 à 23, minutes de 0 à 59 (24 h).
 */
export function parseTimeInput(text: string): Result<LocalTime | null, 'invalid'> {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (s === '') return { ok: true, value: null };
  let match = /^(\d{1,2})(?:h|:)?(\d{2})?$/.exec(s);
  if (match && (s.includes('h') || s.includes(':') || s.length <= 2)) {
    const time = validTime(Number(match[1]), match[2] === undefined ? 0 : Number(match[2]));
    return time ? { ok: true, value: time } : { ok: false, error: 'invalid' };
  }
  match = /^(\d{1,2})(\d{2})$/.exec(s);
  if (match) {
    const time = validTime(Number(match[1]), Number(match[2]));
    return time ? { ok: true, value: time } : { ok: false, error: 'invalid' };
  }
  return { ok: false, error: 'invalid' };
}

/** Extrait une heure (« 10h », « 10h30 », « 14:30 », « à 10h ») du texte normalisé ; rend le reste. */
function extractTime(text: string): { time: LocalTime | null; rest: string; invalid: boolean } {
  const match = /(?:^|\s)(?:a\s+)?(\d{1,2})\s*(?:h\s*(\d{2})?|:\s*(\d{2}))(?=\s|$)/.exec(text);
  if (!match) return { time: null, rest: text, invalid: false };
  const hours = Number(match[1]);
  const minutes = match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? Number(match[3]) : 0;
  const time = validTime(hours, minutes);
  const rest = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  return { time, rest, invalid: time === null };
}

function validDate(year: number, month: number, day: number): LocalDate | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return makeLocalDate(year, month, day);
}

/** Première occurrence de (jour, mois) à partir de `today` (aujourd'hui compris), cherchée sur 8 ans pour le 29 février. */
function nextDayMonth(today: LocalDate, month: number, day: number): LocalDate | null {
  const { year } = parseLocalDate(today);
  for (let y = year; y <= year + 8; y += 1) {
    const candidate = validDate(y, month, day);
    if (candidate !== null && candidate >= today) return candidate;
  }
  return null;
}

/** Prochaine occurrence du jour de semaine strictement après `today`. */
function nextWeekday(today: LocalDate, weekday: Weekday): LocalDate {
  const delta = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

function parseDatePart(raw: string, today: LocalDate): Result<LocalDate | 'someday', 'unparsable'> {
  const bad = { ok: false, error: 'unparsable' } as const;
  let s = raw.replace(/^(?:le|pour|ce|cet|cette)\s+/, '');
  if (s === '') return bad;

  const simple: Record<string, () => LocalDate> = {
    "aujourd'hui": () => today,
    aujourdhui: () => today,
    auj: () => today,
    demain: () => addDays(today, 1),
    'apres-demain': () => addDays(today, 2),
    'apres demain': () => addDays(today, 2),
    hier: () => addDays(today, -1),
    'semaine prochaine': () => nextWeekFrom(today),
  };
  const direct = simple[s];
  if (direct) return { ok: true, value: direct() };
  if (s === 'un jour' || s === 'someday' || s === 'plus tard') return { ok: true, value: 'someday' };

  // « dans 3 jours », « dans 2 semaines », « dans 1 mois »
  let match = /^dans (\d{1,3}) (jour|jours|j|semaine|semaines|sem|mois)$/.exec(s);
  if (match) {
    const n = Number(match[1]);
    const unit = match[2] ?? '';
    if (unit === 'mois') {
      const { year, month, day } = parseLocalDate(today);
      const total = year * 12 + (month - 1) + n;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      return { ok: true, value: makeLocalDate(y, m, Math.min(day, daysInMonth(y, m))) };
    }
    return { ok: true, value: addDays(today, unit.startsWith('s') ? n * 7 : n) };
  }

  // Jour de semaine éventuellement suivi de « prochain » ; sinon laissé pour « ven. 25 sept. ».
  match = /^([a-z]+)(?: (prochain|prochaine))?$/.exec(s);
  if (match && match[1] !== undefined && WEEKDAYS[match[1]] !== undefined) {
    const weekday = WEEKDAYS[match[1]] as Weekday;
    return { ok: true, value: match[2] ? addDays(nextWeekFrom(today), weekday - 1) : nextWeekday(today, weekday) };
  }

  // Un jour de semaine devant une date : « ven 25/09 », « ven. 25 sept. » (ignoré, la date prime).
  match = /^([a-z]+) (.+)$/.exec(s);
  if (match && match[1] !== undefined && WEEKDAYS[match[1]] !== undefined && /\d/.test(match[2] ?? '')) s = match[2] ?? s;

  // ISO « 2026-09-25 »
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return date ? { ok: true, value: date } : bad;
  }

  // « 25/09 », « 25/09/2026 », « 25/09/26 », « 25-09 »
  match = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(s);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (match[3] === undefined) {
      const date = nextDayMonth(today, month, day);
      return date ? { ok: true, value: date } : bad;
    }
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = validDate(year, month, day);
    return date ? { ok: true, value: date } : bad;
  }

  // « 25 sept. », « 25 septembre 2026 », « 1er oct », « 25 sept 26 »
  match = /^(\d{1,2})(?:er)? ([a-z]+)(?: (\d{4}|\d{2}))?$/.exec(s);
  if (match && match[2] !== undefined && MONTHS[match[2]] !== undefined) {
    const day = Number(match[1]);
    const month = MONTHS[match[2]] as number;
    if (match[3] === undefined) {
      const date = nextDayMonth(today, month, day);
      return date ? { ok: true, value: date } : bad;
    }
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = validDate(year, month, day);
    return date ? { ok: true, value: date } : bad;
  }
  return bad;
}

/**
 * Analyse la saisie libre du champ Date. « Un jour » donne `{ date: null, time: null }`. Une heure seule (« 10h »)
 * vaut aujourd'hui à cette heure. Rend `empty` pour un texte vide (la saisie n'a rien à valider) et
 * `unparsable` (« Date non comprise ») sinon.
 */
export function parseFrenchDate(text: string, today: LocalDate): Result<DateChoice, DateInputError> {
  const normalized = normalize(text);
  if (normalized === '') return { ok: false, error: 'empty' };
  const { time, rest, invalid } = extractTime(normalized);
  if (invalid) return { ok: false, error: 'unparsable' };
  if (rest === '') return time ? { ok: true, value: { date: today, time } } : { ok: false, error: 'unparsable' };
  const date = parseDatePart(rest, today);
  if (!date.ok) return date;
  if (date.value === 'someday') return { ok: true, value: { date: null, time: null } };
  return { ok: true, value: { date: date.value, time } };
}
