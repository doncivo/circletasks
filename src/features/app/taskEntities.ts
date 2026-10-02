import type { Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import { compareHlc } from '../../domain/hlc';

/**
 * Source unique des tâches chargées (ADR 0004, avenant « Source unique des tâches
 * chargées »). Les cas d'usage y publient TOUTE `Task` qu'ils lisent ou écrivent
 * (création, mise à jour, terminer / rouvrir, annulation) ; les stores d'écran
 * (Aujourd'hui, fiche détail, demain Semaine et Un jour) ne gardent que des ids et
 * des ordres, et lisent les entités ici. Une tâche modifiée depuis un écran est donc
 * à jour partout, sans synchronisation entre stores.
 */
export interface TaskEntities {
  get(id: TaskId): Task | undefined;
  /** Publie des tâches ; une entité plus ancienne (hlc inférieur) n'écrase pas une plus récente. */
  publish(tasks: readonly Task[]): void;
  /** Retire des entités (corbeille, T-08) ; les stores d'écran retirent aussi leurs ids. */
  remove(ids: readonly TaskId[]): void;
  getSnapshot(): ReadonlyMap<TaskId, Task>;
  /** Compatible `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
}

export function createTaskEntities(): TaskEntities {
  let entities: ReadonlyMap<TaskId, Task> = new Map<TaskId, Task>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    get: (id) => entities.get(id),
    publish: (tasks) => {
      let next: Map<TaskId, Task> | null = null;
      for (const task of tasks) {
        const existing = (next ?? entities).get(task.id);
        if (existing && compareHlc(existing.hlc, task.hlc) > 0) continue;
        if (existing === task) continue;
        next ??= new Map<TaskId, Task>(entities);
        next.set(task.id, task);
      }
      if (!next) return;
      entities = next;
      emit();
    },
    remove: (ids) => {
      if (!ids.some((id) => entities.has(id))) return;
      const next = new Map<TaskId, Task>(entities);
      for (const id of ids) next.delete(id);
      entities = next;
      emit();
    },
    getSnapshot: () => entities,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
