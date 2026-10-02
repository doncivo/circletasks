import type { GoalProgress, NewRecurrence, NewTask, Recurrence, RecurrencePatch, Task, TaskPatch } from '../../domain/model';
import type {
  GoalId,
  IsoDateTime,
  LocalDate,
  LocalTime,
  ProjectId,
  RecurrenceId,
  SpaceFilter,
  SpaceId,
  TaskId,
} from '../../domain/types';
import type { InstantRange, ReadOptions, SortOrderEntry } from './common';

/**
 * Tâches (M1, M2, M3, M17, M18). Méthodes nommées par cas d'usage ; l'ordre
 * d'affichage final (terminées en bas, heure, ordre manuel) est calculé par
 * src/domain : les listes sont renvoyées triées par `sort_order`, puis `id`.
 */
export interface TaskRepository {
  getById(id: TaskId, options?: ReadOptions): Promise<Task | null>;

  /** T-01, S-04, SD-01. */
  create(task: NewTask): Promise<Task>;
  /** T-12 (duplication), P-07 (import), OB-05 (reconduction). */
  createMany(tasks: readonly NewTask[]): Promise<Task[]>;
  /** Édition depuis la fiche détail (T-02, T-03, OB-03, ES-05). */
  update(id: TaskId, patch: TaskPatch): Promise<Task>;

  /** T-04 : status = done, done_at = doneAt. */
  complete(id: TaskId, doneAt: IsoDateTime): Promise<Task>;
  /** Annulation de T-04 ou rouverture (Espace) : status = todo, done_at = null. */
  reopen(id: TaskId): Promise<Task>;
  /**
   * T-05, S-02, SD-02, A-05 (lot) : nouvelle date (heure conservée sauf `time` fourni),
   * someday = false, carried_over = false.
   */
  reschedule(ids: readonly TaskId[], date: LocalDate, time?: LocalTime | null): Promise<Task[]>;
  /** SD-03 : date et heure retirées, someday = true. */
  moveToSomeday(ids: readonly TaskId[]): Promise<Task[]>;
  /** T-06 : report automatique de minuit, carried_over = true. */
  carryOver(ids: readonly TaskId[], date: LocalDate): Promise<Task[]>;
  /** ES-05 : déplacement d'espace / projet, unitaire ou par lot. */
  moveToSpace(ids: readonly TaskId[], spaceId: SpaceId, projectId: ProjectId | null): Promise<Task[]>;
  /** A-02, SD-04 : ordre manuel persistant. */
  setSortOrders(entries: readonly SortOrderEntry<TaskId>[]): Promise<void>;

  /** T-08 : vers la corbeille (deleted_at). */
  softDelete(ids: readonly TaskId[]): Promise<Task[]>;
  /** Annulation de T-08, restauration depuis la corbeille. */
  restore(ids: readonly TaskId[]): Promise<Task[]>;

  /** A-01 : tâches datées du jour (faites comprises), hors Un jour. */
  listForDay(date: LocalDate, filter: SpaceFilter): Promise<Task[]>;
  /** S-01 : tâches des 7 jours à partir de `weekStart` (lundi), faites comprises. */
  listForWeek(weekStart: LocalDate, filter: SpaceFilter): Promise<Task[]>;
  /** SD-01, SD-04 : tâches someday, filtrables par projet. */
  listSomeday(filter: SpaceFilter, projectId?: ProjectId): Promise<Task[]>;
  /** SD-01 : compteur sur l'icône horloge. */
  countSomeday(filter: SpaceFilter): Promise<number>;
  /** T-06, T-09 : tâches à faire datées avant `date` (tous espaces). */
  listUndoneBefore(date: LocalDate): Promise<Task[]>;
  /** T-07 : tâches terminées dans la plage (sur done_at). */
  listDone(range: InstantRange, filter: SpaceFilter): Promise<Task[]>;
  /** OB-03, OB-05 : tâches rattachées à un objectif. */
  listByGoal(goalId: GoalId): Promise<Task[]>;
  /** OB-04 : avancement de plusieurs objectifs en une requête. */
  progressByGoal(goalIds: readonly GoalId[]): Promise<ReadonlyMap<GoalId, GoalProgress>>;
  /** T-09, T-10 : occurrences d'une récurrence ; `includeDeleted` : corbeille comprise (pas de doublon de série, T-09). */
  listByRecurrence(recurrenceId: RecurrenceId, options?: ReadOptions): Promise<Task[]>;
  /** T-08 : corbeille, tâches supprimées depuis `since` (30 jours) ; hors occurrences retirées par l'annulation d'une complétion (T-09, `series_index` < 0). */
  listTrash(since: IsoDateTime, filter: SpaceFilter): Promise<Task[]>;
  /**
   * T-08 : purge physique des tâches supprimées avant `before` (et de leurs rappels) ; renvoie le
   * nombre de tâches purgées. La date limite est calculée par src/domain/taskTrash (30 jours) ;
   * condition de synchro (tous les appareils ont lu la suppression) : Y-09, ordre 4.
   */
  purgeDeletedBefore(before: IsoDateTime): Promise<number>;
}

/** Règles de récurrence des tâches (T-09, T-10). */
export interface RecurrenceRepository {
  getById(id: RecurrenceId, options?: ReadOptions): Promise<Recurrence | null>;
  create(recurrence: NewRecurrence): Promise<Recurrence>;
  update(id: RecurrenceId, patch: RecurrencePatch): Promise<Recurrence>;
  softDelete(id: RecurrenceId): Promise<Recurrence>;
  restore(id: RecurrenceId): Promise<Recurrence>;
}

