import type { Task } from './model';
import { asIsoDateTime, type IsoDateTime } from './types';

/**
 * Corbeille des tâches (T-08, PRD section 6). Fonctions pures : l'instant courant est
 * fourni par l'appelant (`Clock`, jamais `Date.now()` ici).
 *
 * - Une tâche supprimée (`deletedAt` renseigné) reste visible dans la corbeille pendant
 *   30 jours pleins à compter de `deletedAt`.
 * - Point d'extension (Y-09, ordre 4) : la règle de synchro du PRD veut une purge
 *   physique « 30 jours après que tous les appareils connus ont lu la suppression ». À
 *   l'ordre 1 il n'existe qu'un appareil et aucune synchro : on purge 30 jours après
 *   `deletedAt`, jamais plus tôt. Quand Y-09 existera, `isPurgeable` recevra l'état de
 *   lecture des appareils et ne rendra vrai qu'une fois toutes les suppressions lues ; la
 *   corbeille visible, elle, reste bornée à 30 jours (aucune incidence sur l'affichage).
 */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export type TrashCandidate = Pick<Task, 'deletedAt'>;

/** Instant avant lequel une suppression sort de la corbeille : `now` moins 30 jours. */
export function trashCutoff(nowMs: number): IsoDateTime {
  return asIsoDateTime(new Date(nowMs - TRASH_RETENTION_DAYS * DAY_MS).toISOString());
}

/** Dans la corbeille : supprimée, et depuis moins de 30 jours (borne incluse : exactement 30 jours reste visible). */
export function isInTrash(task: TrashCandidate, nowMs: number): boolean {
  return task.deletedAt !== null && task.deletedAt >= trashCutoff(nowMs);
}

/** Purgeable physiquement : supprimée depuis plus de 30 jours (voir le point d'extension Y-09 ci-dessus). */
export function isPurgeable(task: TrashCandidate, nowMs: number): boolean {
  return task.deletedAt !== null && task.deletedAt < trashCutoff(nowMs);
}

/** Corbeille affichée : tâches supprimées depuis moins de 30 jours, de la plus récente à la plus ancienne. */
export function sortTrash<T extends TrashCandidate>(tasks: readonly T[], nowMs: number): T[] {
  return tasks
    .filter((task) => isInTrash(task, nowMs))
    .sort((a, b) => (a.deletedAt === b.deletedAt ? 0 : (a.deletedAt ?? '') < (b.deletedAt ?? '') ? 1 : -1));
}
