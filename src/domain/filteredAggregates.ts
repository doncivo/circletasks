import { focusSeconds, projectOfFocusSession, type FocusSessionRecord } from './focusSession';
import { matchesItemFilter, type ItemFilter } from './itemFilter';
import type { Routine, RoutineLog, Task } from './model';
import type { RoutineId, TaskId } from './types';

/**
 * Agrégats filtrés par espace et projet (ES-08) : socle des statistiques (H-01 à H-03) et du Focus (F-01 à F-04), qui arrivent à
 * l'ordre 3. Le même `ItemFilter` (filtre d'espace global d'ES-03 + projet d'ES-04) s'applique à toutes les données portant un
 * `spaceId` / `projectId` : tâches, routines, validations de routine (via leur routine), sessions Focus (projet de leur tâche).
 * Un élément sans projet (routine, session sans tâche) n'est compté que dans « Tous les projets ».
 */

/** Nombre de tâches terminées (non supprimées) qui passent le filtre. */
export function countDoneTasks(tasks: readonly Pick<Task, 'status' | 'spaceId' | 'projectId' | 'deletedAt'>[], filter: ItemFilter): number {
  return tasks.filter((task) => task.status === 'done' && task.deletedAt === null && matchesItemFilter(task, filter)).length;
}

/** Validations de routine retenues : une validation suit l'espace de sa routine (sans projet). */
export function filterRoutineLogs<L extends Pick<RoutineLog, 'routineId'>>(
  logs: readonly L[],
  routines: readonly Pick<Routine, 'id' | 'spaceId'>[],
  filter: ItemFilter,
): L[] {
  const byId = new Map<RoutineId, Pick<Routine, 'id' | 'spaceId'>>(routines.map((routine) => [routine.id as RoutineId, routine]));
  return logs.filter((log) => {
    const routine = byId.get(log.routineId as RoutineId);
    return routine !== undefined && matchesItemFilter({ spaceId: routine.spaceId, projectId: null }, filter);
  });
}

/** Sessions Focus retenues : espace de la session, projet de sa tâche. */
export function filterFocusSessions(
  sessions: readonly FocusSessionRecord[],
  tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>,
  filter: ItemFilter,
): FocusSessionRecord[] {
  return sessions.filter((session) => matchesItemFilter({ spaceId: session.spaceId, projectId: projectOfFocusSession(session, tasks) }, filter));
}

/** Temps de concentration total, en minutes (arrondi à la minute), des sessions terminées qui passent le filtre. */
export function focusMinutes(sessions: readonly FocusSessionRecord[], tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>, filter: ItemFilter): number {
  const seconds = filterFocusSessions(sessions, tasks, filter).reduce((total, session) => total + focusSeconds(session), 0);
  return Math.round(seconds / 60);
}
