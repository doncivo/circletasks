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

/**
 * Valeurs de la série conservées par une occurrence qui s'en écarte (T-10, « cette occurrence ») :
 * l'occurrence suivante est générée avec elles, pas avec celles de l'occurrence modifiée.
 * `date` : date prévue d'origine, ancre du calcul de la suivante (déplacer une occurrence ne décale pas la série).
 */
export interface SeriesTemplate {
  readonly title: string;
  readonly note: string;
  readonly icon: IconRef | null;
  readonly time: LocalTime | null;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly date: LocalDate | null;
}

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
 * - `seriesTemplate` : non null seulement pour une occurrence modifiée « cette occurrence » (T-10) :
 *   valeurs de la série avant la modification, reprises par l'occurrence suivante ;
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
  readonly seriesTemplate: SeriesTemplate | null;
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
