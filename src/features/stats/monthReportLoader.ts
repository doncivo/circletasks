import type { DataAccess } from '../../db/repositories';
import { EMPTY_FOCUS_TOTAL, monthSpan } from '../../domain/focusTotals';
import type { ItemFilter } from '../../domain/itemFilter';
import {
  buildMonthReport,
  countedRange,
  firstDayOf,
  hasRoutinesAndGoals,
  lastDayOf,
  type MonthRef,
  type MonthReport,
  type RoutinesMonthInput,
  type WeekCount,
} from '../../domain/monthReport';
import { groupDoneDates, pausesByRoutine, type DateInterval } from '../../domain/routineSchedule';
import type { LocalDate, RoutineId } from '../../domain/types';
import type { FirstWeekday } from '../../domain/week';

export interface MonthReportQuery {
  readonly month: MonthRef;
  readonly today: LocalDate;
  readonly filter: ItemFilter;
  readonly firstWeekday: FirstWeekday;
}

const NO_ROUTINES: RoutinesMonthInput = { routines: [], doneByRoutine: new Map<RoutineId, ReadonlySet<LocalDate>>(), pausesOf: new Map<RoutineId, readonly DateInterval[]>() };

/**
 * Calcule le rapport d'un mois (H-01, H-02) : comptes de tâches par semaine et d'objectifs agrégés par SQLite (`repos.stats`), temps de
 * concentration par `repos.focusSessions.totals` (F-03), validations de routines du mois seulement. Rien n'est lu tâche par tâche.
 * Sous un filtre de projet, routines et objectifs (sans projet) ne sont pas lus du tout.
 */
export async function loadMonthReport(data: DataAccess, query: MonthReportQuery): Promise<MonthReport> {
  const { repos } = data;
  const { month, today, filter } = query;
  const range = countedRange(month, today);
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  const scoped = hasRoutinesAndGoals(filter);

  const [weekCounts, goals, focus, routines] = await Promise.all([
    range ? repos.stats.taskCountsByWeek({ range, filter }) : Promise.resolve<WeekCount[]>([]),
    scoped ? repos.stats.goalCounts({ range: { from: first, to: last }, filter }) : Promise.resolve({ achieved: 0, total: 0 }),
    range ? repos.focusSessions.totals({ span: monthSpan(first), filter }) : Promise.resolve(EMPTY_FOCUS_TOTAL),
    scoped ? loadRoutines(data, month, filter) : Promise.resolve(NO_ROUTINES),
  ]);
  return buildMonthReport({ month, today, filter, firstWeekday: query.firstWeekday, weekCounts, routines, focus, goals });
}

async function loadRoutines(data: DataAccess, month: MonthRef, filter: ItemFilter): Promise<RoutinesMonthInput> {
  const { repos } = data;
  const [routines, logs, pauses] = await Promise.all([
    repos.routines.listForFilter(filter.space, { includeArchived: true }),
    repos.routineLogs.listForRange({ from: firstDayOf(month), to: lastDayOf(month) }, filter.space),
    repos.routines.listPauses(filter.space),
  ]);
  return { routines, doneByRoutine: groupDoneDates(logs), pausesOf: pausesByRoutine(pauses) };
}
