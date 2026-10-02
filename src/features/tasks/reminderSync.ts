import type { Task } from '../../domain/model';
import { recomputeReminders } from '../../domain/reminders';
import type { DataAccess } from '../../db/repositories';

type Repos = DataAccess['repos'];

/**
 * N-02 critère 5 : après un changement de date ou d'heure d'une tâche, recalcule `fire_at` de chaque rappel (avance conservée, heure
 * locale flottante). Sans date ou sans heure, les rappels sont conservés tels quels mais inactifs (QB-07, QB-10). À appeler dans la
 * transaction qui écrit la tâche.
 */
export async function syncTaskReminders(repos: Repos, task: Pick<Task, 'id' | 'date' | 'time'>): Promise<void> {
  if (task.date === null || task.time === null) return;
  const target = { type: 'task', id: task.id } as const;
  const rewritten = recomputeReminders(task, await repos.reminders.listForTarget(target));
  if (rewritten !== null) await repos.reminders.replaceForTarget(target, rewritten);
}
