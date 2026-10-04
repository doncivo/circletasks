import type { Goal, GoalProgress, NewGoal, Task } from './model';
import { matchesSpaceFilter } from './spaceRules';
import type { GoalId, LocalDate, Result, SpaceFilter } from './types';
import { isoWeekOf, weekStartOf } from './week';

/**
 * Objectif de la semaine (M17, OB-01 à OB-06). Fonctions pures : la date du jour est fournie par l'appelant
 * (`todayLocal(clock)`), aucune lecture de base ici.
 */

export const GOAL_TITLE_MAX_LENGTH = 200;

export type GoalTitleError = 'empty-title' | 'title-too-long';

/** OB-01 critère 5 : titre de 1 à 200 caractères (espaces de bord retirés) ; un titre vide est refusé. */
export function validateGoalTitle(raw: string): Result<string, GoalTitleError> {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, error: 'empty-title' };
  if (title.length > GOAL_TITLE_MAX_LENGTH) return { ok: false, error: 'title-too-long' };
  return { ok: true, value: title };
}

/** Ordre de création (OB-02 critère 9), puis identifiant : deux encadrés ne changent jamais de place. */
export function compareGoalsByCreation(a: Goal, b: Goal): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const live = (goal: Goal): boolean => goal.deletedAt === null;

/** Objectifs (non supprimés) de la semaine commençant le lundi `weekStart`, filtrés par espace, dans l'ordre de création. */
export function goalsOfWeek(goals: readonly Goal[], weekStart: LocalDate, filter: SpaceFilter = 'all'): Goal[] {
  return goals
    .filter((goal) => live(goal) && goal.weekStart === weekStart && matchesSpaceFilter(goal, filter))
    .sort(compareGoalsByCreation);
}

/**
 * OB-02 : objectifs affichés en tête d'Aujourd'hui le jour `date` : épinglés, de la semaine de `date`, de l'espace du filtre.
 * Un objectif atteint reste affiché jusqu'à la fin de la semaine (critère 7) ; un objectif clos ne l'est plus.
 */
export function pinnedGoalsForWeek(goals: readonly Goal[], date: LocalDate, filter: SpaceFilter): Goal[] {
  return goalsOfWeek(goals, weekStartOf(date), filter).filter((goal) => goal.pinned && goal.status !== 'closed');
}

/**
 * OB-03 critères 7 et 8 : objectifs ouverts auxquels une tâche peut se rattacher, tous espaces confondus (QB-13). Semaine de
 * référence : celle de la date de la tâche, la semaine en cours pour une tâche sans date (Un jour).
 */
export function goalsAvailableFor(taskDate: LocalDate | null, today: LocalDate, goals: readonly Goal[]): Goal[] {
  const weekStart = weekStartOf(taskDate ?? today);
  return goals.filter((goal) => live(goal) && goal.weekStart === weekStart && goal.status === 'open').sort(compareGoalsByCreation);
}

/** OB-04 critère 3 : tâches rattachées faites / total ; les tâches supprimées ne comptent pas. */
export function goalProgress(tasks: readonly Pick<Task, 'status' | 'deletedAt'>[]): GoalProgress {
  let done = 0;
  let total = 0;
  for (const task of tasks) {
    if (task.deletedAt !== null) continue;
    total += 1;
    if (task.status === 'done') done += 1;
  }
  return { done, total };
}

/** Part faite en pourcentage entier (0 sans tâche) : valeur de la barre de progression. */
export function progressPercent(progress: GoalProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

/**
 * OB-05 critères 1, 2 et 6 : objectifs à réviser le jour `today` : encore ouverts alors que leur semaine est terminée. Un objectif
 * atteint ou clos n'est jamais proposé ; la proposition dure jusqu'à la réponse. Du plus ancien au plus récent.
 */
export function goalsToReview(today: LocalDate, goals: readonly Goal[], filter: SpaceFilter = 'all'): Goal[] {
  const currentWeek = weekStartOf(today);
  return goals
    .filter((goal) => live(goal) && goal.status === 'open' && goal.weekStart < currentWeek && matchesSpaceFilter(goal, filter))
    .sort((a, b) => (a.weekStart !== b.weekStart ? (a.weekStart < b.weekStart ? -1 : 1) : compareGoalsByCreation(a, b)));
}

export interface GoalCarryOver {
  /** Nouvel objectif de la semaine en cours (même titre, icône, espace, épinglage ; `carriedFromId` = ancien). */
  readonly goal: NewGoal;
  /** Tâches non faites rattachées au nouvel objectif. */
  readonly taskIds: readonly Task['id'][];
  /** Parmi elles, celles restées dans le passé : elles prennent la date d'aujourd'hui, heure conservée (QB-14). */
  readonly redatedTaskIds: readonly Task['id'][];
}

/**
 * OB-05 critères 3 et 4 (QB-14) : calcule la reconduction. Les tâches faites restent sur l'ancien objectif. Une tâche non faite
 * datée avant la semaine en cours prend la date d'aujourd'hui ; celles datées dans la semaine en cours ou plus tard, ou sans date
 * (Un jour), gardent leur date.
 */
export function carryOverGoal(goal: Goal, tasks: readonly Task[], today: LocalDate, newGoalId: GoalId): GoalCarryOver {
  const currentWeek = weekStartOf(today);
  const undone = tasks.filter((task) => task.deletedAt === null && task.status === 'todo');
  return {
    goal: {
      id: newGoalId,
      spaceId: goal.spaceId,
      weekStart: currentWeek,
      title: goal.title,
      icon: goal.icon,
      pinned: goal.pinned,
      status: 'open',
      carriedFromId: goal.id,
    },
    taskIds: undone.map((task) => task.id),
    redatedTaskIds: undone.filter((task) => task.date !== null && !task.someday && task.date < currentWeek).map((task) => task.id),
  };
}

/** OB-06 critères 1 et 2 : statut affiché d'une semaine passée ; un objectif ouvert sans réponse est « Non atteint ». */
export function historyStatusOf(goal: Pick<Goal, 'status'>): 'achieved' | 'notAchieved' {
  return goal.status === 'achieved' ? 'achieved' : 'notAchieved';
}

/** OB-06 : numéro de semaine ISO (« S38 » = 38) de la semaine d'un objectif. */
export function goalWeekNumber(weekStart: LocalDate): number {
  return isoWeekOf(weekStart).week;
}

/** M17 / OB-06 : ordre des tâches rattachées à un objectif : par date (sans date en dernier), puis ordre manuel, puis id. */
export function compareAttachedTasks(a: Pick<Task, 'id' | 'date' | 'sortOrder'>, b: Pick<Task, 'id' | 'date' | 'sortOrder'>): number {
  if (a.date !== b.date) return a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * M17 / OB-06 : sélecteur unique des tâches rattachées, groupées par objectif et triées (`compareAttachedTasks`). Les tâches
 * supprimées et sans objectif sont écartées ; `includeGoal` restreint aux objectifs voulus (lignes dépliées de l'historique).
 */
export function attachedTasksByGoal<T extends Pick<Task, 'id' | 'goalId' | 'deletedAt' | 'date' | 'sortOrder'>>(
  tasks: Iterable<T>,
  includeGoal: (goalId: GoalId) => boolean = () => true,
): Map<GoalId, T[]> {
  const grouped = new Map<GoalId, T[]>();
  for (const task of tasks) {
    if (task.goalId === null || task.deletedAt !== null || !includeGoal(task.goalId)) continue;
    const list = grouped.get(task.goalId) ?? [];
    list.push(task);
    grouped.set(task.goalId, list);
  }
  for (const list of grouped.values()) list.sort(compareAttachedTasks);
  return grouped;
}
