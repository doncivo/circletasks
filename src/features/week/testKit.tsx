import { render } from '@testing-library/react';
import { UndoToast } from '../app/UndoToast';
import { AppContainerProvider } from '../app/AppContainerContext';
import type { AppContainer } from '../app/container';
import { WeekScreen } from './WeekScreen';

export { mockViewport, seedTask, setupToday as setupWeek, teardownToday as teardownWeek, type TodayHarness as WeekHarness } from '../today/testKit';

/** Rend la Semaine avec le bandeau « Annuler » global (comme la coquille de l'app). */
export function renderWeek(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <WeekScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}
