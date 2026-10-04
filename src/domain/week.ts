import { addDays, parseLocalDate, weekdayOf } from './localDate';
import type { ChecklistSummary, Task } from './model';
import { buildTodayList, type TodayEventEntry, type TodayList, type TodayRoutineEntry } from './todayList';
import type { LocalDate, SpaceFilter, Weekday } from './types';

/**
 * Semaine (M3, S-01) : du lundi au dimanche, numérotation ISO 8601. Calculs sur des dates civiles en UTC : aucun effet de
 * fuseau ni de changement d'heure (la semaine du passage à l'heure d'été compte bien 7 jours).
 */

/** P-03 : premier jour de la semaine affichée (lundi par défaut ; samedi ou dimanche au choix). */
export type FirstWeekday = 'monday' | 'saturday' | 'sunday';
export const FIRST_WEEKDAYS: readonly FirstWeekday[] = ['monday', 'saturday', 'sunday'];
export const DEFAULT_FIRST_WEEKDAY: FirstWeekday = 'monday';

const FIRST_WEEKDAY_ISO: Readonly<Record<FirstWeekday, Weekday>> = { monday: 1, saturday: 6, sunday: 7 };

/** Jour ISO (1 = lundi … 7 = dimanche) du premier jour de semaine. */
export function firstWeekdayIso(first: FirstWeekday): Weekday {
  return FIRST_WEEKDAY_ISO[first];
}

/** Nombre de jours entre le premier jour de la semaine et `date` (0 à 6). */
export function daysSinceWeekStart(date: LocalDate, first: FirstWeekday = DEFAULT_FIRST_WEEKDAY): number {
  return (weekdayOf(date) - FIRST_WEEKDAY_ISO[first] + 7) % 7;
}

/** Jours ISO dans l'ordre d'affichage d'une semaine commençant par `first` (lundi : 1…7 ; dimanche : 7, 1…6). */
export function weekdayOrder(first: FirstWeekday = DEFAULT_FIRST_WEEKDAY): Weekday[] {
  const start = FIRST_WEEKDAY_ISO[first];
  return Array.from({ length: 7 }, (_, i) => (((start - 1 + i) % 7) + 1) as Weekday);
}

/**
 * Premier jour (lundi par défaut) de la semaine qui contient `date`. Les objectifs, le rapport et la règle « toutes les N semaines »
 * restent sur le lundi (P-03 D2) : ils appellent sans second argument.
 */
export function weekStartOf(date: LocalDate, first: FirstWeekday = DEFAULT_FIRST_WEEKDAY): LocalDate {
  return addDays(date, -daysSinceWeekStart(date, first));
}

/** Les sept jours de la semaine commençant le lundi `weekStart`. */
export function weekDays(weekStart: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** Lundi de la semaine décalée de `count` semaines (négatif : avant). */
export function addWeeks(weekStart: LocalDate, count: number): LocalDate {
  return addDays(weekStart, count * 7);
}

export interface IsoWeek {
  /** Année ISO : celle du jeudi de la semaine (le 1er janvier peut appartenir à la semaine 52 ou 53 de l'année précédente). */
  readonly year: number;
  readonly week: number;
}

/** Numéro de semaine ISO 8601 de `date` (semaine 1 : celle du premier jeudi de l'année). */
export function isoWeekOf(date: LocalDate): IsoWeek {
  const thursday = addDays(date, 4 - weekdayOf(date));
  const { year } = parseLocalDate(thursday);
  const jan1 = Date.UTC(year, 0, 1);
  const { month, day } = parseLocalDate(thursday);
  const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - jan1) / 86_400_000);
  return { year, week: Math.floor(dayOfYear / 7) + 1 };
}

/** Éléments d'un jour fournis par les autres modules (routines, événements, checklists) : même forme que pour Aujourd'hui. */
export interface WeekDayExtras {
  readonly routines?: readonly TodayRoutineEntry[];
  readonly events?: readonly TodayEventEntry[];
  readonly checklists?: readonly ChecklistSummary[];
}

export interface WeekInput {
  readonly weekStart: LocalDate;
  readonly filter: SpaceFilter;
  readonly tasks: readonly Task[];
  /** Éléments des autres modules par jour ; un jour absent n'a que ses tâches. */
  readonly extras?: ReadonlyMap<LocalDate, WeekDayExtras>;
  /** Événements des agendas externes par jour (S-05, `externalEventsByDay`) : ajoutés aux événements fournis par les sources. */
  readonly externalEvents?: ReadonlyMap<LocalDate, readonly TodayEventEntry[]>;
}

export interface WeekDay {
  readonly date: LocalDate;
  /** Liste du jour, assemblée comme celle d'Aujourd'hui (`buildTodayList` : événements, éléments à faire, terminés). */
  readonly list: TodayList;
}

/**
 * Assemble les sept jours de la semaine en réutilisant `buildTodayList` pour chacun (S-01 critère 4) : événements en tête,
 * éléments avec heure par heure, puis sans heure dans leur ordre manuel (Q11), terminés en bas (T-04). Les tâches sont
 * réparties par date en une seule passe (5 000 tâches : une lecture, pas sept).
 */
export function buildWeek(input: WeekInput): WeekDay[] {
  const days = weekDays(input.weekStart);
  const byDate = new Map<LocalDate, Task[]>(days.map((date) => [date, []]));
  for (const task of input.tasks) {
    if (task.date === null) continue;
    byDate.get(task.date)?.push(task);
  }
  return days.map((date) => {
    const extras = input.extras?.get(date);
    const external = input.externalEvents?.get(date);
    const events = external ? [...(extras?.events ?? []), ...external] : extras?.events;
    return {
      date,
      list: buildTodayList({
        date,
        filter: input.filter,
        tasks: byDate.get(date) ?? [],
        ...(extras?.routines ? { routines: extras.routines } : {}),
        ...(events ? { events } : {}),
        ...(extras?.checklists ? { checklists: extras.checklists } : {}),
      }),
    };
  });
}

/**
 * Position finale, dans les éléments à faire du jour (`rows`, routines comprises), de la tâche `draggedId` lâchée à la position
 * `dropIndex` parmi les AUTRES tâches du jour (à faire puis terminées, dans l'ordre affiché), telle que la mesure le glisser :
 * nombre d'autres tâches situées au-dessus du pointeur. Lâchée après la dernière tâche à faire, elle passe en fin de liste.
 * Le domaine (`moveTaskRow`) ramène ensuite cette position dans le groupe autorisé par l'heure (Q11).
 */
export function rowIndexForDrop(list: Pick<TodayList, 'rows' | 'doneRows'>, draggedId: string, dropIndex: number): number {
  const others = [...list.rows, ...list.doneRows].filter((row) => row.kind === 'task' && row.id !== draggedId);
  const rowsWithout = list.rows.filter((row) => row.id !== draggedId);
  const anchor = others[Math.max(0, Math.trunc(dropIndex))];
  if (!anchor) return rowsWithout.length;
  const position = rowsWithout.findIndex((row) => row.id === anchor.id);
  return position < 0 ? rowsWithout.length : position;
}
