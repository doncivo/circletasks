import { addDays } from './localDate';
import type { CalendarAccount, CalendarRef, ExternalEvent } from './model';
import { externalEventDisplay, type ExternalEventDisplay } from './timeZone';
import type { TodayEventEntry } from './todayList';
import { isLocalDate, type ExternalEventId, type LocalDate, type LocalTime, type SpaceFilter } from './types';

/**
 * Événements des agendas externes dans la Semaine (S-05, M8) : lecture seule. Cette fonction ne connaît ni la base ni les
 * connecteurs : elle reçoit les lignes d'`external_event` (UTC) et les comptes, convertit dans le fuseau de l'appareil
 * (`externalEventDisplay`, T-11 : une journée entière reste sur sa date), répartit par jour local et applique le filtre d'espace.
 * Elle est rappelée quand le fuseau change : l'affichage se recale sans relire la base.
 */

/** Jours couverts et heures locales d'un événement externe, pour l'affichage (grille et fiche). */
export interface ExternalEventSpan {
  readonly firstDay: LocalDate;
  /** Dernier jour couvert (inclus). */
  readonly lastDay: LocalDate;
  readonly allDay: boolean;
  readonly startTime: LocalTime | null;
  readonly endTime: LocalTime | null;
}

const datePart = (instant: string): LocalDate | null => {
  const day = instant.slice(0, 10);
  return isLocalDate(day) ? day : null;
};

/**
 * Affichage d'un événement dans le fuseau `timeZone`. Un instant ou un fuseau illisible n'empêche pas l'affichage : l'événement
 * est rangé sans heure sur la date de son instant de début (T-11) ; renvoie null seulement si cet instant n'a aucune date.
 */
export function externalEventSpan(event: Pick<ExternalEvent, 'allDay' | 'startUtc' | 'endUtc'>, timeZone: string): ExternalEventSpan | null {
  let display: ExternalEventDisplay;
  try {
    display = externalEventDisplay(event, timeZone);
  } catch {
    const day = datePart(event.startUtc);
    return day === null ? null : { firstDay: day, lastDay: day, allDay: true, startTime: null, endTime: null };
  }
  const { startDate, startTime, endDate, endTime } = display;
  let lastDay = startDate;
  if (endDate !== null && endDate > startDate) {
    // Fin exclue : une journée entière finit la veille de sa date de fin (convention Google / iCal) ; un événement qui finit à
    // minuit pile ne déborde pas sur le jour suivant.
    lastDay = display.allDay || endTime === '00:00' ? addDays(endDate, -1) : endDate;
  }
  return { firstDay: startDate, lastDay: lastDay < startDate ? startDate : lastDay, allDay: display.allDay, startTime, endTime };
}

/** Agenda d'un événement : le compte et l'agenda auxquels il appartient (null si le compte n'est plus connu). */
function calendarOf(event: ExternalEvent, accounts: readonly CalendarAccount[]): { account: CalendarAccount; calendar: CalendarRef | null } | null {
  const account = accounts.find((candidate) => candidate.id === event.accountId);
  if (!account) return null;
  return { account, calendar: account.calendars.find((candidate) => candidate.id === event.calendarId) ?? null };
}

/**
 * Filtre d'espace (S-05 critère 7) : sous Pro ou Perso, l'événement est affiché si l'agenda de son compte est rattaché à cet espace
 * (ES-06) et marqué affiché ; un agenda non rattaché, marqué non affiché ou inconnu n'est visible que sous « Tout » (proposition de la
 * fiche, à confirmer avec ES-06).
 */
export function externalEventVisible(calendar: CalendarRef | null, filter: SpaceFilter): boolean {
  if (filter === 'all') return true;
  return calendar !== null && calendar.shown && calendar.spaceId === filter;
}

export interface ExternalEventsByDayInput {
  readonly days: readonly LocalDate[];
  readonly events: readonly ExternalEvent[];
  readonly accounts: readonly CalendarAccount[];
  readonly timeZone: string;
  readonly filter: SpaceFilter;
}

/**
 * Entrées d'événement de chaque jour de `days` (clé absente : aucun événement ce jour). Un événement de plusieurs jours est affiché
 * sur chaque jour couvert de la semaine : l'heure de début sur le premier jour, « toute la journée » sur les suivants. Le tri
 * (journée entière puis heure de début) est celui de `buildTodayList`. Les événements d'un compte supprimé disparaissent.
 */
export function externalEventsByDay(input: ExternalEventsByDayInput): Map<LocalDate, TodayEventEntry[]> {
  const first = input.days[0];
  const last = input.days[input.days.length - 1];
  const result = new Map<LocalDate, TodayEventEntry[]>();
  if (first === undefined || last === undefined) return result;
  const visibleDays = new Set(input.days);
  for (const event of input.events) {
    const owner = calendarOf(event, input.accounts);
    if (!owner || !externalEventVisible(owner.calendar, input.filter)) continue;
    const span = externalEventSpan(event, input.timeZone);
    if (!span || span.lastDay < first || span.firstDay > last) continue;
    for (let day = span.firstDay < first ? first : span.firstDay; day <= span.lastDay && day <= last; day = addDays(day, 1)) {
      if (!visibleDays.has(day)) continue;
      const starting = day === span.firstDay;
      const entry: TodayEventEntry = {
        id: event.id as ExternalEventId,
        title: event.title,
        allDay: !starting || span.allDay,
        startTime: starting && !span.allDay ? span.startTime : null,
        // Hors filtre d'espace : le filtre est déjà appliqué par l'agenda ci-dessus.
        spaceId: null,
        calendarName: owner.account.label,
        icon: null,
      };
      const list = result.get(day);
      if (list) list.push(entry);
      else result.set(day, [entry]);
    }
  }
  return result;
}
