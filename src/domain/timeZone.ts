import type { Clock } from './clock';
import type { IsoDateTime, LocalDate, LocalTime } from './types';

/**
 * Heures flottantes et fuseaux (T-11).
 *
 * Règle : tâches, routines, événements internes et `reminder.fire_at` sont des dates et
 * heures LOCALES FLOTTANTES ('YYYY-MM-DD', 'HH:mm', 'YYYY-MM-DDTHH:mm') : aucune conversion,
 * jamais ; 10:00 reste 10:00 là où se trouve l'appareil, y compris le jour du passage à
 * l'heure d'été (02:30 reste 02:30, aucune correction). Seuls les instants UTC des événements
 * externes (`external_event.start_utc`, M8) sont convertis à l'affichage, via `utcToLocal`.
 * Les dates du jour (« Aujourd'hui », minuit de T-06) se calculent dans le fuseau courant
 * de l'appareil (`todayIn`).
 */

/** Vrai si `tz` est un identifiant IANA connu de l'environnement (ex. 'Europe/Paris'). */
export function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalDateTimeParts {
  readonly date: LocalDate;
  readonly time: LocalTime;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function partsAt(ms: number, tz: string): LocalDateTimeParts {
  const values: Record<string, string> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) values[part.type] = part.value;
  const hour = values['hour'] === '24' ? '00' : (values['hour'] ?? '00');
  return {
    date: `${values['year']}-${values['month']}-${values['day']}` as LocalDate,
    time: `${hour}:${values['minute']}` as LocalTime,
  };
}

/**
 * Convertit un instant UTC (ISO 8601) en date et heure locales du fuseau IANA `tz`.
 * Lève `RangeError` si l'instant ou le fuseau est invalide (l'appelant affiche alors l'événement sans heure).
 */
export function utcToLocal(isoUtc: string, tz: string): LocalDateTimeParts {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) throw new RangeError(`Instant invalide : « ${isoUtc} »`);
  if (!isValidTimeZone(tz)) throw new RangeError(`Fuseau invalide : « ${tz} »`);
  return partsAt(ms, tz);
}

/** Date civile du jour dans le fuseau `tz` pour l'horloge donnée. */
export function todayIn(clock: Clock, tz: string): LocalDate {
  if (!isValidTimeZone(tz)) throw new RangeError(`Fuseau invalide : « ${tz} »`);
  return partsAt(clock.nowMs(), tz).date;
}

/** Heure locale 'HH:mm' (24 h) de l'instant courant dans le fuseau `tz`. */
export function nowTimeIn(clock: Clock, tz: string): LocalTime {
  if (!isValidTimeZone(tz)) throw new RangeError(`Fuseau invalide : « ${tz} »`);
  return partsAt(clock.nowMs(), tz).time;
}

/**
 * Événement externe en lecture seule (M8) : instants UTC, ou journée entière.
 * Pour une journée entière, la date civile est celle du début (partie date de `startUtc`)
 * et ne dépend d'aucun fuseau.
 */
export interface ExternalEventTimes {
  readonly allDay: boolean;
  readonly startUtc: string;
  readonly endUtc: string | null;
}

export interface ExternalEventDisplay {
  readonly startDate: LocalDate;
  readonly startTime: LocalTime | null;
  readonly endDate: LocalDate | null;
  readonly endTime: LocalTime | null;
  readonly allDay: boolean;
}

/**
 * Affichage d'un événement externe dans le fuseau `tz` : conversion depuis UTC,
 * sauf « journée entière » qui reste sur sa date (jamais décalée au jour précédent).
 * `endDate` d'une journée entière : date civile de fin telle quelle.
 */
export function externalEventDisplay(event: ExternalEventTimes, tz: string): ExternalEventDisplay {
  if (event.allDay) {
    return {
      startDate: dateOnly(event.startUtc),
      startTime: null,
      endDate: event.endUtc === null ? null : dateOnly(event.endUtc),
      endTime: null,
      allDay: true,
    };
  }
  const start = utcToLocal(event.startUtc, tz);
  const end = event.endUtc === null ? null : utcToLocal(event.endUtc, tz);
  return { startDate: start.date, startTime: start.time, endDate: end?.date ?? null, endTime: end?.time ?? null, allDay: false };
}

function dateOnly(iso: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new RangeError(`Date invalide : « ${iso} »`);
  return `${match[1]}-${match[2]}-${match[3]}` as LocalDate;
}

export interface TimeZoneChange {
  readonly previous: string | null;
  readonly current: string;
}

/**
 * Compare le dernier fuseau enregistré au fuseau détecté. Renvoie le changement à appliquer,
 * ou null si rien ne change. Premier lancement (previous null) : enregistrement initial,
 * sans réaction à propager (`previous` reste null).
 */
export function detectTimeZoneChange(previous: string | null, current: string | null): TimeZoneChange | null {
  if (current === null || current === previous) return null;
  return { previous, current };
}

/** Pour les tests et l'affichage : 'YYYY-MM-DDTHH:mm' flottant d'un instant UTC dans `tz`. */
export function utcToLocalIso(isoUtc: IsoDateTime | string, tz: string): string {
  const { date, time } = utcToLocal(isoUtc, tz);
  return `${date}T${time}`;
}


/** Décalage (ms) du fuseau `tz` à l'instant `ms` : heure murale moins UTC. Sans secondes : les décalages sont des minutes entières. */
function offsetMsAt(ms: number, tz: string): number {
  const { date, time } = partsAt(ms, tz);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return Date.UTC(year, month - 1, day, hour, minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * Instant UTC (ms) d'une heure murale `date` `time` ('HH:mm' ou 'HH:mm:ss') du fuseau IANA `tz` (analyse d'événements externes
 * avec TZID, bornes de fenêtre). Lève `RangeError` si le fuseau est invalide. Heure inexistante (saut de l'heure d'été) : décalée
 * d'une heure vers l'avant ; heure répétée (retour d'hiver) : l'une des deux occurrences.
 */
export function localToUtcMs(date: LocalDate, time: string, tz: string): number {
  if (!isValidTimeZone(tz)) throw new RangeError(`Fuseau invalide : « ${tz} »`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = wall - offsetMsAt(wall, tz);
  return wall - offsetMsAt(guess, tz);
}
