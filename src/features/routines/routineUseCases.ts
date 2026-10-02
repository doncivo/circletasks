import { newEntityId } from '../../domain/id';
import type { Routine, RoutineFields } from '../../domain/model';
import { validateRoutine, type RoutineError } from '../../domain/routineRules';
import type { Result, RoutineId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Cas d'usage « routines » (ADR 0004) : les stores appellent ces fonctions, jamais les repositories directement. Les règles
 * (titre, fréquence, bornes de N) sont dans src/domain (`validateRoutine`) ; aucune occurrence n'est écrite d'avance : seules
 * les validations iront dans `routine_log` (R-03).
 */
export type RoutineUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>;

export interface RoutineUseCases {
  /** R-01, R-07 : crée une routine. */
  create(fields: RoutineFields): Promise<Result<Routine, RoutineError>>;
  /** R-01, R-02, R-07 : enregistre le formulaire d'une routine existante ; les validations passées sont conservées. */
  update(id: RoutineId, fields: RoutineFields): Promise<Result<Routine, RoutineError>>;
}

export function createRoutineUseCases(deps: RoutineUseCaseDeps): RoutineUseCases {
  return {
    async create(fields) {
      const checked = validateRoutine(fields);
      if (!checked.ok) return checked;
      const created = await deps.data.repos.routines.create({ ...checked.value, id: newEntityId<RoutineId>(deps.ids) });
      return { ok: true, value: created };
    },

    async update(id, fields) {
      const checked = validateRoutine(fields);
      if (!checked.ok) return checked;
      return { ok: true, value: await deps.data.repos.routines.update(id, checked.value) };
    },
  };
}
