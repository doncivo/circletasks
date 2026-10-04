import { nthWeekdayDate } from '../../../domain/externalRecurrence';
import { addDays, daysInMonth, makeLocalDate, parseLocalDate } from '../../../domain/localDate';
import { isValidTimeZone, localToUtcMs } from '../../../domain/timeZone';
import type { LocalDate } from '../../../domain/types';

/**
 * Analyse iCalendar (RFC 5545) des événements d'un agenda CalDAV (K-02) : lignes dépliées, composants et propriétés, dates (UTC,
 * avec TZID, flottantes, journées entières), fuseaux (IANA, noms Windows courants, VTIMEZONE), durées. Aucune dépendance : le même code
 * tourne en Vitest, dans la WebView de Windows et dans celle de l'iPhone.
 */

export interface IcsProperty {
  /** Nom en majuscules. */
  readonly name: string;
  /** Paramètres : noms en majuscules, guillemets retirés. */
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

export interface IcsComponent {
  /** Nom en majuscules (VCALENDAR, VEVENT, VTIMEZONE…). */
  readonly name: string;
  readonly props: IcsProperty[];
  readonly children: IcsComponent[];
}

/** Coupe `text` sur `separator` hors guillemets. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function parseProperty(line: string): IcsProperty | null {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const equals = raw.indexOf('=');
    if (equals > 0) params[raw.slice(0, equals).toUpperCase()] = raw.slice(equals + 1).replace(/^"|"$/g, '');
  }
  return { name: (rawName ?? '').toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Racine (VCALENDAR) d'un texte iCalendar ; null s'il n'y en a pas ou si les composants ne s'emboîtent pas. */
export function parseIcs(text: string): IcsComponent | null {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const stack: IcsComponent[] = [];
  let root: IcsComponent | null = null;
  for (const line of lines) {
    if (line === '') continue;
    const property = parseProperty(line);
    if (!property) continue;
    if (property.name === 'BEGIN') {
      const component: IcsComponent = { name: property.value.toUpperCase(), props: [], children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(component);
      else if (root === null) root = component;
      stack.push(component);
    } else if (property.name === 'END') {
      const top = stack.pop();
      if (!top || top.name !== property.value.toUpperCase()) return null;
    } else {
      stack[stack.length - 1]?.props.push(property);
    }
  }
  return stack.length === 0 && root?.name === 'VCALENDAR' ? root : null;
}

export const propOf = (component: IcsComponent, name: string): IcsProperty | undefined => component.props.find((property) => property.name === name);
export const propsOf = (component: IcsComponent, name: string): IcsProperty[] => component.props.filter((property) => property.name === name);

/** Texte iCalendar : `\n`, `\,`, `\;`, `\\`. */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
}

/** Instant ou date d'une propriété de date, avant résolution du fuseau. */
export type IcsTime =
  | { readonly kind: 'date'; readonly date: LocalDate }
  | { readonly kind: 'utc'; readonly date: LocalDate; readonly time: string }
  | { readonly kind: 'zoned'; readonly date: LocalDate; readonly time: string; readonly tzid: string }
  | { readonly kind: 'floating'; readonly date: LocalDate; readonly time: string };

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** Lit une valeur DATE ou DATE-TIME ; null si elle est illisible (ou si la date n'existe pas). */
export function parseIcsTime(property: IcsProperty): IcsTime | null {
  const value = property.value.trim();
  const dateMatch = DATE_ONLY.exec(value);
  const timeMatch = DATE_TIME.exec(value);
  const parts = dateMatch ?? timeMatch;
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const date = makeLocalDate(year, month, day);
  if (dateMatch) return { kind: 'date', date };
  const hour = Number(timeMatch?.[4]);
  const minute = Number(timeMatch?.[5]);
  const second = Number(timeMatch?.[6]);
  if (hour > 23 || minute > 59 || second > 60) return null;
  const time = `${timeMatch?.[4] ?? '00'}:${timeMatch?.[5] ?? '00'}:${timeMatch?.[6] === '60' ? '59' : (timeMatch?.[6] ?? '00')}`;
  if (timeMatch?.[7] === 'Z') return { kind: 'utc', date, time };
  const tzid = property.params['TZID'];
  return tzid ? { kind: 'zoned', date, time, tzid } : { kind: 'floating', date, time };
}

/** Durée iCalendar (`P1W`, `P1DT2H30M`, `-PT15M`) en millisecondes ; null si illisible. */
export function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match || match.slice(2).every((part) => part === undefined)) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total = (Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 86_400_000 + Number(hours ?? 0) * 3_600_000 + Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1000;
  return sign === '-' ? -total : total;
}

/** Noms de fuseaux Windows courants (certains clients les écrivent dans TZID) → IANA. */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC',
};

interface Observance {
  readonly offsetToMs: number;
  /** Heure murale (ms « naïfs ») du début de l'observance, année `year`. */
  onset(year: number): number[];
}

function parseOffset(value: string): number {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000 + Number(match[4] ?? 0) * 1000);
}

const naive = (date: LocalDate, time: string): number => {
  const { year, month, day } = parseLocalDate(date);
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
};

const BYDAY_CODES: Readonly<Record<string, number>> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function observanceFrom(component: IcsComponent): Observance | null {
  const start = propOf(component, 'DTSTART');
  const to = propOf(component, 'TZOFFSETTO');
  const dtstart = start ? parseIcsTime(start) : null;
  if (!dtstart || dtstart.kind === 'date' || !to) return null;
  const startNaive = naive(dtstart.date, dtstart.time);
  const rule = propOf(component, 'RRULE')?.value;
  const parts = new Map((rule ?? '').split(';').map((part) => part.split('=') as [string, string]));
  const month = Number(parts.get('BYMONTH'));
  const byDay = /^(-?\d)?([A-Z]{2})$/.exec(parts.get('BYDAY') ?? '');
  return {
    offsetToMs: parseOffset(to.value),
    onset(year) {
      if (!rule || !month || !byDay) return year >= parseLocalDate(dtstart.date).year ? [startNaive] : [];
      if (year < parseLocalDate(dtstart.date).year) return [];
      const day = nthWeekdayDate(year, month, BYDAY_CODES[byDay[2] ?? ''] ?? 1, Number(byDay[1] ?? 1));
      return day ? [naive(day, dtstart.time)] : [];
    },
  };
}

/** Décalage (ms) en vigueur à l'heure murale `wall` d'un VTIMEZONE : l'observance dont le début est le dernier avant `wall`. */
function vtimezoneOffset(timezone: IcsComponent, wall: number): number | null {
  const year = new Date(wall).getUTCFullYear();
  let best: { onset: number; offset: number } | null = null;
  for (const child of timezone.children) {
    if (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT') continue;
    const observance = observanceFrom(child);
    if (!observance) continue;
    for (const onset of [year - 1, year].flatMap((candidate) => observance.onset(candidate))) {
      if (onset <= wall && (best === null || onset > best.onset)) best = { onset, offset: observance.offsetToMs };
    }
  }
  return best?.offset ?? null;
}

export interface TimeContext {
  /** Fuseau de l'appareil : heures flottantes (K-02 critère 5). */
  readonly deviceTimeZone: string;
  /** VTIMEZONE du fichier, par TZID. */
  readonly vtimezones: ReadonlyMap<string, IcsComponent>;
}

export function timeContextOf(root: IcsComponent, deviceTimeZone: string): TimeContext {
  const vtimezones = new Map<string, IcsComponent>();
  for (const child of root.children) {
    const tzid = child.name === 'VTIMEZONE' ? propOf(child, 'TZID')?.value : undefined;
    if (tzid) vtimezones.set(tzid, child);
  }
  return { deviceTimeZone, vtimezones };
}

/**
 * Instant UTC (ms) d'un moment daté. Journée entière : minuit UTC de la date (convention de stockage). Fuseau d'une propriété :
 * IANA, nom Windows courant, VTIMEZONE du fichier, puis, en dernier recours, fuseau de l'appareil.
 */
export function resolveIcsTime(time: IcsTime, context: TimeContext): number {
  switch (time.kind) {
    case 'date':
      return naive(time.date, '00:00:00');
    case 'utc':
      return naive(time.date, time.time);
    case 'floating':
      return localToUtcMs(time.date, time.time, isValidTimeZone(context.deviceTimeZone) ? context.deviceTimeZone : 'UTC');
    case 'zoned': {
      const mapped = WINDOWS_ZONES[time.tzid] ?? time.tzid;
      if (isValidTimeZone(mapped)) return localToUtcMs(time.date, time.time, mapped);
      const vtimezone = context.vtimezones.get(time.tzid);
      const wall = naive(time.date, time.time);
      const offset = vtimezone ? vtimezoneOffset(vtimezone, wall) : null;
      if (offset !== null) return wall - offset;
      return localToUtcMs(time.date, time.time, isValidTimeZone(context.deviceTimeZone) ? context.deviceTimeZone : 'UTC');
    }
  }
}

/** Jour suivant d'une date, pour les fins exclues des journées entières. */
export const nextDay = (date: LocalDate): LocalDate => addDays(date, 1);
