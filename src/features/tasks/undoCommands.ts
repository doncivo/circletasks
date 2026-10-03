import type { Recurrence, Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import type { UndoableCommand } from '../app/undo';
import { UNDONE_OCCURRENCE_INDEX, type CreatedOccurrence } from './recurrenceUseCases';
import { syncTaskReminders } from './reminderSync';
import type { TaskUseCaseDeps } from './taskUseCases';

/**
 * Commandes d'annulation des cas d'usage « tâches » (T-13, ADR 0005) : terminer, reporter, supprimer, dupliquer, réordonner,
 * changer d'espace, supprimer une série. Chacune rend l'inverse de l'action faite : annuler = NOUVELLE écriture (nouveau hlc), et
 * seulement pour les tâches non modifiées depuis (hlc identique à celui écrit par l'action) ; sinon 'stale', rien n'est écrit.
 */

/**
 * Commande annulable d'une complétion (T-04, T-13, ADR 0005) : annuler = rouvrir
 * la tâche, mais seulement si elle n'a pas changé depuis (hlc identique à celui
 * écrit par `complete`) ; sinon 'stale', sans rien écrire.
 *
 * T-09 : si `complete()` a créé l'occurrence suivante d'une récurrence (`next`), annuler la
 * supprime aussi, dans la même transaction, tant qu'elle n'a pas été modifiée depuis (sinon
 * 'stale', rien n'est écrit). Elle est marquée « annulée » (`UNDONE_OCCURRENCE_INDEX`) avant d'aller à
 * la corbeille : elle n'y est pas listée (pas de doublon à restaurer), son effacement reste synchronisé,
 * et terminer à nouveau la tâche recrée l'occurrence suivante (critère 12).
 */
export function createCompleteUndoCommand(deps: TaskUseCaseDeps, completed: Task, wasCarriedOver: boolean, next: CreatedOccurrence | null): UndoableCommand {
  return {
    kind: 'complete',
    count: 1,
    labelParams: { title: completed.title },
    async undo() {
      if (next) {
        const outcome = await deps.data.transaction(async (repos) => {
          const current = await repos.tasks.getById(completed.id);
          if (!current || current.hlc !== completed.hlc) return null;
          const created = await repos.tasks.getById(next.task.id);
          if (created && created.hlc !== next.task.hlc) return null;
          await repos.tasks.reopen(completed.id);
          const reopened = wasCarriedOver ? await repos.tasks.update(completed.id, { carriedOver: true }) : await repos.tasks.getById(completed.id);
          if (created) {
            await repos.tasks.update(created.id, { seriesIndex: UNDONE_OCCURRENCE_INDEX });
            const [removed] = await repos.tasks.softDelete([created.id]);
            await repos.reminders.softDeleteForTarget({ type: 'task', id: created.id }, removed?.deletedAt ?? undefined);
          }
          return { reopened, removedId: created?.id ?? null };
        });
        if (!outcome?.reopened) return 'stale';
        deps.taskEntities.publish([outcome.reopened]);
        if (outcome.removedId) deps.taskEntities.remove([outcome.removedId]);
        return 'undone';
      }
      const current = await deps.data.repos.tasks.getById(completed.id);
      if (!current || current.hlc !== completed.hlc) return 'stale';
      // T-06 : une tâche reportée retrouve son badge (même transaction que la réouverture).
      const reopened = wasCarriedOver
        ? await deps.data.transaction(async (repos) => {
            await repos.tasks.reopen(completed.id);
            return repos.tasks.update(completed.id, { carriedOver: true });
          })
        : await deps.data.repos.tasks.reopen(completed.id);
      deps.taskEntities.publish([reopened]);
      return 'undone';
    },
  };
}

/** État d'une tâche avant et après un report (commande d'annulation, T-05). */
export interface PostponedEntry {
  readonly before: Task;
  readonly after: Task;
}

/**
 * Commande annulable d'un report (T-05, T-13) : annuler = nouvelle écriture qui
 * remet date, heure et « Un jour » d'avant. Une tâche modifiée depuis (hlc différent
 * de celui écrit par le report) n'est pas touchée ; si aucune ne peut l'être : 'stale'.
 */
export function createPostponeUndoCommand(
  deps: TaskUseCaseDeps,
  entries: readonly PostponedEntry[],
  label: Pick<UndoableCommand, 'labelKey' | 'labelParams'>,
  kind: 'postpone' | 'someday' = 'postpone',
): UndoableCommand {
  return {
    kind,
    count: entries.length,
    ...label,
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const { before, after } of entries) {
          const current = await repos.tasks.getById(after.id);
          if (!current || current.hlc !== after.hlc) continue;
          const restoredTask = await repos.tasks.update(before.id, { date: before.date, time: before.time, someday: before.someday, carriedOver: before.carriedOver, seriesTemplate: before.seriesTemplate });
          await syncTaskReminders(repos, restoredTask);
          written.push(restoredTask);
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'une suppression (T-08, T-13) : annuler = nouvelle écriture qui
 * sort la tâche de la corbeille (date, ordre, espace inchangés) et réactive ses rappels.
 * Une tâche modifiée depuis (hlc différent de celui écrit par la suppression, ex. déjà
 * restaurée ou purgée) n'est pas touchée ; si aucune ne peut l'être : 'stale'.
 */
export function createDeleteUndoCommand(deps: TaskUseCaseDeps, deleted: readonly Task[]): UndoableCommand {
  const first = deleted[0];
  return {
    kind: 'delete',
    count: deleted.length,
    ...(deleted.length === 1 && first
      ? { labelParams: { title: first.title } }
      : { labelKey: 'undo.deleteMany' as const, labelParams: { count: deleted.length } }),
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const task of deleted) {
          const current = await repos.tasks.getById(task.id, { includeDeleted: true });
          if (!current || current.deletedAt === null || current.hlc !== task.hlc) continue;
          const [back] = await repos.tasks.restore([task.id]);
          await repos.reminders.restoreForTarget({ type: 'task', id: task.id }, { deletedAt: current.deletedAt, hlc: current.hlc });
          if (back) written.push(back);
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'une duplication (T-12, T-13) : annuler = supprimer la copie (et ses rappels), tant qu'elle
 * n'a pas été modifiée depuis (hlc identique à celui écrit par la duplication) ; sinon 'stale'. Comme pour l'occurrence
 * annulée de T-09, la copie est écartée (`discard`) : tombstone conservé pour la synchro, exclue de la corbeille
 * (rien à restaurer). Elle n'appartient à aucune série : aucun `series_index` n'est touché.
 */
export function createDuplicateUndoCommand(deps: TaskUseCaseDeps, copy: Task): UndoableCommand {
  return {
    kind: 'duplicate',
    count: 1,
    labelParams: { title: copy.title },
    async undo() {
      const removed = await deps.data.transaction(async (repos) => {
        const current = await repos.tasks.getById(copy.id);
        if (!current || current.hlc !== copy.hlc) return false;
        const [gone] = await repos.tasks.discard([copy.id]);
        await repos.reminders.softDeleteForTarget({ type: 'task', id: copy.id }, gone?.deletedAt ?? undefined);
        return true;
      });
      if (!removed) return 'stale';
      deps.taskEntities.remove([copy.id]);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'un réordonnancement (A-02, T-13) : annuler = nouvelle écriture qui rétablit les `sortOrder`
 * d'avant, pour les seules tâches non modifiées depuis (hlc identique à celui écrit par le déplacement) ; si
 * aucune ne peut l'être : 'stale', rien n'est écrit.
 */
export function createReorderUndoCommand(deps: TaskUseCaseDeps, entries: readonly PostponedEntry[]): UndoableCommand {
  return {
    kind: 'move',
    count: 1,
    labelKey: 'undo.move',
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const writable = [];
        for (const { before, after } of entries) {
          const current = await repos.tasks.getById(after.id);
          if (current && current.hlc === after.hlc) writable.push({ id: before.id, sortOrder: before.sortOrder });
        }
        if (writable.length === 0) return [];
        await repos.tasks.setSortOrders(writable);
        const written: Task[] = [];
        for (const entry of writable) {
          const back = await repos.tasks.getById(entry.id);
          if (back) written.push(back);
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'un changement d'espace / projet (A-05, T-13) : annuler = nouvelle écriture qui remet l'espace,
 * le projet et le gabarit de série d'avant, pour les seules tâches non modifiées depuis (hlc identique) ; sinon 'stale'.
 */
export function createMoveUndoCommand(deps: TaskUseCaseDeps, entries: readonly PostponedEntry[], destination = ''): UndoableCommand {
  const first = entries[0];
  return {
    kind: 'move',
    count: entries.length,
    // « « Facture » déplacée dans Perso » ; plusieurs : « 2 tâches déplacées dans Perso » (ES-05 critère 5).
    ...(entries.length === 1 && first
      ? { labelKey: 'undo.moveSpace' as const, labelParams: { title: first.before.title, space: destination } }
      : { labelKey: 'undo.manyMoveSpace' as const, labelParams: { count: entries.length, space: destination } }),
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const { before, after } of entries) {
          const current = await repos.tasks.getById(after.id);
          if (!current || current.hlc !== after.hlc) continue;
          written.push(await repos.tasks.update(before.id, { spaceId: before.spaceId, projectId: before.projectId, seriesTemplate: before.seriesTemplate }));
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

export interface RuleChange {
  readonly before: Recurrence;
  readonly after: Recurrence;
}

/**
 * Annulation d'une suppression de série : remet les tâches supprimées (corbeille, rappels), la règle
 * si la série était arrêtée, et retire l'occurrence suivante générée par la suppression (marquée
 * « annulée » comme pour T-09, pour qu'elle ne soit ni restaurable ni dupliquée) tant qu'elle n'a pas changé.
 */
export function createRemoveUndo(deps: TaskUseCaseDeps, deleted: readonly Task[], nexts: readonly CreatedOccurrence[], rule: RuleChange | null): UndoableCommand {
  const first = deleted[0];
  return {
    kind: 'delete',
    count: deleted.length,
    ...(deleted.length === 1 && first
      ? { labelParams: { title: first.title } }
      : { labelKey: 'undo.deleteMany' as const, labelParams: { count: deleted.length } }),
    async undo() {
      const outcome = await deps.data.transaction(async (repos) => {
        for (const next of nexts) {
          const created = await repos.tasks.getById(next.task.id);
          if (created && created.hlc !== next.task.hlc) return null;
        }
        const restored: Task[] = [];
        for (const task of deleted) {
          const current = await repos.tasks.getById(task.id, { includeDeleted: true });
          if (!current || current.deletedAt === null || current.hlc !== task.hlc) continue;
          const [back] = await repos.tasks.restore([task.id]);
          await repos.reminders.restoreForTarget({ type: 'task', id: task.id }, { deletedAt: current.deletedAt, hlc: current.hlc });
          if (back) restored.push(back);
        }
        if (restored.length === 0) return null;
        if (rule) {
          const stored = await repos.recurrences.getById(rule.after.id, { includeDeleted: true });
          if (stored && stored.hlc === rule.after.hlc) await repos.recurrences.restore(rule.after.id);
        }
        const removedIds: TaskId[] = [];
        for (const next of nexts) {
          const created = await repos.tasks.getById(next.task.id);
          if (created) {
            await repos.tasks.update(created.id, { seriesIndex: UNDONE_OCCURRENCE_INDEX });
            const [removed] = await repos.tasks.softDelete([created.id]);
            await repos.reminders.softDeleteForTarget({ type: 'task', id: created.id }, removed?.deletedAt ?? undefined);
            removedIds.push(created.id);
          }
        }
        return { restored, removedIds };
      });
      if (!outcome) return 'stale';
      deps.taskEntities.publish(outcome.restored);
      if (outcome.removedIds.length > 0) deps.taskEntities.remove(outcome.removedIds);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'un déplacement vers un autre jour (S-02, T-13) : annuler = nouvelle écriture qui remet date, « Un jour »,
 * badge « reportée », ordre manuel et gabarit de série d'avant, tant que la tâche n'a pas changé depuis (hlc identique à celui
 * écrit par le déplacement) ; sinon 'stale', rien n'est écrit. L'heure et l'espace ne changent pas au déplacement.
 */
export function createMoveDayUndoCommand(deps: TaskUseCaseDeps, before: Task, after: Task, dateLabel: string): UndoableCommand {
  return {
    kind: 'move',
    count: 1,
    labelKey: 'undo.moveDate',
    labelParams: { title: before.title, date: dateLabel },
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const current = await repos.tasks.getById(after.id);
        if (!current || current.hlc !== after.hlc) return null;
        const back = await repos.tasks.update(before.id, {
          date: before.date,
          someday: before.someday,
          carriedOver: before.carriedOver,
          sortOrder: before.sortOrder,
          seriesTemplate: before.seriesTemplate,
        });
        await syncTaskReminders(repos, back);
        return back;
      });
      if (!restored) return 'stale';
      deps.taskEntities.publish([restored]);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'une planification depuis « Un jour » (SD-02, S-06, T-13) : annuler = nouvelle écriture qui remet les tâches
 * dans « Un jour » à leur position d'avant (date et heure retirées, `sortOrder`, badge et gabarit de série d'avant), tant qu'elles
 * n'ont pas changé depuis (hlc identique à celui écrit par la planification) ; sinon 'stale', rien n'est écrit pour elles.
 */
export function createScheduleSomedayUndoCommand(deps: TaskUseCaseDeps, entries: readonly PostponedEntry[], label: Pick<UndoableCommand, 'labelKey' | 'labelParams'>): UndoableCommand {
  return {
    kind: 'schedule',
    count: entries.length,
    ...label,
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const { before, after } of entries) {
          const current = await repos.tasks.getById(after.id);
          if (!current || current.hlc !== after.hlc) continue;
          const back = await repos.tasks.update(before.id, {
            date: before.date,
            time: before.time,
            someday: before.someday,
            sortOrder: before.sortOrder,
            carriedOver: before.carriedOver,
            seriesTemplate: before.seriesTemplate,
          });
          await syncTaskReminders(repos, back);
          written.push(back);
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}
