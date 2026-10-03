import { todayLocal } from '../../domain/clock';
import { validateGoalTitle, type GoalTitleError } from '../../domain/goalRules';
import { newEntityId } from '../../domain/id';
import type { Goal, GoalPatch, GoalStatus, IconRef, Task } from '../../domain/model';
import type { GoalId, LocalDate, Result, SpaceId } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import type { PlainMessageKey } from '../../i18n';
import type { UndoableCommand } from '../app/undo';
import type { AppContainer } from '../app/container';
import { emitGoalsChanged } from './goalEvents';

export type GoalUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

export interface NewGoalInput {
  readonly title: string;
  readonly spaceId: SpaceId;
  readonly icon?: IconRef | null;
  /** Lundi visé ; absent : la semaine en cours. */
  readonly weekStart?: LocalDate;
}

export type GoalSaveError = GoalTitleError | 'not-found';

/**
 * Cas d'usage de l'objectif de la semaine (M17) : seuls point d'accès aux repositories pour l'objectif. Chaque écriture annonce le
 * changement (`emitGoalsChanged`) pour que Aujourd'hui, la Semaine et l'écran Objectif se relisent.
 */
export interface GoalUseCases {
  /** OB-01 : crée un objectif de la semaine en cours (ou `weekStart`), ouvert et épinglé (OB-02 critère 8). */
  create(input: NewGoalInput): Promise<Result<Goal, GoalTitleError>>;
  /** OB-01 critère 5 : titre validé (1 à 200 caractères) ; l'ancien titre est conservé s'il est refusé. */
  setTitle(id: GoalId, title: string): Promise<Result<Goal, GoalSaveError>>;
  /** OB-01 critères 4 et 5, OB-02 : icône, espace, épinglage. */
  update(id: GoalId, patch: Pick<GoalPatch, 'icon' | 'spaceId' | 'pinned'>): Promise<Goal | null>;
  /** OB-04 critères 5 et 6 : marque l'objectif atteint (`achieved`) ou le rouvre (`open`) ; action manuelle seulement. */
  setStatus(id: GoalId, status: Extract<GoalStatus, 'open' | 'achieved'>): Promise<Goal | null>;
  /** OB-01 critère 7 : supprime l'objectif ; ses tâches perdent le rattachement mais restent ; annulable 5 s. */
  remove(id: GoalId): Promise<boolean>;
}

const SAVE_ERROR_KEYS: Readonly<Record<GoalTitleError, PlainMessageKey>> = {
  'empty-title': 'goals.saveError',
  'title-too-long': 'goals.titleTooLong',
};

/** Message d'erreur d'un titre refusé (le champ revient à l'ancien titre). */
export function goalTitleErrorKey(error: GoalTitleError): PlainMessageKey {
  return SAVE_ERROR_KEYS[error];
}

export function createGoalUseCases(deps: GoalUseCaseDeps): GoalUseCases {
  const { data } = deps;

  return {
    async create(input) {
      const title = validateGoalTitle(input.title);
      if (!title.ok) return title;
      const weekStart = input.weekStart ?? weekStartOf(todayLocal(deps.clock));
      const goal = await data.repos.goals.create({
        id: newEntityId<GoalId>(deps.ids),
        spaceId: input.spaceId,
        weekStart,
        title: title.value,
        icon: input.icon ?? null,
        pinned: true,
        status: 'open',
        carriedFromId: null,
      });
      emitGoalsChanged(data);
      return { ok: true, value: goal };
    },

    async setTitle(id, raw) {
      const title = validateGoalTitle(raw);
      if (!title.ok) return title;
      const current = await data.repos.goals.getById(id);
      if (!current) return { ok: false, error: 'not-found' };
      if (current.title === title.value) return { ok: true, value: current };
      const goal = await data.repos.goals.update(id, { title: title.value });
      emitGoalsChanged(data);
      return { ok: true, value: goal };
    },

    async update(id, patch) {
      const current = await data.repos.goals.getById(id);
      if (!current) return null;
      const goal = await data.repos.goals.update(id, patch);
      emitGoalsChanged(data);
      return goal;
    },

    async setStatus(id, status) {
      const current = await data.repos.goals.getById(id);
      if (!current || current.status === 'closed') return null;
      if (current.status === status) return current;
      const goal = await data.repos.goals.setStatus(id, status);
      emitGoalsChanged(data);
      return goal;
    },

    async remove(id) {
      const removed = await data.transaction(async (repos) => {
        const goal = await repos.goals.getById(id);
        if (!goal) return null;
        const detached: Task[] = [];
        for (const task of await repos.tasks.listByGoal(id)) detached.push(await repos.tasks.update(task.id, { goalId: null }));
        const deleted = await repos.goals.softDelete(id);
        return { goal, deleted, detached };
      });
      if (!removed) return false;
      deps.taskEntities.publish(removed.detached);
      deps.undo.push(removedCommand(deps, removed.goal, removed.deleted, removed.detached));
      emitGoalsChanged(data);
      return true;
    },
  };
}

/** Annulation d'une suppression : l'objectif revient, avec les tâches qui n'ont pas changé depuis (hlc identique). */
function removedCommand(deps: GoalUseCaseDeps, goal: Goal, deleted: Goal, detached: readonly Task[]): UndoableCommand {
  return {
    kind: 'goal',
    count: 1,
    labelKey: 'goals.undo.deleted',
    labelParams: { title: goal.title },
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const current = await repos.goals.getById(goal.id, { includeDeleted: true });
        if (!current || current.hlc !== deleted.hlc) return null;
        await repos.goals.restore(goal.id);
        const tasks: Task[] = [];
        for (const task of detached) {
          const now = await repos.tasks.getById(task.id);
          if (now && now.hlc === task.hlc) tasks.push(await repos.tasks.update(task.id, { goalId: goal.id }));
        }
        return tasks;
      });
      if (!restored) return 'stale';
      deps.taskEntities.publish(restored);
      emitGoalsChanged(deps.data);
      return 'undone';
    },
  };
}


