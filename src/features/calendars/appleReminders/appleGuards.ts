import { appleLinkState, isAppleRecurringLocked } from '../../../domain/appleReminders';
import type { Task, TaskPatch } from '../../../domain/model';
import type { TaskId } from '../../../domain/types';
import { t } from '../../../i18n';
import { useNoticeStore } from '../../app/notice';
import type { TaskUseCaseDeps, TaskUseCases } from '../../tasks/taskUseCases';

/**
 * Garde des tâches liées à un rappel Apple RÉCURRENT (ADR 0008 §10.6) : « aucune écriture sur une série » EventKit. Dans CircleTasks, sur PC
 * comme sur iPhone, la case (terminer, rouvrir), le titre, la date, l'heure et la suppression d'une telle tâche sont refusés avec le message
 * « Modifiez ce rappel récurrent dans Rappels ». Un seul point de passage : les cas d'usage de tâches (fiche, listes, balayages A-07, lot A-05,
 * Semaine, « Un jour »). Le refus est un message (5 s, comme « Ajouté dans Perso ») et une absence d'écriture : jamais une erreur technique ;
 * les autres champs (note, icône, projet, objectif, espace, rappels CircleTasks) restent modifiables.
 */

/** Champs de la tâche qui reviendraient à Rappels. */
const LOCKED_KEYS: readonly (keyof TaskPatch)[] = ['title', 'date', 'time', 'someday', 'status', 'doneAt'];

const hasLockedKey = (patch: TaskPatch): boolean => LOCKED_KEYS.some((key) => key in patch && patch[key] !== undefined);

function withoutLockedKeys(patch: TaskPatch): TaskPatch {
  const locked = new Set<string>(LOCKED_KEYS);
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !locked.has(key))) as TaskPatch;
}

/** Message de refus (global, 5 s). */
export function refuseRecurringEdit(): void {
  useNoticeStore.getState().show(t('appleReminders.recurringRefused'));
}

export function withAppleGuards(base: TaskUseCases, deps: TaskUseCaseDeps): TaskUseCases {
  const read = async (id: TaskId): Promise<Task | null> => deps.data.repos.tasks.getById(id);
  /** Sépare les identifiants libres de ceux d'une tâche verrouillée ; un refus est annoncé une seule fois. */
  const allowed = async (ids: readonly TaskId[]): Promise<TaskId[]> => {
    if (ids.length === 0) return [];
    const tasks = await deps.data.repos.tasks.listByIds(ids);
    const locked = new Set(tasks.filter((task) => isAppleRecurringLocked(task)).map((task) => task.id));
    if (locked.size === 0) return [...ids];
    refuseRecurringEdit();
    return ids.filter((id) => !locked.has(id));
  };

  return {
    ...base,
    async complete(id) {
      const task = await read(id);
      if (task && isAppleRecurringLocked(task)) {
        refuseRecurringEdit();
        deps.taskEntities.publish([task]);
        return task;
      }
      return base.complete(id);
    },
    async reopen(id) {
      const task = await read(id);
      if (task && isAppleRecurringLocked(task)) {
        refuseRecurringEdit();
        deps.taskEntities.publish([task]);
        return task;
      }
      return base.reopen(id);
    },
    async update(id, patch) {
      if (!hasLockedKey(patch)) return base.update(id, patch);
      const task = await read(id);
      if (!task || !isAppleRecurringLocked(task)) return base.update(id, patch);
      refuseRecurringEdit();
      const rest = withoutLockedKeys(patch);
      if (Object.keys(rest).length === 0) {
        deps.taskEntities.publish([task]);
        return task;
      }
      return base.update(id, rest);
    },
    async updateWithReminders(id, patch, offsets) {
      if (!hasLockedKey(patch)) return base.updateWithReminders(id, patch, offsets);
      const task = await read(id);
      if (!task || !isAppleRecurringLocked(task)) return base.updateWithReminders(id, patch, offsets);
      refuseRecurringEdit();
      return base.updateWithReminders(id, withoutLockedKeys(patch), offsets);
    },
    async postpone(ids, target) {
      return base.postpone(await allowed(ids), target);
    },
    async moveToDay(id, date) {
      const task = await read(id);
      if (task && isAppleRecurringLocked(task)) {
        refuseRecurringEdit();
        deps.taskEntities.publish([task]);
        return task;
      }
      return base.moveToDay(id, date);
    },
    async scheduleSomeday(ids, target) {
      return base.scheduleSomeday(await allowed(ids), target);
    },
    async moveToSomeday(ids) {
      return base.moveToSomeday(await allowed(ids));
    },
    async remove(ids, options) {
      return base.remove(await allowed(ids), options);
    },
    async setRecurrence(id, rule) {
      // Une tâche liée à un rappel (ou à créer dans Rappels) ne reçoit pas de répétition CircleTasks (ADR 0008 §10.2, « Copies »).
      const task = await read(id);
      if (task && ['linked', 'to-create'].includes(appleLinkState(task))) return { ok: false, error: 'apple-linked' };
      return base.setRecurrence(id, rule);
    },
  };
}
