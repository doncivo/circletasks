import type {
  GoalId,
  IsoDateTime,
  LocalDate,
  LocalTime,
  ProjectId,
  RecurrenceId,
  SpaceId,
  SyncMeta,
  TaskId,
} from '../types';
import type { IconRef } from './icon';

export type TaskStatus = 'todo' | 'done';

/** Origine : saisie dans l'app ou Rappels Apple lus par l'iPhone (K-05, ordre 5). */
export type TaskSource = 'local' | 'apple_reminders';

/**
 * Tâche (M1, M2, M3, M17, M18). Table `task`.
 *
 * Invariants (règles dans src/domain, jamais dans un composant) :
 * - `title` non vide après trim ;
 * - `someday = true` ⇒ `date = null` et `time = null` (M18) ;
 * - `someday = false` et `date = null` : tâche « sans date » hors Un jour (import, capture) ;
 * - `time` non null ⇒ `date` non null ; heure locale flottante (T-11) ;
 * - `status = 'done'` ⇔ `doneAt` non null ;
 * - `carriedOver` : posé par le report automatique de minuit (T-06), badge « reportée » ;
 * - `sortOrder` : réel, ordre manuel dans la liste du jour ou dans Un jour (A-02, SD-04),
 *   insertion par milieu des voisins, renumérotation par domain-logic si l'écart devient trop fin ;
 * - `seriesIndex` : rang de l'occurrence dans sa récurrence (0 pour la première), sinon null ;
 * - `externalId` non null seulement si `source = 'apple_reminders'`.
 */
export interface Task extends SyncMeta {
  readonly id: TaskId;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  /** Note multi-lignes ; chaîne vide si absente. */
  readonly note: string;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly status: TaskStatus;
  readonly doneAt: IsoDateTime | null;
  readonly sortOrder: number;
  readonly carriedOver: boolean;
  readonly recurrenceId: RecurrenceId | null;
  readonly seriesIndex: number | null;
  readonly goalId: GoalId | null;
  readonly icon: IconRef | null;
  readonly someday: boolean;
  readonly source: TaskSource;
  readonly externalId: string | null;
}

/** Champs métier d'une tâche (sans les colonnes de synchro). */
export type TaskFields = Omit<Task, keyof SyncMeta>;

/**
 * Entrée de `TaskRepository.create` : l'identifiant est choisi par le cas d'usage
 * (via `IdGenerator`), les colonnes de synchro par le repository (`WriteStamper`).
 */
export type NewTask = TaskFields & { readonly id: TaskId };

/** Modification partielle d'une tâche ; `id`, `source` et `externalId` sont immuables. */
export type TaskPatch = Partial<Omit<TaskFields, 'source' | 'externalId'>>;
