import type { IconRef, RecurrenceFields, ReminderOffsetMin, Task, TaskPatch } from '../../domain/model';
import type { PostponeTarget } from '../../domain/taskPostpone';
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
export type TaskUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

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
  /** T-09 : règle de récurrence ; exige une date (pas de « Un jour »). Règle et tâche créées en une transaction. */
  readonly recurrence?: RecurrenceFields;
}

export type CreateTaskError =
  | 'empty-title'
  | 'title-too-long'
  | 'time-without-date'
  | 'recurrence-needs-date'
  | 'recurrence-invalid';

/** Définir une récurrence sur une tâche existante (T-09) ; modifier / arrêter une règle : T-10. */
export type SetRecurrenceError = 'not-found' | 'already-recurrent' | 'needs-date' | 'invalid';

/** N-02 : remplacer les rappels d'une tâche (la tâche doit avoir une date et une heure, QB-07). */
export type SetRemindersError = 'not-found' | 'needs-time';

/** Cible d'un report (T-05, SD-02) : définie dans src/domain/taskPostpone. */
export type { PostponeTarget };

export interface TaskUseCases {
  /** T-01, T-02, T-03, S-04, SD-01 ; non annulable (on supprime). Tâche + rappels en une transaction. */
  create(input: CreateTaskInput): Promise<Result<Task, CreateTaskError>>;
  /**
   * N-02 : remplace les rappels de la tâche par ces avances (valides, sans doublon, triées) ; les existantes sont conservées,
   * les retirées supprimées logiquement. Refus 'needs-time' sans date ou sans heure (aucun rappel sans heure, QB-07), sauf pour
   * un ensemble vide. Rend les avances enregistrées. Aucune notification n'est planifiée (ordre 5, iPhone seulement).
   */
  setReminders(id: TaskId, offsets: readonly ReminderOffsetMin[]): Promise<Result<ReminderOffsetMin[], SetRemindersError>>;
  /** N-02 : champs et rappels de la feuille « Modifier » en une seule transaction ; 'needs-time' ou 'not-found' : rien n'est écrit. */
  updateWithReminders(id: TaskId, patch: TaskPatch, offsets: readonly ReminderOffsetMin[]): Promise<Result<Task, SetRemindersError>>;
  /** T-09 : rend une tâche datée récurrente (règle + `recurrenceId` en une transaction) ; non annulable. */
  setRecurrence(id: TaskId, rule: RecurrenceFields): Promise<Result<Task, SetRecurrenceError>>;
  /**
   * Fiche détail (A-08) ; non annulable. Quand `patch` touche `date`, `time` ou
   * `someday`, les invariants de planification (T-02, `src/domain/taskSchedule`)
   * sont appliqués avant l'écriture : lève `ScheduleInvariantError` si la
   * combinaison est invalide (heure sans date résultante).
   */
  update(id: TaskId, patch: TaskPatch): Promise<Task>;
  /** T-04 (+ occurrence suivante si récurrente, T-09) ; annulable. */
  complete(id: TaskId): Promise<Task>;
  /** Rouvrir une tâche terminée (Espace sur une tâche faite) ; non annulable. */
  reopen(id: TaskId): Promise<Task>;
  /**
   * T-05, SD-02, A-05 (lot), Ctrl+D ; annulable. Les tâches terminées sont ignorées, la date
   * se calcule depuis aujourd'hui (Q4) ; rend les tâches réellement modifiées. Lève `RangeError`
   * si la date choisie n'existe pas.
   */
  postpone(ids: readonly TaskId[], target: PostponeTarget): Promise<Task[]>;
  /** S-02, S-06 : glisser vers un jour ; annulable. */
  moveToDay(id: TaskId, date: LocalDate): Promise<Task>;
  /**
   * A-05 (Déplacer, lot), ES-05 : change l'espace (et le projet, ES-04) des tâches, sans toucher à leur date ; annulable en une
   * fois. Les tâches déjà dans cet espace et ce projet sont ignorées ; rend les tâches réellement modifiées. Une occurrence
   * récurrente déplacée garde les valeurs d'origine pour la suivante (« cette occurrence », T-10).
   */
  moveToSpace(ids: readonly TaskId[], spaceId: SpaceId, projectId: ProjectId | null): Promise<Task[]>;
  /** SD-03 ; annulable. */
  moveToSomeday(ids: readonly TaskId[]): Promise<Task[]>;
  /** T-12 : copie titre, note, icône, espace, projet, rappels ; annulable. */
  duplicate(id: TaskId, date: LocalDate | null): Promise<Task>;
  /**
   * T-08 : corbeille (rappels compris) ; annulable en une fois. `continueSeries` (A-05, suppression par lot) : une occurrence
   * récurrente est supprimée comme « cette occurrence », la suivante est créée ; sinon la série n'est pas touchée (T-10 : le choix
   * « cette occurrence / toutes les suivantes » passe par `createSeriesUseCases`).
   */
  remove(ids: readonly TaskId[], options?: { readonly continueSeries?: boolean }): Promise<Task[]>;
  /** A-02, SD-04, Alt+↑/↓ ; annulable (message « Tâche déplacée », T-13). */
  reorder(entries: readonly SortOrderEntry<TaskId>[]): Promise<void>;
}
