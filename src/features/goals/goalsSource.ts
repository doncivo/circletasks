import { pinnedGoalsForWeek } from '../../domain/goalRules';
import type { TodayGoalEntry } from '../../domain/todayList';
import type { LocalDate, SpaceFilter } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import type { AppContainer } from '../app/container';
import { registerTodaySource, type TodaySource } from '../today/todaySources';
import { onGoalsChanged } from './goalEvents';

/**
 * Objectifs épinglés du jour `date` (OB-02) avec leur avancement (OB-04) : ceux de la semaine de `date`, de l'espace du filtre,
 * dans l'ordre de création. Le compte de l'avancement ne dépend pas du filtre (OB-04 critère 7) : toutes les tâches rattachées comptent.
 */
export async function loadPinnedGoalEntries(container: AppContainer, date: LocalDate, filter: SpaceFilter): Promise<TodayGoalEntry[]> {
  const week = await container.data.repos.goals.listForWeek(weekStartOf(date), filter);
  const goals = pinnedGoalsForWeek(week, date, filter);
  if (goals.length === 0) return [];
  const progress = await container.data.repos.tasks.progressByGoal(goals.map((goal) => goal.id));
  return goals.map((goal) => ({ goal, progress: progress.get(goal.id) ?? { done: 0, total: 0 } }));
}

/** Empreinte des rattachements et des états des tâches chargées : change quand une tâche rattachée est terminée, rouverte, supprimée ou rattachée. */
function attachmentSignature(container: AppContainer): string {
  const parts: string[] = [];
  for (const task of container.taskEntities.getSnapshot().values()) {
    if (task.goalId !== null) parts.push(`${task.id}:${task.goalId}:${task.status}`);
  }
  return parts.sort().join('|');
}

/**
 * S'abonne aux changements qui modifient un encadré ou un avancement : une écriture d'objectif (création, épinglage, atteint,
 * annulation) ou une tâche rattachée terminée / rouverte / supprimée n'importe où (OB-04 critère 2, sans rechargement).
 */
export function subscribeGoalChanges(container: AppContainer, onChange: () => void): () => void {
  let signature = attachmentSignature(container);
  const offGoals = onGoalsChanged(container.data, onChange);
  const offTasks = container.taskEntities.subscribe(() => {
    const next = attachmentSignature(container);
    if (next === signature) return;
    signature = next;
    onChange();
  });
  return () => {
    offGoals();
    offTasks();
  };
}

/** Source d'Aujourd'hui (A-01) : un encadré par objectif épinglé de la semaine (QB-12). */
export const goalsTodaySource: TodaySource = {
  id: 'goals',
  async load(container, date, filter) {
    return { goals: await loadPinnedGoalEntries(container, date, filter) };
  },
  subscribe: subscribeGoalChanges,
};

let unregister: (() => void) | null = null;

/** Branche la source d'objectifs sur Aujourd'hui, une seule fois (appelé au démarrage de l'app). */
export function registerGoalsSource(): void {
  if (unregister) return;
  unregister = registerTodaySource(goalsTodaySource);
}

/** Retire la source (tests). */
export function unregisterGoalsSource(): void {
  unregister?.();
  unregister = null;
}
