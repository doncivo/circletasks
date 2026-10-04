import { calendarOf, externalEventSpan, externalEventVisible } from './externalEvents';
import { compareByStart } from './eventRules';
import { occurrencesOfEvents } from './eventOccurrences';
import type { HolidayEntry } from './holidays';
import { addDays, makeLocalDate, parseLocalDate } from './localDate';
import type { CalendarAccount, CalendarEvent, ExternalEvent, IconRef } from './model';
import type { TodayEventEntry } from './todayList';
import type { LocalDate, LocalTime, SpaceFilter, SpaceId } from './types';

/**
 * Liste de l'onglet Événements (E-01 critère 1, D4) : toutes les occurrences de l'année affichée, événements locaux et événements
 * d'agendas externes (lecture seule, K-03), triées par jour. Les jours fériés (E-03) s'y ajoutent par `buildEventList`. Fonctions
 * pures : « aujourd'hui », le fuseau et les données sont fournis par l'appelant.
 */
export type EventEntrySource = 'local' | 'external' | 'holiday';

export interface EventListEntry {
  /** Clé stable de la ligne (une série mensuelle donne une ligne par mois). */
  readonly key: string;
  readonly source: EventEntrySource;
  /** Premier jour de l'occurrence. */
  readonly date: LocalDate;
  readonly endDate: LocalDate;
  readonly title: string;
  readonly allDay: boolean;
  readonly startTime: LocalTime | null;
  readonly endTime: LocalTime | null;
  /** Espace de l'élément ; null pour un événement externe non rattaché ou un jour férié. */
  readonly spaceId: SpaceId | null;
  readonly icon: IconRef | null;
  /** Événement local d'origine (ouverture de la fiche, âge, compte à rebours). */
  readonly event: CalendarEvent | null;
  /** Source d'un événement externe (« Google Agenda »). */
  readonly calendarName: string | null;
  /** Jour férié (E-03) : pays, date estimée ou saisie à la main, modifiable ou non ; null pour les autres lignes. */
  readonly holiday: HolidayEntry | null;
}

export interface MonthGroup {
  /** 1 à 12. */
  readonly month: number;
  readonly entries: readonly EventListEntry[];
}

export interface BuildEventListInput {
  readonly year: number;
  readonly events: readonly CalendarEvent[];
  readonly externalEvents: readonly ExternalEvent[];
  readonly accounts: readonly CalendarAccount[];
  readonly timeZone: string;
  readonly filter: SpaceFilter;
  /** Entrées de jours fériés (E-03), déjà filtrées par pays activé. */
  readonly holidays?: readonly EventListEntry[];
}

const yearBounds = (year: number): { from: LocalDate; to: LocalDate } => ({ from: makeLocalDate(year, 1, 1), to: makeLocalDate(year, 12, 31) });

function sortKey(entry: EventListEntry): Parameters<typeof compareByStart>[0] {
  return { date: entry.date, allDay: entry.allDay, startTime: entry.startTime, title: entry.title, id: entry.key };
}

/** Entrées des événements locaux de l'année : une ligne par occurrence qui commence dans l'année. */
export function localEntries(events: readonly CalendarEvent[], year: number): EventListEntry[] {
  const { from, to } = yearBounds(year);
  return occurrencesOfEvents(events, from, to)
    .filter((occurrence) => occurrence.date >= from)
    .map(
      (occurrence): EventListEntry => ({
        key: `local:${occurrence.event.id}:${occurrence.date}`,
        source: 'local',
        date: occurrence.date,
        endDate: occurrence.endDate,
        title: occurrence.event.title,
        allDay: occurrence.event.allDay,
        startTime: occurrence.event.startTime,
        endTime: occurrence.event.endTime,
        spaceId: occurrence.event.spaceId,
        icon: occurrence.event.icon,
        event: occurrence.event,
        calendarName: null,
        holiday: null,
      }),
    );
}

/** Entrées des événements externes visibles sous le filtre, une ligne au premier jour de chaque événement (S-05 : fuseau de l'appareil). */
export function externalEntries(input: Pick<BuildEventListInput, 'year' | 'externalEvents' | 'accounts' | 'timeZone' | 'filter'>): EventListEntry[] {
  const { from, to } = yearBounds(input.year);
  const entries: EventListEntry[] = [];
  for (const event of input.externalEvents) {
    const owner = calendarOf(event, input.accounts);
    if (!owner || !externalEventVisible(owner.calendar, input.filter)) continue;
    const span = externalEventSpan(event, input.timeZone);
    if (!span || span.firstDay < from || span.firstDay > to) continue;
    entries.push({
      key: `external:${event.id}`,
      source: 'external',
      date: span.firstDay,
      endDate: span.lastDay,
      title: event.title,
      allDay: span.allDay,
      startTime: span.startTime,
      endTime: span.endTime,
      spaceId: owner.calendar?.spaceId ?? null,
      icon: null,
      event: null,
      calendarName: owner.account.label,
      holiday: null,
    });
  }
  return entries;
}

/**
 * Entrées des jours fériés de l'année (E-03) : lecture seule, sans espace propre (visibles sous Pro, Perso et Tout, D3). `nameOf`
 * donne le nom affiché d'une fête (texte de src/i18n, jamais dans le domaine).
 */
export function holidayEntries(holidays: readonly HolidayEntry[], year: number, nameOf: (key: string) => string): EventListEntry[] {
  return holidays
    .filter((holiday) => parseLocalDate(holiday.date).year === year)
    .map(
      (holiday): EventListEntry => ({
        key: `holiday:${holiday.country}:${holiday.key}:${holiday.date}`,
        source: 'holiday',
        date: holiday.date,
        endDate: holiday.date,
        title: nameOf(holiday.key),
        allDay: true,
        startTime: null,
        endTime: null,
        spaceId: null,
        icon: null,
        event: null,
        calendarName: null,
        holiday,
      }),
    );
}

/** Liste complète de l'année, triée : jour, journée entière d'abord, heure de début. */
export function buildEventList(input: BuildEventListInput): EventListEntry[] {
  return [...localEntries(input.events, input.year), ...externalEntries(input), ...(input.holidays ?? [])].sort((a, b) => compareByStart(sortKey(a), sortKey(b)));
}

/** Regroupe par mois (1 à 12), seulement les mois qui ont des lignes. */
export function groupByMonth(entries: readonly EventListEntry[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const entry of entries) {
    const month = parseLocalDate(entry.date).month;
    const last = groups[groups.length - 1];
    if (last && last.month === month) groups[groups.length - 1] = { month, entries: [...last.entries, entry] };
    else groups.push({ month, entries: [entry] });
  }
  return groups;
}

/** Première ligne à montrer à l'ouverture : celle d'aujourd'hui ou la prochaine ; null s'il n'y en a pas (« ouverture positionnée sur aujourd'hui »). */
export function firstUpcomingEntry(entries: readonly EventListEntry[], today: LocalDate): EventListEntry | null {
  return entries.find((entry) => entry.endDate >= today) ?? null;
}

/** Un événement est passé (grisé) quand tous ses jours sont avant aujourd'hui. */
export function isPastEntry(entry: Pick<EventListEntry, 'endDate'>, today: LocalDate): boolean {
  return entry.endDate < today;
}

export interface DayDot {
  /** Espace du point ; null : point neutre (agenda externe sans espace, jour férié). */
  readonly spaceId: SpaceId | null;
  readonly source: EventEntrySource;
}

/**
 * Points de la grille d'un mois (E-01 critère 8, D6) : un point par espace et par jour concerné (au plus un par espace, un point pour
 * les jours fériés), dans l'ordre des espaces donnés puis neutres. Les événements de plusieurs jours marquent chaque jour couvert.
 */
export function dayDots(entries: readonly EventListEntry[], year: number, month: number, spaceOrder: readonly SpaceId[]): Map<LocalDate, DayDot[]> {
  const first = makeLocalDate(year, month, 1);
  const last = addDays(makeLocalDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1), -1);
  const seen = new Map<LocalDate, Map<string, DayDot>>();
  for (const entry of entries) {
    if (entry.endDate < first || entry.date > last) continue;
    const dot: DayDot = { spaceId: entry.source === 'holiday' ? null : entry.spaceId, source: entry.source === 'holiday' ? 'holiday' : entry.spaceId === null ? 'external' : 'local' };
    const key = dot.source === 'holiday' ? 'holiday' : (dot.spaceId ?? 'external');
    for (let day = entry.date < first ? first : entry.date; day <= entry.endDate && day <= last; day = addDays(day, 1)) {
      const dots = seen.get(day) ?? new Map<string, DayDot>();
      if (!dots.has(key)) dots.set(key, dot);
      seen.set(day, dots);
    }
  }
  const rank = (dot: DayDot): number => (dot.spaceId === null ? spaceOrder.length + (dot.source === 'holiday' ? 1 : 0) : Math.max(spaceOrder.indexOf(dot.spaceId), 0));
  const result = new Map<LocalDate, DayDot[]>();
  for (const [day, dots] of seen) result.set(day, [...dots.values()].sort((a, b) => rank(a) - rank(b)));
  return result;
}

/**
 * Bandeaux d'un jour pour Aujourd'hui et la Semaine (E-01 critère 11) : une entrée par occurrence d'événement local qui touche ce jour.
 * L'heure de début n'est montrée que le premier jour ; les jours suivants d'une plage sont « toute la journée » (comme S-05).
 */
export function todayEntriesForDay(events: readonly CalendarEvent[], date: LocalDate): TodayEventEntry[] {
  return occurrencesOfEvents(events, date, date).map(({ event, date: start }) => {
    const starting = start === date;
    return {
      id: event.id,
      title: event.title,
      allDay: event.allDay || !starting,
      startTime: starting && !event.allDay ? event.startTime : null,
      spaceId: event.spaceId,
      calendarName: null,
      icon: event.icon,
      kind: event.kind,
    };
  });
}

/**
 * Bandeaux des jours fériés d'un jour pour Aujourd'hui et la Semaine (E-03 D5) : lecture seule, journée entière, sans espace.
 * `tagOf` donne l'étiquette (« Férié FR ») écrite à droite du bandeau, à la place du nom d'agenda.
 */
export function holidayBands(holidays: readonly HolidayEntry[], nameOf: (key: string) => string, tagOf: (holiday: HolidayEntry) => string): TodayEventEntry[] {
  return holidays.map((holiday) => ({
    id: `holiday:${holiday.country}:${holiday.key}:${holiday.date}`,
    title: nameOf(holiday.key),
    allDay: true,
    startTime: null,
    spaceId: null,
    calendarName: tagOf(holiday),
    icon: null,
    kind: 'holiday' as const,
  }));
}
