import { render } from '@testing-library/react';
import type { Routine, RoutineFields, RoutineLog } from '../../domain/model';
import { newEntityId } from '../../domain/id';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate, RoutineId, RoutineLogId } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { RoutinesScreen } from './RoutinesScreen';

/** Aides des tests d'écran Routines : mêmes briques que l'écran Aujourd'hui (base en mémoire, conteneur), routines et validations posées en base. */
export { mockViewport, setupToday as setupRoutines, teardownToday as teardownRoutines };
export type { TodayHarness as RoutinesHarness };

export function renderRoutines(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <RoutinesScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

/** Crée une routine (tous les jours, Pro, départ au 1er sept. 2026 par défaut) directement en base. */
export async function seedRoutine(h: TodayHarness, overrides: Partial<RoutineFields> = {}): Promise<Routine> {
  h.db.clock.advance(1);
  return h.container.data.repos.routines.create({
    id: newEntityId<RoutineId>(h.container.ids),
    spaceId: SPACE_PRO_ID,
    title: 'Faire mon lit',
    icon: null,
    scheduleType: 'daily',
    weekdays: [],
    timesPerWeek: null,
    interval: null,
    startDate: '2026-09-01' as LocalDate,
    time: null,
    paused: false,
    archived: false,
    ...overrides,
  });
}

/** Valide une routine pour `date` directement en base. */
export async function seedLog(h: TodayHarness, routine: Pick<Routine, 'id'>, date: string): Promise<RoutineLog> {
  h.db.clock.advance(1);
  return h.container.data.repos.routineLogs.markDone(
    routine.id as RoutineId,
    date as LocalDate,
    new Date(h.db.clock.nowMs()).toISOString() as never,
    newEntityId<RoutineLogId>(h.container.ids),
  );
}
