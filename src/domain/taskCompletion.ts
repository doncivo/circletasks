import type { TaskStatus } from './model';
import type { IsoDateTime } from './types';

/**
 * Règles de complétion d'une tâche (T-04). Invariant du modèle (`task.ts`) :
 * `status = 'done'` ⇔ `doneAt` non null. Les deux types de retour ci-dessous
 * portent cet invariant dans leur forme : il est impossible de construire un
 * état `'done'` sans `doneAt`, ni un état `'todo'` avec un `doneAt`.
 *
 * Ces fonctions sont pures (aucun accès base, aucune horloge lue directement) :
 * l'instant courant est fourni par l'appelant via `nowIso(clock)` (src/domain/clock).
 */
export interface DoneFields {
  readonly status: 'done';
  readonly doneAt: IsoDateTime;
}

export interface TodoFields {
  readonly status: 'todo';
  readonly doneAt: null;
}

/** État de complétion courant d'une tâche. */
export interface CompletionState {
  readonly status: TaskStatus;
  readonly doneAt: IsoDateTime | null;
}

/** Une tâche déjà terminée : terminer à nouveau n'a aucun effet (idempotent). */
export function isCompleted(current: CompletionState): current is DoneFields {
  return current.status === 'done' && current.doneAt !== null;
}

/**
 * Termine une tâche (case cochée, Espace, bouton détail) : `status = 'done'`,
 * `doneAt` = instant courant (critère 1). Idempotent : une tâche déjà terminée
 * garde son `doneAt` d'origine (le cas d'usage n'écrit alors rien et ne pousse
 * aucune commande d'annulation).
 *
 * Point d'extension (T-09, récurrence) : quand la tâche terminée porte une
 * `recurrenceId`, le cas d'usage appelant (`taskUseCases.complete`) devra, après
 * avoir appliqué ce résultat, générer l'occurrence suivante — règle écrite dans
 * `src/domain/recurrence.ts` par T-09, puis annulée avec la même commande
 * (critère 7). Cette fonction reste ignorante de la récurrence.
 */
export function completeTask(current: CompletionState, now: IsoDateTime): DoneFields {
  return isCompleted(current) ? { status: 'done', doneAt: current.doneAt } : { status: 'done', doneAt: now };
}

/**
 * Rouvre une tâche terminée (case décochée, Espace, bouton détail) :
 * `status = 'todo'`, `doneAt = null` (critère 5). Symétrique de `completeTask`.
 */
export function reopenTask(): TodoFields {
  return { status: 'todo', doneAt: null };
}
