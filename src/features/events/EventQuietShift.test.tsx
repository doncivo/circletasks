import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { EventForm } from './EventForm';
import { mockViewport, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

/**
 * N-FIX-04 : le formulaire Événement dit, au moment du choix, qu'un rappel tombe dans la plage silencieuse de l'espace. Aujourd'hui dans les
 * tests : ven. 2 oct. 2026 ; Pro : 19:00 → 08:00 et week-end.
 */
describe('formulaire Événement : rappel dans la plage silencieuse (N-FIX-04)', () => {
  let h: EventsHarness;
  beforeEach(async () => {
    mockViewport(1440);
    h = await setupEvents('f043');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    await teardownEvents(h);
  });

  function open(event: Parameters<typeof EventForm>[0]['event'], initialOffsets: readonly (0 | 1440 | 10080)[]) {
    render(
      <AppContainerProvider container={h.container}>
        <EventForm event={event} spaces={useAppStore.getState().spaces} initialSpaceId={SPACE_PRO_ID} today={asLocalDate('2026-10-02')} initialOffsets={initialOffsets} onSubmit={vi.fn(() => Promise.resolve(true))} onClose={vi.fn()} errorMessage={null} />
      </AppContainerProvider>,
    );
  }

  it('modification : événement Pro mardi 6 octobre 20:00, rappel « À l’heure » : « Rappel décalé au mercredi 08:00 — aucun rappel Pro après 19:00 »', async () => {
    const event = await seedEvent(h, { title: 'Dîner client', date: '2026-10-06', start: '20:00', end: '22:00', reminderOffsets: [0] });
    open(event, [0]);
    expect(await screen.findByRole('status')).toHaveTextContent('Rappel décalé au mercredi 08:00 — aucun rappel Pro après 19:00');
    // Décocher l'avance retire la ligne.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Le jour même' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('création : journée entière un samedi avec « La veille » : le rappel vendredi 09:00 n’est pas couvert, rien ; « À l’heure » samedi 09:00 est décalé au lundi 08:00 par le week-end', async () => {
    open(null, []);
    fireEvent.change(screen.getByLabelText(/Titre/), { target: { value: 'Brocante' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'La veille' }));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Le jour même' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/aucun rappel Pro/);
  });
});
