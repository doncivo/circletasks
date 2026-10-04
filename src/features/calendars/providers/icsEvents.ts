import type { ProviderEvent } from '../../../domain/calendarProvider';
import { toStoredInstant } from '../../../domain/calendarProvider';
import { addDays } from '../../../domain/localDate';
import type { LocalDate } from '../../../domain/types';
import { parseIcs, parseDuration, parseIcsTime, propOf, propsOf, resolveIcsTime, timeContextOf, unescapeText, type IcsComponent, type IcsTime, type TimeContext } from './ics';
import { occurrenceDates, parseRecurrenceRule } from './recurrence';

/**
 * Événements d'un objet iCalendar (une réponse `calendar-data`) en instances UTC, sur une plage (K-02 critère 5) :
 * - heure avec TZID → UTC ; heure flottante → fuseau de l'appareil ; journée entière → dates civiles, fin EXCLUE ;
 * - annulés (`STATUS:CANCELLED`) exclus, séries comprises ; sans titre : titre vide (le texte « (Sans titre) » est un texte d'affichage) ;
 * - séries (RRULE, RDATE, EXDATE, exceptions RECURRENCE-ID) développées sur la plage ; un serveur qui les a déjà développées
 *   (`expand`) renvoie des instances avec RECURRENCE-ID, reprises telles quelles : même identifiant dans les deux cas.
 * Identifiant d'une instance : `UID#clé` (clé = début de l'instance : `AAAAMMJJ` ou `AAAAMMJJTHHMMSSZ`) ; d'un événement simple : l'UID.
 */

export interface IcsRange {
  readonly fromMs: number;
  readonly toMs: number;
}

interface RawEvent {
  readonly uid: string;
  readonly recurrenceKey: string | null;
  readonly title: string;
  readonly cancelled: boolean;
  readonly start: IcsTime;
  readonly end: IcsTime | null;
  readonly durationMs: number | null;
  readonly rrule: string | null;
  readonly exdates: ReadonlySet<string>;
  readonly rdates: readonly IcsTime[];
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Clé d'instance d'un moment : `AAAAMMJJ` (journée entière) ou `AAAAMMJJTHHMMSSZ` (instant UTC). */
function instanceKey(time: IcsTime, context: TimeContext): string {
  if (time.kind === 'date') return time.date.replace(/-/g, '');
  const date = new Date(resolveIcsTime(time, context));
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function timesOf(property: { readonly name: string; readonly params: Readonly<Record<string, string>>; readonly value: string }): IcsTime[] {
  return property.value
    .split(',')
    .map((value) => parseIcsTime({ ...property, value }))
    .filter((time): time is IcsTime => time !== null);
}

function toRaw(vevent: IcsComponent, context: TimeContext): RawEvent | null {
  const uid = propOf(vevent, 'UID')?.value.trim();
  const startProp = propOf(vevent, 'DTSTART');
  const start = startProp ? parseIcsTime(startProp) : null;
  if (!uid || !start) return null;
  const endProp = propOf(vevent, 'DTEND');
  const end = endProp ? parseIcsTime(endProp) : null;
  const recurrenceProp = propOf(vevent, 'RECURRENCE-ID');
  const recurrence = recurrenceProp ? parseIcsTime(recurrenceProp) : null;
  const duration = propOf(vevent, 'DURATION');
  return {
    uid,
    recurrenceKey: recurrence ? instanceKey(recurrence, context) : null,
    title: unescapeText(propOf(vevent, 'SUMMARY')?.value ?? '').trim(),
    cancelled: propOf(vevent, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
    start,
    end,
    durationMs: duration ? parseDuration(duration.value) : null,
    rrule: propOf(vevent, 'RRULE')?.value ?? null,
    exdates: new Set(propsOf(vevent, 'EXDATE').flatMap(timesOf).map((time) => instanceKey(time, context))),
    rdates: propsOf(vevent, 'RDATE').flatMap(timesOf),
  };
}

interface Instance {
  readonly startMs: number;
  readonly endMs: number | null;
  readonly allDay: boolean;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate | null;
}

/** Début et fin d'une instance commençant à `start` pour un événement de même durée que `raw`. */
function instanceOf(raw: RawEvent, start: IcsTime, context: TimeContext): Instance {
  if (raw.start.kind === 'date' && start.kind === 'date') {
    const days = raw.end?.kind === 'date' ? Math.max(1, Math.round((resolveIcsTime(raw.end, context) - resolveIcsTime(raw.start, context)) / 86_400_000)) : raw.durationMs !== null ? Math.max(1, Math.round(raw.durationMs / 86_400_000)) : 1;
    const endDate = addDays(start.date, days);
    return { startMs: resolveIcsTime(start, context), endMs: resolveIcsTime({ kind: 'date', date: endDate }, context), allDay: true, startDate: start.date, endDate };
  }
  const startMs = resolveIcsTime(start, context);
  const masterStartMs = resolveIcsTime(raw.start, context);
  const length = raw.end ? resolveIcsTime(raw.end, context) - masterStartMs : raw.durationMs;
  return { startMs, endMs: length === null || length < 0 ? null : startMs + length, allDay: false, startDate: start.date, endDate: null };
}

function overlaps(instance: Instance, range: IcsRange): boolean {
  const end = instance.endMs ?? instance.startMs;
  return instance.startMs < range.toMs && (instance.endMs === null ? instance.startMs >= range.fromMs : end > range.fromMs);
}

function toProviderEvent(calendarId: string, externalId: string, raw: RawEvent, instance: Instance): ProviderEvent {
  return {
    calendarId,
    externalId,
    title: raw.title,
    startUtc: instance.allDay ? instance.startDate : toStoredInstant(instance.startMs),
    endUtc: instance.allDay ? instance.endDate : instance.endMs === null ? null : toStoredInstant(instance.endMs),
    allDay: instance.allDay,
  };
}

/** Débuts des occurrences d'une série sur la plage, au format du début de la série (même fuseau, même heure), RDATE compris. */
function seriesStarts(master: RawEvent, range: IcsRange, context: TimeContext): IcsTime[] {
  const rule = master.rrule ? parseRecurrenceRule(master.rrule) : null;
  let starts: IcsTime[] = [master.start];
  if (rule) {
    const lastDate = new Date(range.toMs + 86_400_000).toISOString().slice(0, 10) as LocalDate;
    const until = rule.until === null ? null : parseIcsTime({ name: 'UNTIL', params: {}, value: rule.until });
    // UNTIL en DATE : le jour lui-même fait partie de la série ; en DATE-TIME : l'instant inclus.
    const untilMs = until ? resolveIcsTime(until.kind === 'date' ? { kind: 'date', date: addDays(until.date, 1) } : until, context) + (until.kind === 'date' ? 0 : 1) : null;
    const withDate = (date: LocalDate): IcsTime => (master.start.kind === 'date' ? { kind: 'date', date } : { ...master.start, date });
    starts = occurrenceDates(rule, {
      start: master.start.date,
      last: lastDate,
      pastUntil: (date) => untilMs !== null && resolveIcsTime(withDate(date), context) >= untilMs,
    }).map(withDate);
  }
  return [...starts, ...master.rdates];
}

/**
 * Événements d'un texte iCalendar qui recoupent `range`. Un texte illisible ou sans événement donne une liste vide.
 * `deviceTimeZone` : fuseau des heures flottantes.
 */
export function eventsFromIcs(calendarId: string, text: string, range: IcsRange, deviceTimeZone: string): ProviderEvent[] {
  const root = parseIcs(text);
  if (!root) return [];
  const context = timeContextOf(root, deviceTimeZone);
  const raws = root.children.filter((child) => child.name === 'VEVENT').flatMap((vevent) => {
    const raw = toRaw(vevent, context);
    return raw ? [raw] : [];
  });
  const byUid = new Map<string, RawEvent[]>();
  for (const raw of raws) byUid.set(raw.uid, [...(byUid.get(raw.uid) ?? []), raw]);

  const events: ProviderEvent[] = [];
  for (const [uid, group] of byUid) {
    const master = group.find((raw) => raw.recurrenceKey === null);
    const overrides = new Map(group.filter((raw) => raw.recurrenceKey !== null).map((raw) => [raw.recurrenceKey as string, raw]));
    const recurring = master !== undefined && (master.rrule !== null || master.rdates.length > 0);

    if (master && !recurring) {
      if (!master.cancelled) {
        const instance = instanceOf(master, master.start, context);
        if (overlaps(instance, range)) events.push(toProviderEvent(calendarId, uid, master, instance));
      }
      continue;
    }
    const emitted = new Set<string>();
    if (master && recurring && !master.cancelled) {
      for (const start of seriesStarts(master, range, context)) {
        const key = instanceKey(start, context);
        if (master.exdates.has(key) || emitted.has(key)) continue;
        emitted.add(key);
        const override = overrides.get(key);
        if (override) continue; // émise plus bas, avec ses propres horaires (ou supprimée si annulée)
        const instance = instanceOf(master, start, context);
        if (overlaps(instance, range)) events.push(toProviderEvent(calendarId, `${uid}#${key}`, master, instance));
      }
    }
    // Instances déjà développées par le serveur, ou exceptions d'une série : leurs propres horaires.
    for (const [key, override] of overrides) {
      if (override.cancelled || (master?.cancelled ?? false) || master?.exdates.has(key) === true) continue;
      const instance = instanceOf(override, override.start, context);
      if (overlaps(instance, range)) events.push(toProviderEvent(calendarId, `${uid}#${key}`, override, instance));
    }
  }
  return events;
}
