import type { Goal, GoalPatch, GoalStatus, NewGoal } from '../../domain/model';
import type { GoalId, LocalDate, SpaceFilter } from '../../domain/types';
import type { DateRange, ReadOptions } from './common';

/** Objectifs de la semaine (M17). Avancement : `TaskRepository.progressByGoal`. */
export interface GoalRepository {
  getById(id: GoalId, options?: ReadOptions): Promise<Goal | null>;
  /** OB-01, OB-02 : objectifs de la semaine commençant le lundi `weekStart`. */
  listForWeek(weekStart: LocalDate, filter: SpaceFilter): Promise<Goal[]>;
  /** OB-06 : historique, plage portant sur `week_start`, du plus récent au plus ancien. */
  listHistory(range: DateRange, filter: SpaceFilter): Promise<Goal[]>;
  /** OB-01, OB-05 (reconduction : `carriedFromId` renseigné). */
  create(goal: NewGoal): Promise<Goal>;
  /** OB-01, OB-02 (titre, icône, espace, épinglage). */
  update(id: GoalId, patch: GoalPatch): Promise<Goal>;
  /** OB-04 (atteint), OB-05 (clore). */
  setStatus(id: GoalId, status: GoalStatus): Promise<Goal>;
  softDelete(id: GoalId): Promise<Goal>;
  restore(id: GoalId): Promise<Goal>;
}
