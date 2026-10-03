import { render } from '@testing-library/react';
import type { Task } from '../../domain/model';
import type { ProjectId, SpaceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { SomedayScreen } from './SomedayScreen';

/** Aides des tests de « Un jour » : mêmes briques que l'écran Aujourd'hui (base en mémoire, conteneur, viewport simulé). */
export { mockViewport, setupToday as setupSomeday, teardownToday as teardownSomeday };
export type { TodayHarness as SomedayHarness };

export function renderSomeday(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <SomedayScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

export interface SeedSomeday {
  readonly title: string;
  readonly spaceId?: SpaceId;
  readonly projectId?: ProjectId;
}

/** Crée une tâche « Un jour » par le cas d'usage (en tête de liste, comme l'écran) ; l'horloge avance de 1 ms. */
export async function seedSomeday(h: TodayHarness, seed: SeedSomeday): Promise<Task> {
  h.db.clock.advance(1);
  const result = await createTaskUseCases(h.container).create({
    title: seed.title,
    spaceId: seed.spaceId ?? SPACE_PRO_ID,
    ...(seed.projectId ? { projectId: seed.projectId } : {}),
    date: null,
    someday: true,
  });
  if (!result.ok) throw new Error(`création impossible : ${result.error}`);
  return result.value;
}
