import { render } from '@testing-library/react';
import { newEntityId } from '../../domain/id';
import type { Goal, GoalFields } from '../../domain/model';
import type { GoalId, LocalDate } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { GoalsScreen } from './GoalsScreen';

/** Aides des tests de l'objectif de la semaine : mêmes briques que l'écran Aujourd'hui (base en mémoire, conteneur). */
export { mockViewport, setupToday as setupGoals, teardownToday as teardownGoals };
export type { TodayHarness as GoalsHarness };

export function renderGoals(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <GoalsScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

/** Crée un objectif directement en base (semaine en cours par défaut, épinglé, Pro). */
export async function seedGoal(h: TodayHarness, overrides: Partial<GoalFields> = {}): Promise<Goal> {
  h.db.clock.advance(1);
  return h.container.data.repos.goals.create({
    id: newEntityId<GoalId>(h.container.ids),
    spaceId: SPACE_PRO_ID,
    weekStart: '2026-09-28' as LocalDate,
    title: 'Finaliser le PRD CircleTasks',
    icon: null,
    pinned: true,
    status: 'open',
    carriedFromId: null,
    ...overrides,
  });
}
