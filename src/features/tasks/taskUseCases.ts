import type { IconRef, ReminderOffsetMin, Task, TaskPatch } from '../../domain/model';
import type { GoalId, LocalDate, LocalTime, ProjectId, Result, SpaceId, TaskId } from '../../domain/types';
import type { SortOrderEntry } from '../../db/repositories';
import type { AppContainer } from '../app/container';

/**
 * Contrat des cas d'usage « tâches » (ADR 0004) — implémentation : tasks-planning
 * (`createTaskUseCases(deps)` dans ce dossier), règles pures dans src/domain
 * (domain-logic). Le store Zustand de la feature appelle ces fonctions, jamais les
 * repositories directement.
 *
 * Chaque action annulable (T-13) pousse elle-même sa commande dans `deps.undo`
 * avant de rendre la main : le store n'a rien à faire pour l'annulation.
 */
export type TaskUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>;

export interface CreateTaskInput {
  /** Saisie brute ; trim et validation par src/domain. */
  readonly title: string;
  /** Espace résolu par l'appelant : filtre actif, sinon réglage `spaces.defaultSpaceId` (ES-02). */
  readonly spaceId: SpaceId;
  /** Absent : aujourd'hui (T-01). null avec `someday` : tâche Un jour (SD-01). */
  readonly date?: LocalDate | null;
  readonly time?: LocalTime | null;
  readonly someday?: boolean;
  readonly projectId?: ProjectId | null;
  readonly note?: string;
  readonly icon?: IconRef | null;
  readonly goalId?: GoalId | null;
  /** N-02 : avances choisies dans la fenêtre d'ajout. */
  readonly reminderOffsets?: readonly ReminderOffsetMin[];
}

export type CreateTaskError = 'empty-title' | 'title-too-long' | 'time-without-date';

/** Cible d'un report (T-05, SD-02). */
export type PostponeTarget = 'tomorrow' | 'next-week' | { readonly date: LocalDate };

export interface TaskUseCases {
  /** T-01, T-02, T-03, S-04, SD-01 ; non annulable (on supprime). Tâche + rappels en une transaction. */
  create(input: CreateTaskInput): Promise<Result<Task, CreateTaskError>>;
  /** Fiche détail (A-08) ; non annulable. */
  update(id: TaskId, patch: TaskPatch): Promise<Task>;
  /** T-04 (+ occurrence suivante si récurrente, T-09) ; annulable. */
  complete(id: TaskId): Promise<Task>;
  /** Rouvrir une tâche terminée (Espace sur une tâche faite) ; non annulable. */
  reopen(id: TaskId): Promise<Task>;
  /** T-05, SD-02, A-05 (lot), Ctrl+D ; annulable. */
  postpone(ids: readonly TaskId[], target: PostponeTarget): Promise<Task[]>;
  /** S-02, S-06 : glisser vers un jour ; annulable. */
  moveToDay(id: TaskId, date: LocalDate): Promise<Task>;
  /** SD-03 ; annulable. */
  moveToSomeday(ids: readonly TaskId[]): Promise<Task[]>;
  /** T-12 : copie titre, note, icône, espace, projet, rappels ; annulable. */
  duplicate(id: TaskId, date: LocalDate | null): Promise<Task>;
  /** T-08 : corbeille (rappels compris) ; annulable. */
  remove(ids: readonly TaskId[]): Promise<Task[]>;
  /** A-02, SD-04, Alt+↑/↓ ; non annulable. */
  reorder(entries: readonly SortOrderEntry<TaskId>[]): Promise<void>;
}
