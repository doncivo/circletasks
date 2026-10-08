import { appleLinkState, parseAppleLists } from '../../../domain/appleReminders';
import type { TaskId } from '../../../domain/types';
import { logFailure } from '../../../platform/desktop/log';
import type { AppContainer } from '../../app/container';
import { applyRemoteChanges } from '../../sync/remoteChanges';
import { appleRemindersState } from './appleRemindersState';

/**
 * Gestes de réparation de l'échec `lists-setting-invalid` (aucune impasse) : détacher les tâches dont la liste n'est pas dans le réglage, ou
 * réécrire un réglage lisible. Rien n'est jamais supprimé : les tâches restent, ordinaires, avec leur liste d'origine.
 */
export async function detachUnlisted(container: AppContainer): Promise<number> {
  const state = appleRemindersState(container);
  await state.load();
  const repos = container.data.repos;
  const known = new Set(parseAppleLists(await repos.settings.get('appleReminders.lists')).lists.map((list) => list.id));
  const targets = (await repos.tasks.listAppleSourced()).filter((task) => appleLinkState(task) === 'linked' && (task.appleListId === null || !known.has(task.appleListId)));
  const touched = new Set<TaskId>();
  await container.data.transaction(async (tx) => {
    for (const task of targets) {
      await tx.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: task.appleListId, appleRecurring: false });
      await tx.appleLinks.remove(task.id);
      touched.add(task.id);
    }
  });
  if (touched.size > 0) {
    await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(touched)]]) });
    await state.addNotice({ kind: 'detached', count: touched.size });
  }
  await state.clearFailure();
  return touched.size;
}

/** Réécrit le réglage des listes sous une forme lisible (les entrées valides sont gardées) et efface l'échec. */
export async function resetLists(container: AppContainer): Promise<void> {
  const state = appleRemindersState(container);
  try {
    await state.load();
    const readable = parseAppleLists(await container.data.repos.settings.get('appleReminders.lists'));
    await container.data.repos.settings.set('appleReminders.lists', readable);
    await state.reload();
    await state.clearFailure();
  } catch {
    logFailure('apple-reminders', 'lists-reset-failed');
    await state.fail('settings-unreadable');
  }
}
