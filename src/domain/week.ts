import { addDays, parseLocalDate, weekdayOf } from './localDate';
import type { ChecklistSummary, Task } from './model';
import { buildTodayList, type TodayEventEntry, type TodayList, type TodayRoutineEntry } from './todayList';
import type { LocalDate, SpaceFilter } from './types';

/**
 * Semaine (M3, S-01) : du lundi au dimanche, numérotation ISO 8601. Calculs sur des dates civiles en UTC : aucun effet de
 * fuseau ni de changement d'heure (la semaine du passage à l'heure d'été compte bien 7 jours).
 */

/** Le lundi de la semaine qui contient `date` (premier jour toujours lundi à l'ordre 1, réglage P-03 à l'ordre 3). */
export function weekStartOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - weekdayOf(date));
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
    return {
      date,
      list: buildTodayList({
        date,
        filter: input.filter,
        tasks: byDate.get(date) ?? [],
        ...(extras?.routines ? { routines: extras.routines } : {}),
        ...(extras?.events ? { events: extras.events } : {}),
        ...(extras?.checklists ? { checklists: extras.checklists } : {}),
      }),
    };
  });
}
