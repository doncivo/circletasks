import type { NewRoutine, Routine, RoutineLog, RoutinePatch } from '../../domain/model';
import type { IsoDateTime, LocalDate, RoutineId, RoutineLogId, SpaceFilter } from '../../domain/types';
import type { DateRange, ReadOptions } from './common';

/** Routines (M4). Les occurrences se calculent dans src/domain, jamais en base. */
export interface RoutineRepository {
  getById(id: RoutineId, options?: ReadOptions): Promise<Routine | null>;
  /**
   * Routines du filtre, triées par heure (null en dernier) puis titre.
   * Par défaut : non archivées, en pause comprises (affichées dans l'onglet, R-05).
   */
  listForFilter(filter: SpaceFilter, options?: { readonly includeArchived?: boolean }): Promise<Routine[]>;
  /** R-01, R-07. */
  create(routine: NewRoutine): Promise<Routine>;
  /** R-01, R-02 (édition). */
  update(id: RoutineId, patch: RoutinePatch): Promise<Routine>;
  /** R-05. */
  setPaused(id: RoutineId, paused: boolean): Promise<Routine>;
  /** R-05. */
  setArchived(id: RoutineId, archived: boolean): Promise<Routine>;
  softDelete(id: RoutineId): Promise<Routine>;
  restore(id: RoutineId): Promise<Routine>;
}

/** Validations de routines (R-03, R-04, R-06). Unique (routine_id, date). */
export interface RoutineLogRepository {
  /** A-01, S-01, R-04 : validations des routines du filtre sur la plage. */
  listForRange(range: DateRange, filter: SpaceFilter): Promise<RoutineLog[]>;
  /** R-04, R-06 : historique d'une routine (séries, taux, carte de chaleur). */
  listForRoutine(routineId: RoutineId, range: DateRange): Promise<RoutineLog[]>;
  /**
   * R-03 : valide la routine pour `date`. Si une ligne supprimée existe déjà pour
   * (routine, date), elle est restaurée (même id, nouveau hlc) au lieu d'en créer une.
   * `id` n'est utilisé qu'en cas de création.
   */
  markDone(routineId: RoutineId, date: LocalDate, doneAt: IsoDateTime, id: RoutineLogId): Promise<RoutineLog>;
  /** Annule la validation (suppression logique) ; null si rien n'était validé. */
  unmark(routineId: RoutineId, date: LocalDate): Promise<RoutineLog | null>;
}
