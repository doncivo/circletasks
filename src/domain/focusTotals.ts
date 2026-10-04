import { filterFocusSessions } from './filteredAggregates';
import { focusSeconds, type FocusSessionRecord } from './focusSession';
import type { ItemFilter } from './itemFilter';
import { addDays, makeLocalDate, parseLocalDate } from './localDate';
import type { Task } from './model';
import type { IsoDateTime, LocalDate, TaskId } from './types';
import { weekStartOf, type FirstWeekday } from './week';

/**
 * Temps de concentration (M10, F-03) : somme des (fin - début - pauses) des sessions TERMINÉES, comptée au jour LOCAL du début de la
 * session (fuseau de l'appareil, T-11), même si elle franchit minuit (F-03 D2). Les sessions de moins d'une minute n'existent pas
 * (F-01 critère 7) ; une session supprimée avec sa tâche reste comptée (la session survit à la tâche, F-03 critère 8).
 */

/** Plage d'instants UTC, `from` inclus, `to` exclu (forme de `InstantRange`, src/db/repositories/common.ts). */
export interface InstantSpan {
  readonly from: IsoDateTime;
  readonly to: IsoDateTime;
}

export interface FocusTotal {
  /** Temps de concentration cumulé, en secondes. */
  readonly seconds: number;
  readonly sessions: number;
}

export const EMPTY_FOCUS_TOTAL: FocusTotal = { seconds: 0, sessions: 0 };

export interface FocusTaskTotal extends FocusTotal {
  readonly taskId: TaskId;
}

/** Minutes entières d'un total (arrondies à la minute la plus proche). */
export function focusTotalMinutes(total: Pick<FocusTotal, 'seconds'>): number {
  return Math.round(total.seconds / 60);
}

/** Instant (UTC) du début du jour local `date` (00:00 dans le fuseau de l'appareil). */
function localMidnightIso(date: LocalDate): IsoDateTime {
  const { year, month, day } = parseLocalDate(date);
  return new Date(year, month - 1, day).toISOString() as IsoDateTime;
}

/** Plage d'instants couvrant les jours locaux de `first` à `last` inclus. */
export function localDaysSpan(first: LocalDate, last: LocalDate): InstantSpan {
  return { from: localMidnightIso(first), to: localMidnightIso(addDays(last, 1)) };
}

/** Le jour local `date` : de 00:00 à 24:00 dans le fuseau de l'appareil (23 ou 25 h les jours de changement d'heure). */
export function daySpan(date: LocalDate): InstantSpan {
  return localDaysSpan(date, date);
}

/** La semaine de `date`, selon le premier jour de semaine choisi (P-03). */
export function weekSpan(date: LocalDate, firstWeekday: FirstWeekday): InstantSpan {
  const start = weekStartOf(date, firstWeekday);
  return localDaysSpan(start, addDays(start, 6));
}

/** Le mois civil de `date`. */
export function monthSpan(date: LocalDate): InstantSpan {
  const { year, month } = parseLocalDate(date);
  const first = makeLocalDate(year, month, 1);
  const next = month === 12 ? makeLocalDate(year + 1, 1, 1) : makeLocalDate(year, month + 1, 1);
  return { from: localMidnightIso(first), to: localMidnightIso(next) };
}

/** Une session compte dans la plage si elle est terminée et que son DÉBUT y tombe (F-03 D2). */
export function countsInSpan(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt'>, span: InstantSpan): boolean {
  return session.endedAt !== null && session.startedAt >= span.from && session.startedAt < span.to;
}

/**
 * Total d'une plage, pour le filtre d'espace et de projet donné (ES-08 : projet de la session = projet de sa tâche ; sans tâche ou
 * sans projet, comptée seulement dans « Tous les projets »). Version pure du calcul SQL du repository (mêmes résultats, testés).
 */
export function focusTotals(
  sessions: readonly FocusSessionRecord[],
  tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>,
  filter: ItemFilter,
  span: InstantSpan,
): FocusTotal {
  const kept = filterFocusSessions(sessions.filter((session) => countsInSpan(session, span)), tasks, filter);
  return { seconds: kept.reduce((total, session) => total + focusSeconds(session), 0), sessions: kept.length };
}

/** Les tâches les plus travaillées de la plage (sessions sans tâche ignorées), du plus au moins travaillé. */
export function focusTotalsByTask(
  sessions: readonly FocusSessionRecord[],
  tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>,
  filter: ItemFilter,
  span: InstantSpan,
  limit: number,
): FocusTaskTotal[] {
  const totals = new Map<TaskId, { seconds: number; sessions: number }>();
  for (const session of filterFocusSessions(sessions.filter((candidate) => countsInSpan(candidate, span)), tasks, filter)) {
    if (!session.taskId) continue;
    const entry = totals.get(session.taskId) ?? { seconds: 0, sessions: 0 };
    entry.seconds += focusSeconds(session);
    entry.sessions += 1;
    totals.set(session.taskId, entry);
  }
  return [...totals.entries()]
    .map(([taskId, total]) => ({ taskId, ...total }))
    .sort((a, b) => b.seconds - a.seconds || String(a.taskId).localeCompare(String(b.taskId)))
    .slice(0, limit);
}
