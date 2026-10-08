import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../domain/localDate';
import { createFakeHaptics, type FakeHaptics } from '../../platform/haptics';
import { useNavigationStore } from '../app/navigation';
import { swipeLeft, swipeRight, swipeRowOf, touch } from '../tasks/gestureTestKit';
import { mockViewport, renderSomeday, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

/** A-07 sur « Un jour » (iPhone) : critères 1 (terminer), 6 (supprimer), 7 (boutons propres), 8 (fiche), 16 (équivalents). */

let h: SomedayHarness;
let haptics: FakeHaptics;

beforeEach(async () => {
  haptics = createFakeHaptics();
  h = await setupSomeday('a075', '2026-10-02T10:00:00.000Z', haptics);
  mockViewport(440);
});
afterEach(() => teardownSomeday(h));

const get = (id: string) => h.container.data.repos.tasks.getById(id as never);

describe('« Un jour » : gestes de ligne (A-07)', () => {
  it('balayage à droite : la tâche est terminée et quitte la liste (critère 1)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    await act(async () => {
      swipeRight(swipeRowOf(task.id));
    });
    await waitFor(async () => expect((await get(task.id))?.status).toBe('done'));
    expect(haptics.calls.at(-1)).toEqual({ type: 'notification', kind: 'success' });
  });

  it('balayage à gauche : « Aujourd’hui », « Demain », « Date… » et « Supprimer » (D4, critère 7)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    expect(Array.from(row.querySelectorAll('.ct-swipe-row__button')).map((button) => button.textContent)).toEqual(['Aujourd’hui', 'Demain', 'Date…', 'Supprimer']);
    await act(async () => {
      fireEvent.click(row.querySelector('[data-action="tomorrow"]') as Element);
    });
    await waitFor(async () => expect((await get(task.id))?.date).toBe(addDays(h.today, 1)));
  });

  it('« Date… » ouvre le sélecteur de date de l’appareil (T-14)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    fireEvent.click(row.querySelector('[data-action="pick"]') as Element);
    expect(await screen.findByRole('dialog', { name: 'Choisir une date' })).toBeInTheDocument();
  });

  it('« Supprimer » : confirmation habituelle, puis corbeille avec Annuler (critère 6)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    fireEvent.click(row.querySelector('[data-action="delete"]') as Element);
    const dialog = await screen.findByRole('alertdialog');
    expect((await get(task.id))?.deletedAt ?? null).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    });
    await waitFor(() => expect(screen.queryByText('Renouveler le passeport')).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent('supprimée');
  });

  it('équivalent bouton : « Planifier aujourd’hui : … » (SD-02 critère 7)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }));
    });
    await waitFor(async () => expect((await get(task.id))?.date).toBe(h.today));
  });

  it('appui long : la fiche détail s’ouvre avec un retour haptique (critère 8)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
      renderSomeday(h.container);
      await vi.waitFor(() => expect(screen.getByText('Renouveler le passeport')).toBeInTheDocument());
      const row = swipeRowOf(task.id);
      touch(row, 'pointerdown', 100, 30, 0);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: task.id });
      expect(haptics.calls).toEqual([{ type: 'impact', style: 'light' }]);
      touch(row, 'pointerup', 100, 30, 520);
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('PC : aucune ligne enveloppée (critère 12)', async () => {
    mockViewport(1280);
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    await screen.findByText('Renouveler le passeport');
    expect(document.querySelector('.ct-swipe-row')).toBeNull();
  });
});
