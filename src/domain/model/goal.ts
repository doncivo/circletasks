import type { GoalId, LocalDate, SpaceId, SyncMeta } from '../types';
import type { IconRef } from './icon';

export type GoalStatus = 'open' | 'achieved' | 'closed';

/**
 * Objectif de la semaine (M17). Table `goal`. Plusieurs objectifs possibles par
 * semaine (OB-01) ; les tâches s'y rattachent par `task.goal_id` (OB-03).
 * - `weekStart` : lundi de la semaine visée ;
 * - `carriedFromId` : objectif de la semaine précédente reconduit (OB-05).
 */
export interface Goal extends SyncMeta {
  readonly id: GoalId;
  readonly spaceId: SpaceId;
  readonly weekStart: LocalDate;
  readonly title: string;
  readonly icon: IconRef | null;
  readonly pinned: boolean;
  readonly status: GoalStatus;
  readonly carriedFromId: GoalId | null;
}

export type GoalFields = Omit<Goal, keyof SyncMeta>;
export type NewGoal = GoalFields & { readonly id: GoalId };
export type GoalPatch = Partial<GoalFields>;

/** Avancement affiché (OB-04) : tâches rattachées faites / total. */
export interface GoalProgress {
  readonly done: number;
  readonly total: number;
}
