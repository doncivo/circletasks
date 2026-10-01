import { todayLocal } from '../../domain/clock';
import { newEntityId } from '../../domain/id';
import type { NewTask, Task } from '../../domain/model';
import { validateTaskTitle } from '../../domain/taskRules';
import type { Result, TaskId } from '../../domain/types';
import { NotImplementedError } from '../../db/repositories';
import type { CreateTaskError, TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

/**
 * Implémentation des cas d'usage « tâches » (contrat : `./taskUseCases.ts`, ADR 0004).
 *
 * T-01 livre `create` seul : les autres méthodes sont posées par leur story
 * (commentaires du contrat) et lèvent `NotImplementedError` d'ici là, sur le même
 * modèle que `createPendingRepositories` (ADR 0004).
 */
export function createTaskUseCases(deps: TaskUseCaseDeps): TaskUseCases {
  return {
    async create(input): Promise<Result<Task, CreateTaskError>> {
      const titleResult = validateTaskTitle(input.title);
      if (!titleResult.ok) return titleResult;

      const someday = input.someday ?? false;
      // Absent : aujourd'hui (T-01) ; null avec someday : tâche « Un jour » (SD-01).
      const date = someday ? null : (input.date !== undefined ? input.date : todayLocal(deps.clock));
      const time = input.time ?? null;
      if (time && !date) return { ok: false, error: 'time-without-date' };

      const newTask: NewTask = {
        id: newEntityId<TaskId>(deps.ids),
        spaceId: input.spaceId,
        projectId: input.projectId ?? null,
        title: titleResult.value,
        note: input.note ?? '',
        date,
        time,
        status: 'todo',
        doneAt: null,
        // Ordre manuel réel posé par A-02 ; une création s'ajoute à la fin par
        // horodatage croissant, en attendant l'algorithme d'insertion par milieu.
        sortOrder: deps.clock.nowMs(),
        carriedOver: false,
        recurrenceId: null,
        seriesIndex: null,
        goalId: input.goalId ?? null,
        icon: input.icon ?? null,
        someday,
        source: 'local',
        externalId: null,
      };
      const created = await deps.data.repos.tasks.create(newTask);
      return { ok: true, value: created };
    },

    update() {
      return Promise.reject(new NotImplementedError('taskUseCases.update : à implémenter (T-02, T-03, A-08)'));
    },
    complete() {
      return Promise.reject(new NotImplementedError('taskUseCases.complete : à implémenter (T-04)'));
    },
    reopen() {
      return Promise.reject(new NotImplementedError('taskUseCases.reopen : à implémenter (T-04)'));
    },
    postpone() {
      return Promise.reject(new NotImplementedError('taskUseCases.postpone : à implémenter (T-05, SD-02, A-05)'));
    },
    moveToDay() {
      return Promise.reject(new NotImplementedError('taskUseCases.moveToDay : à implémenter (S-02, S-06)'));
    },
    moveToSomeday() {
      return Promise.reject(new NotImplementedError('taskUseCases.moveToSomeday : à implémenter (SD-03)'));
    },
    duplicate() {
      return Promise.reject(new NotImplementedError('taskUseCases.duplicate : à implémenter (T-12)'));
    },
    remove() {
      return Promise.reject(new NotImplementedError('taskUseCases.remove : à implémenter (T-08)'));
    },
    reorder() {
      return Promise.reject(new NotImplementedError('taskUseCases.reorder : à implémenter (A-02, SD-04)'));
    },
  };
}
