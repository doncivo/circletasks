import type { Task } from '../../domain/model';
import { asEntityId, type TaskId } from '../../domain/types';
import { syncErrorCodeOf, type RemoteChanges } from '../../platform/sync/types';
import { defaultSyncLogger, type SyncLogger } from '../../sync';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import { checklistsStore } from '../checklists/checklistsStore';
import { emitEventsChanged } from '../events/eventEvents';
import { routinesStore } from '../routines/routineStore';
import { emitRoutinesChanged } from '../routines/routineEvents';
import { somedayStore } from '../someday/somedayStore';
import { trashStore } from '../tasks/trashStore';
import { todayStore } from '../today/todayStore';
import { weekStore } from '../week/weekStore';

/**
 * Après chaque lot appliqué par la synchro (ADR 0011 section 8 ; Y-02 critère 18) : `taskEntities` reçoit les tâches relues (un hlc
 * inférieur n'écrase jamais, avenant T-04), la corbeille recharge si `task` est touchée, les autres stores rechargent leur liste. Les
 * commandes d'annulation (T-13) restent protégées par leur contrôle de hlc (`'stale'`) : rien n'est fait ici pour elles.
 *
 * Y-TECH-02 (revue, point 2) : une relecture en échec n'est jamais prise pour une suppression (la tâche reste à l'écran telle qu'elle
 * était) ; chaque relecture en échec est journalisée (`remote-reload-failed`, code seulement) et rendue (`failed`) pour que
 * l'interface la signale ; les données sont en base, relues au lot suivant.
 */
export async function applyRemoteChanges(container: AppContainer, change: RemoteChanges, logger: SyncLogger = defaultSyncLogger): Promise<{ readonly failed: readonly string[] }> {
  const failed = new Set<string>();
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      logger.log('remote-reload-failed', { what, code: syncErrorCodeOf(error) });
      failed.add(what);
      return { ok: false };
    }
  };
  const tasks = change.ids.get('task');
  if (tasks && tasks.size > 0) {
    const read: Task[] = [];
    const gone: TaskId[] = [];
    for (const id of tasks) {
      let taskId: TaskId;
      try {
        taskId = asEntityId<TaskId>(id);
      } catch {
        // Identifiant reçu mal formé : ignoré (rien à recharger), journalisé sans sa valeur.
        logger.log('remote-id-ignored', { table: 'task' });
        continue;
      }
      const result = await attempt('task', () => container.data.repos.tasks.getById(taskId, { includeDeleted: true }));
      // Lecture en échec : rien n'est conclu (ni publiée, ni retirée).
      if (!result.ok) continue;
      const task = result.value;
      if (task && task.deletedAt === null) read.push(task);
      else gone.push(taskId);
    }
    container.taskEntities.publish(read);
    if (gone.length > 0) container.taskEntities.remove(gone);
    const trash = trashStore.get(container).getState();
    if (trash.status !== 'idle') void trash.load(trash.filter);
    const today = todayStore.get(container).getState();
    if (today.date) void today.load(today.date, today.filter);
    const someday = somedayStore.get(container).getState();
    if (someday.status !== 'idle') void someday.load();
  }
  if (change.tables.has('task') || change.tables.has('routine') || change.tables.has('routine_log') || change.tables.has('routine_pause') || change.tables.has('event') || change.tables.has('checklist')) {
    const week = weekStore.get(container).getState();
    if (week.weekStart) void week.load(week.weekStart, week.filter);
  }
  if (change.tables.has('routine') || change.tables.has('routine_log') || change.tables.has('routine_pause')) {
    emitRoutinesChanged(container.data);
    const routines = routinesStore.get(container).getState();
    if (routines.status !== 'idle') void routines.load(routines.filter);
  }
  if (change.tables.has('event') || change.tables.has('holiday') || change.tables.has('settings')) emitEventsChanged(container.data);
  if (change.tables.has('checklist') || change.tables.has('checklist_item')) {
    const checklists = checklistsStore.get(container).getState();
    if (checklists.status !== 'idle') void checklists.load(checklists.filter);
  }
  if (change.tables.has('space')) {
    const spaces = await attempt('space', () => container.data.repos.spaces.listAll());
    if (spaces.ok) useAppStore.getState().setSpaces(spaces.value);
  }
  if (change.tables.has('project')) {
    const projects = await attempt('project', () => container.data.repos.projects.listForFilter('all', { includeArchived: true }));
    if (projects.ok) useAppStore.getState().setProjects(projects.value);
  }
  return { failed: [...failed] };
}
