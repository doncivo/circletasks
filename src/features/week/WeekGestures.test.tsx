import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../domain/localDate';
import { createFakeHaptics, type FakeHaptics } from '../../platform/haptics';
import { useNavigationStore } from '../app/navigation';
import { swipeLeft, swipeRight, swipeRowOf, touch } from '../tasks/gestureTestKit';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** A-07 sur la Semaine iPhone : critères 8 (l'appui long reste le glisser), 11 (la ligne, pas la semaine), 14, 16. */

let h: WeekHarness;
let haptics: FakeHaptics;

beforeEach(async () => {
  haptics = createFakeHaptics();
  h = await setupWeek('a076', '2026-10-02T10:00:00.000Z', haptics);
  mockViewport(440);
});
afterEach(() => teardownWeek(h));

const get = (id: string) => h.container.data.repos.tasks.getById(id as never);

describe('Semaine iPhone : gestes de ligne (A-07)', () => {
  it('balayage à droite sur une ligne : terminée, la semaine ne change pas (critère 11)', async () => {
    const task = await seedTask(h, { title: 'Courses' });
    renderWeek(h.container);
    await screen.findByText('Courses');
    const heading = screen.getByRole('heading', { level: 1 }).textContent;
    await act(async () => {
      swipeRight(swipeRowOf(task.id));
    });
    await waitFor(async () => expect((await get(task.id))?.status).toBe('done'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading);
    expect(haptics.calls.at(-1)).toEqual({ type: 'notification', kind: 'success' });
  });

  it('balayage à gauche puis « Reporter » : demain avec Annuler', async () => {
    const task = await seedTask(h, { title: 'Courses' });
    renderWeek(h.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    await act(async () => {
      fireEvent.click(row.querySelector('[data-action="postpone"]') as Element);
    });
    await waitFor(async () => expect((await get(task.id))?.date).toBe(addDays(h.today, 1)));
    expect(await screen.findByRole('status')).toHaveTextContent('reportée à demain');
  });

  it('« Un jour » et « Supprimer » (confirmation) agissent depuis la Semaine', async () => {
    const first = await seedTask(h, { title: 'Courses' });
    const second = await seedTask(h, { title: 'Appeler' });
    renderWeek(h.container);
    await screen.findByText('Courses');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Un jour : Courses' }));
    });
    await waitFor(async () => expect((await get(first.id))?.someday).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Appeler' }));
    const dialog = await screen.findByRole('alertdialog');
    expect((await get(second.id))?.deletedAt ?? null).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    });
    await waitFor(() => expect(screen.queryByText('Appeler')).toBeNull());
  });

  it('l’appui long n’ouvre pas la fiche : il reste le glisser entre jours (critère 8, Q16)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const task = await seedTask(h, { title: 'Courses' });
      renderWeek(h.container);
      await vi.waitFor(() => expect(screen.getByText('Courses')).toBeInTheDocument());
      const row = swipeRowOf(task.id);
      touch(row, 'pointerdown', 100, 30, 0);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(useNavigationStore.getState().detail).toBeNull();
      expect(haptics.calls.some((call) => call.type === 'impact')).toBe(false);
      touch(row, 'pointerup', 100, 30, 620);
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('balayage sur l’en-tête d’un jour : la semaine change (S-03 inchangé, critère 11)', async () => {
    await seedTask(h, { title: 'Courses' });
    renderWeek(h.container);
    await screen.findByText('Courses');
    const heading = screen.getByRole('heading', { level: 1 }).textContent;
    const header = document.querySelector('.ct-week-day__head') as HTMLElement;
    const zone = document.querySelector('.ct-week__days') as HTMLElement;
    zone.getBoundingClientRect = () => ({ width: 400, height: 800, top: 0, left: 0, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    touch(header, 'pointerdown', 350, 30, 0);
    touch(header, 'pointermove', 150, 30, 300);
    touch(header, 'pointerup', 150, 30, 350);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe(heading));
  });

  it('PC : aucune ligne enveloppée (critère 12)', async () => {
    mockViewport(1440);
    await seedTask(h, { title: 'Courses' });
    renderWeek(h.container);
    await screen.findByText('Courses');
    expect(document.querySelector('.ct-swipe-row')).toBeNull();
  });
});
