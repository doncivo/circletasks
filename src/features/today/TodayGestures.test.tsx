import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../domain/localDate';
import { createFakeHaptics, type FakeHaptics } from '../../platform/haptics';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { swipeLeft, swipeRight, swipeRowOf, touch } from '../tasks/gestureTestKit';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';

/** A-07 sur Aujourd'hui (iPhone) : critères 1 à 6, 8, 9, 12, 14, 16 à 18. Les gestes appellent les cas d'usage existants. */

let harness: TodayHarness;
let haptics: FakeHaptics;

beforeEach(async () => {
  haptics = createFakeHaptics();
  harness = await setupToday('a077', '2026-10-02T10:00:00.000Z', haptics);
  mockViewport(440);
});

afterEach(async () => {
  await teardownToday(harness);
});

async function taskOf(id: string) {
  return harness.container.data.repos.tasks.getById(id as never);
}

describe('Aujourd’hui : gestes de ligne (A-07)', () => {
  it('balayage à droite : la tâche est terminée par le cas d’usage de T-04, bandeau Annuler, haptique de succès (critères 1, 14)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    await act(async () => {
      swipeRight(row);
    });
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('done'));
    expect(await screen.findByRole('status')).toHaveTextContent('terminée');
    expect(haptics.calls).toEqual([{ type: 'selection' }, { type: 'impact', style: 'medium' }, { type: 'notification', kind: 'success' }]);
    // Annuler : la tâche redevient à faire.
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('todo'));
  });

  it('en deçà du seuil : la ligne revient sans effet (critère 1)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 100, 30, 1000);
    touch(row, 'pointerup', 100, 30, 2000);
    expect((await taskOf(task.id))?.status).toBe('todo');
    expect(haptics.calls).toEqual([]);
  });

  it('tâche terminée : le balayage à droite la rouvre (critère 2)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    await createTaskUseCases(harness.container).complete(task.id);
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 100, 30, 100);
    expect(row.querySelector('.ct-swipe-row__under--right')).toHaveTextContent('Rouvrir');
    await act(async () => {
      touch(row, 'pointerup', 240, 30, 150);
    });
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('todo'));
  });

  it('balayage à gauche puis « Reporter » : demain, message et Annuler (critères 3, 4)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    expect(row).toHaveAttribute('data-open', 'true');
    expect(haptics.calls).toEqual([{ type: 'impact', style: 'light' }]);
    const labels = Array.from(row.querySelectorAll('.ct-swipe-row__button')).map((button) => button.textContent);
    expect(labels).toEqual(['Reporter', 'Un jour', 'Supprimer']);
    await act(async () => {
      fireEvent.click(row.querySelector('[data-action="postpone"]') as Element);
    });
    await waitFor(async () => expect((await taskOf(task.id))?.date).toBe(addDays(harness.today, 1)));
    expect(await screen.findByRole('status')).toHaveTextContent('« Courses » reportée à demain');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await taskOf(task.id))?.date).toBe(harness.today));
  });

  it('« Reporter » sur une occurrence de série pose d’abord le choix de portée (critère 4)', async () => {
    const created = await createTaskUseCases(harness.container).create({
      title: 'Chaque jour',
      spaceId: SPACE_PRO_ID,
      date: harness.today,
      recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } as never,
    });
    if (!created.ok) throw new Error('création impossible');
    renderToday(harness.container);
    await screen.findByText('Chaque jour');
    fireEvent.click(screen.getByRole('button', { name: 'Reporter : Chaque jour' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Cette occurrence' })).toBeInTheDocument();
    expect((await taskOf(created.value.id))?.date).toBe(harness.today);
    // « Un jour » n’est pas proposé pour une tâche répétée (SD-03, QB-11).
    expect(screen.queryByRole('button', { name: 'Un jour : Chaque jour' })).toBeNull();
  });

  it('« Un jour » range la tâche avec Annuler (critère 5)', async () => {
    const task = await seedTask(harness, { title: 'Courses', time: '09:00' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Un jour : Courses' }));
    });
    await waitFor(async () => expect((await taskOf(task.id))?.someday).toBe(true));
    expect((await taskOf(task.id))?.date).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent('Un jour');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await taskOf(task.id))?.someday).toBe(false));
  });

  it('« Supprimer » ouvre la confirmation ; annuler la boîte laisse la ligne intacte ; confirmer supprime avec Annuler (critère 6)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    fireEvent.click(row.querySelector('[data-action="delete"]') as Element);
    expect(row).not.toHaveAttribute('data-open');
    let dialog = await screen.findByRole('alertdialog', { name: 'Supprimer « Courses » ?' });
    expect((await taskOf(task.id))?.deletedAt ?? null).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await taskOf(task.id))?.deletedAt ?? null).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Courses' }));
    dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    });
    await waitFor(() => expect(screen.queryByText('Courses')).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent('« Courses » supprimée');
  });

  it('appui long : la fiche détail s’ouvre avec un retour haptique (critère 8)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const task = await seedTask(harness, { title: 'Courses' });
      renderToday(harness.container);
      await vi.waitFor(() => expect(screen.getByText('Courses')).toBeInTheDocument());
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

  it('mode édition : aucun geste de ligne ni groupe d’actions ; la vue compacte les garde (critère 9)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    expect(screen.getByRole('group', { name: 'Actions : Courses' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
    expect(screen.queryByRole('group', { name: 'Actions : Courses' })).toBeNull();
    const row = swipeRowOf(task.id);
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 250, 30, 100);
    touch(row, 'pointerup', 250, 30, 150);
    expect((await taskOf(task.id))?.status).toBe('todo');
    fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vue compacte' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Actions : Courses' })).toBeInTheDocument());
  });

  it('PC : aucune ligne enveloppée, aucun geste (critère 12)', async () => {
    cleanup();
    mockViewport(1440);
    await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    expect(document.querySelector('.ct-swipe-row')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Actions : Courses' })).toBeNull();
  });

  it('équivalent bouton : « Reporter : Courses » fait le même report que le geste (critère 16)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const listItem = screen.getByText('Courses').closest('[role="listitem"]') as HTMLElement;
    const group = within(listItem).getByRole('group', { name: 'Actions : Courses' });
    // Dans l’ordre de lecture : la case, le titre, puis le groupe d’actions.
    const order = Array.from(listItem.querySelectorAll('[role="checkbox"], .ct-list-row__title, [role="group"]'));
    expect(order.at(-1)).toBe(group);
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Reporter : Courses' }));
    });
    await waitFor(async () => expect((await taskOf(task.id))?.date).toBe(addDays(harness.today, 1)));
  });

  it('échec du cas d’usage : message habituel, tâche inchangée, aucun succès haptique (critère 18)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    vi.spyOn(harness.container.data.repos.tasks, 'complete').mockRejectedValue(new Error('boom'));
    const row = swipeRowOf(task.id);
    await act(async () => {
      swipeRight(row);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de terminer ou rouvrir cette tâche.');
    expect((await taskOf(task.id))?.status).toBe('todo');
    expect(haptics.calls.some((call) => call.type === 'notification')).toBe(false);
    expect(row.querySelector('.ct-swipe-row__under--right')).toBeNull();
  });

  it('échec de « Un jour » : message visible, jamais en silence', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    vi.spyOn(harness.container.data, 'transaction').mockRejectedValue(new Error('boom'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Un jour : Courses' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de ranger cette tâche dans « Un jour ».');
    expect((await taskOf(task.id))?.someday).toBe(false);
  });
});
