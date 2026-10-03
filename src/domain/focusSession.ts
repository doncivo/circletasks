import type { Task } from './model';
import { defaultSpaceFor } from './spaceRules';
import type { Space } from './model';
import type { Id, IsoDateTime, ProjectId, SpaceFilter, SpaceId, TaskId } from './types';

/**
 * Session Focus (M10, PRD section 6 `focus_session`) : `task_id` facultatif, `space_id`, durée prévue, début, fin, secondes de pause.
 * La table et les écrans arrivent à l'ordre 3 (F-01 à F-04) ; ce module ne porte que la règle d'espace et de projet d'une session et
 * le calcul de temps, pour que le filtre d'espace / projet (ES-08) s'y applique dès sa création. `focus_session` n'a pas de
 * `project_id` : le projet d'une session est celui de sa tâche (à confirmer par l'architecte, ES-08).
 */
export interface FocusSessionRecord {
  readonly id: Id;
  readonly taskId: TaskId | null;
  readonly spaceId: SpaceId;
  readonly plannedMin: number;
  readonly startedAt: IsoDateTime;
  /** null tant que la session n'est pas terminée. */
  readonly endedAt: IsoDateTime | null;
  readonly pausedSec: number;
}

/** Espace (et projet) porté par une session au lancement. */
export interface FocusPlacement {
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
}

/**
 * Règle d'espace d'une session lancée (ES-08 critère 2) : avec une tâche, l'espace et le projet de la tâche ; sans tâche, l'espace
 * actif au lancement (filtre Pro / Perso ; « Tout » : Pro, comme toute création, T-01) et aucun projet. Null seulement tant que les
 * espaces ne sont pas chargés.
 */
export function focusPlacementAtLaunch(
  task: Pick<Task, 'spaceId' | 'projectId'> | null,
  filter: SpaceFilter,
  spaces: readonly Pick<Space, 'id' | 'sortOrder'>[],
): FocusPlacement | null {
  if (task) return { spaceId: task.spaceId, projectId: task.projectId };
  const spaceId = defaultSpaceFor(filter, spaces);
  return spaceId ? { spaceId, projectId: null } : null;
}

/** Projet d'une session : celui de sa tâche (aucun sans tâche ou si la tâche est inconnue). */
export function projectOfFocusSession(session: Pick<FocusSessionRecord, 'taskId'>, tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>): ProjectId | null {
  return session.taskId ? (tasks.get(session.taskId)?.projectId ?? null) : null;
}

/**
 * Temps de concentration d'une session, en secondes : durée écoulée moins les pauses ; 0 tant qu'elle n'est pas terminée ou si les
 * instants sont illisibles.
 */
export function focusSeconds(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec'>): number {
  if (session.endedAt === null) return 0;
  const elapsed = (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed - session.pausedSec)) : 0;
}
