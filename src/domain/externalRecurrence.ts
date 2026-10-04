import { addDays, daysInMonth, makeLocalDate, parseLocalDate, weekdayOf } from './localDate';
import type { LocalDate } from './types';

/**
 * Développement des récurrences RRULE d'un événement externe sur la plage demandée (K-02 critère 5, ADR 0008 : iCloud développe
 * déjà les séries avec `expand`, ce code est le filet de sécurité d'un serveur qui ne le fait pas). Travaille sur des DATES civiles :
 * l'heure et le fuseau de l'événement sont appliqués par l'appelant à chaque date produite.
 *
 * Gérés : FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (avec rang en mensuel et annuel), BYMONTHDAY (négatif
 * accepté), BYMONTH, BYSETPOS, WKST. Non gérés (la série est alors réduite à son premier événement) : FREQ de moins d'un jour,
 * BYWEEKNO, BYYEARDAY.
 *
 * Module pur du domaine : les fournisseurs (src/features/calendars/providers) l'appellent sans rien développer eux-mêmes.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ByDay {
  /** Rang dans le mois ou l'année (1 = premier, -1 = dernier) ; null : chaque semaine. */
  readonly ordinal: number | null;
  /** Jour ISO : 1 = lundi … 7 = dimanche. */
  readonly weekday: number;
}

export interface RecurrenceRule {
  readonly frequency: Frequency;
  readonly interval: number;
  readonly count: number | null;
  /** Dernier jour inclus (DATE) ou instant UTC (DATE-TIME en Z) : valeur brute comparée par l'appelant. */
  readonly until: string | null;
  readonly byDay: readonly ByDay[];
  readonly byMonthDay: readonly number[];
  readonly byMonth: readonly number[];
  readonly bySetPos: readonly number[];
  /** Premier jour de la semaine (ISO) pour FREQ=WEEKLY ; lundi par défaut. */
  readonly weekStart: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

const numbers = (value: string | undefined): number[] => (value ? value.split(',').map(Number) : []);

/** Lit une valeur RRULE ; null si elle est illisible ou utilise une règle non gérée. */
export function parseRecurrenceRule(value: string): RecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const part of value.split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0) parts.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1));
  }
  const frequency = parts.get('FREQ');
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY' && frequency !== 'YEARLY') return null;
  if (parts.has('BYWEEKNO') || parts.has('BYYEARDAY')) return null;
  const byDay: ByDay[] = [];
  for (const token of (parts.get('BYDAY') ?? '').split(',').filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim());
    const weekday = match ? WEEKDAYS[match[2] ?? ''] : undefined;
    if (!match || weekday === undefined) return null;
    byDay.push({ ordinal: match[1] === undefined ? null : Number(match[1]), weekday });
  }
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  const byMonthDay = numbers(parts.get('BYMONTHDAY'));
  const byMonth = numbers(parts.get('BYMONTH'));
  const bySetPos = numbers(parts.get('BYSETPOS'));
  if (!Number.isInteger(interval) || interval < 1 || (count !== null && (!Number.isInteger(count) || count < 1))) return null;
  if ([...byMonthDay, ...byMonth, ...bySetPos].some((n) => !Number.isInteger(n))) return null;
  return { frequency, interval, count, until: parts.get('UNTIL') ?? null, byDay, byMonthDay, byMonth, bySetPos, weekStart: WEEKDAYS[parts.get('WKST') ?? 'MO'] ?? 1 };
}

/** n-ième jour de semaine ISO (1 = lundi) du mois ; rang négatif depuis la fin (-1 = dernier) ; null s'il n'existe pas (5ᵉ lundi absent). */
export function nthWeekdayDate(year: number, month: number, weekday: number, ordinal: number): LocalDate | null {
  const last = daysInMonth(year, month);
  const days: number[] = [];
  for (let day = 1; day <= last; day += 1) if (weekdayOf(makeLocalDate(year, month, day)) === weekday) days.push(day);
  const day = ordinal > 0 ? days[ordinal - 1] : days[days.length + ordinal];
  return day === undefined ? null : makeLocalDate(year, month, day);
}

const compareDates = (a: LocalDate, b: LocalDate): number => (a < b ? -1 : a > b ? 1 : 0);

/** Jours d'un mois répondant à BYMONTHDAY et BYDAY (avec rangs) ; sans l'un ni l'autre : `defaultDay`. */
function monthDays(rule: RecurrenceRule, year: number, month: number, defaultDay: number): LocalDate[] {
  const last = daysInMonth(year, month);
  let days: LocalDate[];
  if (rule.byMonthDay.length > 0) {
    days = rule.byMonthDay.flatMap((day) => {
      const real = day > 0 ? day : last + day + 1;
      return real >= 1 && real <= last ? [makeLocalDate(year, month, real)] : [];
    });
    if (rule.byDay.length > 0) days = days.filter((date) => rule.byDay.some((entry) => entry.weekday === weekdayOf(date)));
  } else if (rule.byDay.length > 0) {
    days = rule.byDay.flatMap((entry) => {
      if (entry.ordinal !== null && entry.ordinal !== 0) {
        const date = nthWeekdayDate(year, month, entry.weekday, entry.ordinal);
        return date ? [date] : [];
      }
      const all: LocalDate[] = [];
      for (let day = 1; day <= last; day += 1) if (weekdayOf(makeLocalDate(year, month, day)) === entry.weekday) all.push(makeLocalDate(year, month, day));
      return all;
    });
  } else days = defaultDay <= last ? [makeLocalDate(year, month, defaultDay)] : [];
  return [...new Set(days)].sort(compareDates);
}

/** Jours d'une année répondant à BYDAY avec rang (sans BYMONTH) : n-ième jour de semaine de l'année. */
function yearWeekdays(rule: RecurrenceRule, year: number): LocalDate[] {
  return rule.byDay
    .flatMap((entry) => {
      const all: LocalDate[] = [];
      for (let month = 1; month <= 12; month += 1) for (let day = 1; day <= daysInMonth(year, month); day += 1) if (weekdayOf(makeLocalDate(year, month, day)) === entry.weekday) all.push(makeLocalDate(year, month, day));
      if (entry.ordinal === null || entry.ordinal === 0) return all;
      const picked = entry.ordinal > 0 ? all[entry.ordinal - 1] : all[all.length + entry.ordinal];
      return picked ? [picked] : [];
    })
    .sort(compareDates);
}

function applySetPositions(dates: LocalDate[], positions: readonly number[]): LocalDate[] {
  if (positions.length === 0) return dates;
  const picked = positions.flatMap((position) => {
    const date = position > 0 ? dates[position - 1] : dates[dates.length + position];
    return date ? [date] : [];
  });
  return [...new Set(picked)].sort(compareDates);
}

/** Dates candidates d'une période de la règle (un jour, une semaine, un mois ou une année), triées. */
function periodDates(rule: RecurrenceRule, start: LocalDate, index: number): LocalDate[] {
  const { year, month, day } = parseLocalDate(start);
  const monthAllowed = (date: LocalDate): boolean => rule.byMonth.length === 0 || rule.byMonth.includes(parseLocalDate(date).month);
  switch (rule.frequency) {
    case 'DAILY': {
      const date = addDays(start, index * rule.interval);
      const matchesDay = rule.byDay.length === 0 || rule.byDay.some((entry) => entry.weekday === weekdayOf(date));
      const matchesMonthDay = rule.byMonthDay.length === 0 || rule.byMonthDay.some((value) => (value > 0 ? value : daysInMonth(parseLocalDate(date).year, parseLocalDate(date).month) + value + 1) === parseLocalDate(date).day);
      return monthAllowed(date) && matchesDay && matchesMonthDay ? [date] : [];
    }
    case 'WEEKLY': {
      const offsetToWeekStart = (weekdayOf(start) - rule.weekStart + 7) % 7;
      const weekFirst = addDays(start, -offsetToWeekStart + index * rule.interval * 7);
      const weekdays = rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [weekdayOf(start)];
      const dates = weekdays.map((weekday) => addDays(weekFirst, (weekday - rule.weekStart + 7) % 7)).filter(monthAllowed);
      return applySetPositions([...new Set(dates)].sort(compareDates), rule.bySetPos);
    }
    case 'MONTHLY': {
      const total = year * 12 + (month - 1) + index * rule.interval;
      const dates = monthDays(rule, Math.floor(total / 12), (total % 12) + 1, day).filter(monthAllowed);
      return applySetPositions(dates, rule.bySetPos);
    }
    case 'YEARLY': {
      const target = year + index * rule.interval;
      if (rule.byDay.length > 0 && rule.byMonth.length === 0 && rule.byMonthDay.length === 0) return applySetPositions(yearWeekdays(rule, target), rule.bySetPos);
      const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [month];
      const dates = months.flatMap((m) => monthDays(rule, target, m, day));
      return applySetPositions(dates, rule.bySetPos);
    }
  }
}

/** Plafond d'itérations d'une règle : une série valide n'en approche jamais, une règle pathologique ne boucle pas. */
const MAX_PERIODS = 20_000;

export interface OccurrenceOptions {
  /** Premier événement (DTSTART), toujours le premier de la série. */
  readonly start: LocalDate;
  /** Dernier jour utile : l'itération s'arrête dès que les dates le dépassent. */
  readonly last: LocalDate;
  /**
   * Premier jour utile (début de plage, marge comprise) : sans COUNT, l'itération saute les périodes qui le précèdent au lieu de les
   * parcourir depuis DTSTART (une série vieille de 50 ans reste lue sur la plage). Avec COUNT, la série est comptée depuis DTSTART.
   */
  readonly first?: LocalDate;
  /** `UNTIL` : vrai si la date (avant heure) est au-delà de la fin de la série ; fourni par l'appelant (heure et fuseau). */
  readonly pastUntil: (date: LocalDate) => boolean;
}

/**
 * Dates des occurrences de la série, de DTSTART à `last` (COUNT compté depuis DTSTART). Les dates avant DTSTART et après UNTIL sont
 * exclues ; l'ordre est croissant.
 */
export function occurrenceDates(rule: RecurrenceRule, options: OccurrenceOptions): LocalDate[] {
  const result: LocalDate[] = [];
  // RFC 5545 : DTSTART est toujours la première occurrence, même s'il ne correspond pas à la règle ; elle compte dans COUNT.
  if (options.pastUntil(options.start)) return result;
  let produced = 1;
  if (compareDates(options.start, options.last) <= 0) result.push(options.start);
  if (rule.count !== null && produced >= rule.count) return result;
  const firstIndex = rule.count === null && options.first !== undefined ? Math.max(0, skippablePeriods(rule, options.start, options.first)) : 0;
  for (let index = firstIndex; index < firstIndex + MAX_PERIODS; index += 1) {
    const dates = periodDates(rule, options.start, index);
    for (const date of dates) {
      if (compareDates(date, options.start) <= 0) continue;
      if (options.pastUntil(date)) return result;
      produced += 1;
      if (compareDates(date, options.last) <= 0) result.push(date);
      if (rule.count !== null && produced >= rule.count) return result;
    }
    const first = dates[0];
    // Les périodes sont croissantes : dès qu'une période commence après la plage, plus rien d'utile ne vient.
    const periodStart = first ?? periodAnchor(rule, options.start, index);
    if (compareDates(periodStart, options.last) > 0) return result;
  }
  return result;
}

/** Nombre de périodes entières de la règle à sauter pour atteindre `first` (moins une, par prudence). */
function skippablePeriods(rule: RecurrenceRule, start: LocalDate, first: LocalDate): number {
  if (compareDates(first, start) <= 0) return 0;
  const a = parseLocalDate(start);
  const b = parseLocalDate(first);
  const days = Math.floor((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
  switch (rule.frequency) {
    case 'DAILY':
      return Math.floor(days / rule.interval) - 1;
    case 'WEEKLY':
      return Math.floor(days / (7 * rule.interval)) - 1;
    case 'MONTHLY':
      return Math.floor(((b.year - a.year) * 12 + (b.month - a.month)) / rule.interval) - 1;
    case 'YEARLY':
      return Math.floor((b.year - a.year) / rule.interval) - 1;
  }
}

/** Début approximatif d'une période sans candidat (jour, semaine, mois, année) : sert seulement à arrêter l'itération. */
function periodAnchor(rule: RecurrenceRule, start: LocalDate, index: number): LocalDate {
  const { year, month, day } = parseLocalDate(start);
  switch (rule.frequency) {
    case 'DAILY':
      return addDays(start, index * rule.interval);
    case 'WEEKLY':
      return addDays(start, index * rule.interval * 7);
    case 'MONTHLY': {
      const total = year * 12 + (month - 1) + index * rule.interval;
      return makeLocalDate(Math.floor(total / 12), (total % 12) + 1, Math.min(day, 28));
    }
    case 'YEARLY':
      return makeLocalDate(year + index * rule.interval, 1, 1);
  }
}
