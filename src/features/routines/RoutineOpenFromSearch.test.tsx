import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderRoutines, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

/** RC-03 critère 3 : une routine trouvée par la recherche ouvre sa fiche (rapport) dans l'onglet Routines ; archivée, elle n'a pas de fiche. */
describe('Routines : fiche ouverte depuis la recherche (RC-03)', () => {
  let h: RoutinesHarness;
  beforeEach(async () => {
    h = await setupRoutines('202');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('la cible de type routine ouvre la fiche de la routine, puis est consommée', async () => {
    const routine = await seedRoutine(h, { title: 'Classer les factures', spaceId: SPACE_PRO_ID });
    useNavigationStore.getState().openDetail({ type: 'routine', id: routine.id });
    renderRoutines(h.container);
    expect(await screen.findByRole('dialog', { name: 'Rapport de la routine' })).toBeInTheDocument();
    expect(useNavigationStore.getState().detail).toBeNull();
  });

  it('une routine archivée n’a pas de fiche : l’onglet s’ouvre sur la section des routines archivées, la cible est consommée', async () => {
    const routine = await seedRoutine(h, { title: 'Ancienne routine', archived: true });
    await act(async () => {
      useNavigationStore.getState().openDetail({ type: 'routine', id: routine.id });
    });
    renderRoutines(h.container);
    await waitFor(() => expect(useNavigationStore.getState().detail).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Rapport de la routine' })).toBeNull();
  });
});
