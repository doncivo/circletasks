import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { addDays } from '../../domain/localDate';
import type { Routine } from '../../domain/model';
import { asEntityId, asLocalTime, type RoutineId } from '../../domain/types';
import { createFakeHaptics, type FakeHaptics } from '../../platform/haptics';
import { useAppStore } from '../app/appStore';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { swipeLeft, swipeRight, swipeRowOf, touch } from '../tasks/gestureTestKit';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource, type TodaySource } from './todaySources';

/** A-07, passe QA sur Aujourd'hui : annulation en cours, tâche répétée, terminée, routine, échecs, filtre d'espace. */

const ROUTINE_ID = '70000009-0000-4000-8000-000000000000';
let harness: TodayHarness;
let haptics: FakeHaptics;
const unregister: (() => void)[] = [];

beforeEach(async () => {
  haptics = createFakeHaptics();
  harness = await setupToday('a078', '2026-10-02T10:00:00.000Z', haptics);
  mockViewport(440);
});

afterEach(async () => {
  for (const off of unregister.splice(0)) off();
  await teardownToday(harness);
});

const taskOf = (id: string) => harness.container.data.repos.tasks.getById(id as never);

function routine(title: string): Routine {
  return {
    id: asEntityId<RoutineId>('70000009-0000-4000-8000-000000000000'),
    spaceId: SPACE_PRO_ID,
    title,
    icon: null,
    time: asLocalTime('18:00'),
    paused: false,
    archived: false,
    deletedAt: null,
  } as unknown as Routine;
}

describe('Aujourd’hui : gestes, passe QA (A-07)', () => {
  it('A-07 critère 1 : 39 % lent sur une vraie ligne, aucun effet ni haptique ; 9 px, aucun effet', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 176, 30, 1000);
    touch(row, 'pointerup', 176, 30, 2000);
    touch(row, 'pointerdown', 20, 30, 3000);
    touch(row, 'pointermove', 29, 30, 3100);
    touch(row, 'pointerup', 29, 30, 3200);
    expect((await taskOf(task.id))?.status).toBe('todo');
    expect(haptics.calls).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('A-07 critère 10 : défilement vertical sur une ligne : aucun effet, aucune ligne ouverte', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    touch(row, 'pointerdown', 200, 300, 0);
    touch(row, 'pointermove', 205, 340, 100);
    touch(row, 'pointermove', 500, 350, 200);
    touch(row, 'pointerup', 500, 350, 250);
    expect((await taskOf(task.id))?.status).toBe('todo');
    expect(row).not.toHaveAttribute('data-open');
    expect(haptics.calls).toEqual([]);
  });

  it('A-07 critère 3 : deux lignes ouvertes successivement, une seule reste ouverte', async () => {
    const first = await seedTask(harness, { title: 'Première' });
    const second = await seedTask(harness, { title: 'Seconde' });
    renderToday(harness.container);
    await screen.findByText('Seconde');
    const a = swipeRowOf(first.id);
    const b = swipeRowOf(second.id);
    swipeLeft(a);
    expect(a).toHaveAttribute('data-open', 'true');
    swipeLeft(b);
    expect(b).toHaveAttribute('data-open', 'true');
    expect(a).not.toHaveAttribute('data-open');
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1);
  });

  it('A-07 critères 1, 14 : geste pendant l’annulation T-04 d’une autre tâche : le message passe à la seconde, Annuler n’annule que celle-ci', async () => {
    const first = await seedTask(harness, { title: 'Première' });
    const second = await seedTask(harness, { title: 'Seconde' });
    renderToday(harness.container);
    await screen.findByText('Seconde');
    await act(async () => {
      swipeRight(swipeRowOf(first.id));
    });
    await waitFor(async () => expect((await taskOf(first.id))?.status).toBe('done'));
    expect(await screen.findByRole('status')).toHaveTextContent('Première');
    await act(async () => {
      swipeRight(swipeRowOf(second.id));
    });
    await waitFor(async () => expect((await taskOf(second.id))?.status).toBe('done'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Seconde'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await taskOf(second.id))?.status).toBe('todo'));
    expect((await taskOf(first.id))?.status).toBe('done');
  });

  it('A-07 critère 2 : le geste sur la tâche annulée à l’instant fonctionne (terminer, annuler, terminer de nouveau)', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    await act(async () => {
      swipeRight(swipeRowOf(task.id));
    });
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('done'));
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('todo'));
    await act(async () => {
      swipeRight(swipeRowOf(task.id));
    });
    await waitFor(async () => expect((await taskOf(task.id))?.status).toBe('done'));
  });

  it('A-07 critère 1 : tâche répétée, balayage à droite : l’occurrence est terminée et seuls Reporter et Supprimer sont proposés', async () => {
    const created = await createTaskUseCases(harness.container).create({
      title: 'Chaque jour',
      spaceId: SPACE_PRO_ID,
      date: harness.today,
      recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } as never,
    });
    if (!created.ok) throw new Error('création impossible');
    renderToday(harness.container);
    await screen.findByText('Chaque jour');
    const row = swipeRowOf(created.value.id);
    swipeLeft(row);
    expect(Array.from(row.querySelectorAll('.ct-swipe-row__button')).map((button) => button.textContent)).toEqual(['Reporter', 'Supprimer']);
    fireEvent.pointerDown(document.body);
    await act(async () => {
      swipeRight(row);
    });
    await waitFor(async () => expect((await taskOf(created.value.id))?.status).toBe('done'));
    expect(haptics.calls.at(-1)).toEqual({ type: 'notification', kind: 'success' });
  });

  it('A-07 critère 2 : tâche terminée : seul « Supprimer » à gauche, pas de Reporter ni Un jour', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    await createTaskUseCases(harness.container).complete(task.id);
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    expect(Array.from(row.querySelectorAll('.ct-swipe-row__button')).map((button) => button.textContent)).toEqual(['Supprimer']);
    expect(screen.queryByRole('button', { name: 'Reporter : Courses' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Un jour : Courses' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Supprimer : Courses' })).toBeInTheDocument();
  });

  describe('routine (D3)', () => {
    function plugRoutine(done: boolean, toggle: TodaySource['toggleRoutine']): void {
      let state = done;
      unregister.push(
        registerTodaySource({
          id: 'qa-routine',
          load: () => Promise.resolve({ routines: [{ routine: routine('Sport'), done: state }] }),
          toggleRoutine: (container, id, date, value) => {
            state = value;
            return toggle ? toggle(container, id, date, value) : Promise.resolve();
          },
        }),
      );
    }

    it('A-07 critère 2 : balayage à droite valide la routine pour la date affichée, succès haptique', async () => {
      const toggle = vi.fn(() => Promise.resolve());
      plugRoutine(false, toggle);
      renderToday(harness.container);
      await screen.findByText('Sport');
      const row = swipeRowOf(ROUTINE_ID);
      await act(async () => {
        swipeRight(row);
      });
      await waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
      expect(toggle).toHaveBeenCalledWith(expect.anything(), ROUTINE_ID, harness.today, true);
      expect(haptics.calls.at(-1)).toEqual({ type: 'notification', kind: 'success' });
    });

    it('A-07 critère 2 : routine validée : « Rouvrir » et le geste rouvre', async () => {
      const toggle = vi.fn(() => Promise.resolve());
      plugRoutine(true, toggle);
      renderToday(harness.container);
      await screen.findByText('Sport');
      const row = swipeRowOf(ROUTINE_ID);
      touch(row, 'pointerdown', 20, 30, 0);
      touch(row, 'pointermove', 120, 30, 100);
      expect(row.querySelector('.ct-swipe-row__under--right')).toHaveTextContent('Rouvrir');
      await act(async () => {
        touch(row, 'pointerup', 240, 30, 150);
      });
      await waitFor(() => expect(toggle).toHaveBeenCalledWith(expect.anything(), expect.anything(), harness.today, false));
    });

    it('A-07 critère 3 : routine, balayage à gauche : rien (aucun bouton, aucun groupe d’actions, aucun haptique)', async () => {
      plugRoutine(false, undefined);
      renderToday(harness.container);
      await screen.findByText('Sport');
      const row = swipeRowOf(ROUTINE_ID);
      touch(row, 'pointerdown', 300, 30, 0);
      touch(row, 'pointermove', 150, 30, 100);
      touch(row, 'pointerup', 150, 30, 150);
      expect(row).not.toHaveAttribute('data-open');
      expect(row.querySelectorAll('.ct-swipe-row__button')).toHaveLength(0);
      expect(screen.queryByRole('group', { name: 'Actions : Sport' })).toBeNull();
      expect(haptics.calls).toEqual([]);
    });

    it('A-07 critère 8 : routine, appui long : aucune fiche', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        plugRoutine(false, undefined);
        renderToday(harness.container);
        await vi.waitFor(() => expect(screen.getByText('Sport')).toBeInTheDocument());
        const row = swipeRowOf(ROUTINE_ID);
        touch(row, 'pointerdown', 100, 30, 0);
        act(() => {
          vi.advanceTimersByTime(600);
        });
        touch(row, 'pointerup', 100, 30, 650);
        expect(haptics.calls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('A-07 critère 18 : la source de routine échoue : message habituel, aucun succès haptique', async () => {
      plugRoutine(false, () => Promise.reject(new Error('boom')));
      renderToday(harness.container);
      await screen.findByText('Sport');
      const row = swipeRowOf(ROUTINE_ID);
      await act(async () => {
        swipeRight(row);
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de terminer ou rouvrir cette tâche.');
      expect(haptics.calls.some((call) => call.type === 'notification')).toBe(false);
    });
  });

  it('A-07 critère 18 : « Reporter » en échec : message visible, date inchangée, aucun bandeau Annuler', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    vi.spyOn(harness.container.data, 'transaction').mockRejectedValue(new Error('boom'));
    vi.spyOn(harness.container.data.repos.tasks, 'update').mockRejectedValue(new Error('boom'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reporter : Courses' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de reporter cette tâche.');
    expect((await taskOf(task.id))?.date).toBe(harness.today);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('A-07 critère 18 : suppression confirmée en échec : message visible, la tâche reste, aucun bandeau', async () => {
    const task = await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const row = swipeRowOf(task.id);
    swipeLeft(row);
    fireEvent.click(row.querySelector('[data-action="delete"]') as Element);
    const dialog = await screen.findByRole('alertdialog');
    vi.spyOn(harness.container.data, 'transaction').mockRejectedValue(new Error('boom'));
    vi.spyOn(harness.container.data.repos.tasks, 'softDelete').mockRejectedValue(new Error('boom'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de supprimer cette tâche.');
    expect((await taskOf(task.id))?.deletedAt ?? null).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(haptics.calls.some((call) => call.type === 'notification')).toBe(false);
  });

  it('A-07 critère 13 : filtre Perso actif : le geste agit sur la tâche touchée, qui sort de la liste, les voisines restent', async () => {
    const perso = await seedTask(harness, { title: 'Perso un', spaceId: SPACE_PERSO_ID });
    await seedTask(harness, { title: 'Perso deux', spaceId: SPACE_PERSO_ID });
    await seedTask(harness, { title: 'Pro un', spaceId: SPACE_PRO_ID });
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderToday(harness.container);
    await screen.findByText('Perso un');
    expect(screen.queryByText('Pro un')).toBeNull();
    swipeLeft(swipeRowOf(perso.id));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reporter : Perso un' }));
    });
    await waitFor(async () => expect((await taskOf(perso.id))?.date).toBe(addDays(harness.today, 1)));
    await waitFor(() => expect(screen.queryByText('Perso un')).toBeNull());
    expect(screen.getByText('Perso deux')).toBeInTheDocument();
    expect(screen.queryByText('Pro un')).toBeNull();
  });

  it('A-07 critère 17 : après « Terminer » abouti, le focus passe à la ligne suivante', async () => {
    const first = await seedTask(harness, { title: 'Première' });
    await seedTask(harness, { title: 'Seconde' });
    renderToday(harness.container);
    await screen.findByText('Seconde');
    await act(async () => {
      swipeRight(swipeRowOf(first.id));
    });
    await waitFor(async () => expect((await taskOf(first.id))?.status).toBe('done'));
    await waitFor(() => expect(document.activeElement?.closest('[role="listitem"]')).toHaveTextContent('Seconde'));
  });

  it('A-07 critère 16 : chaque ligne à faire expose un groupe nommé avec Reporter, Un jour, Supprimer, dans cet ordre', async () => {
    await seedTask(harness, { title: 'Courses' });
    renderToday(harness.container);
    await screen.findByText('Courses');
    const group = screen.getByRole('group', { name: 'Actions : Courses' });
    expect(within(group).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Reporter : Courses', 'Un jour : Courses', 'Supprimer : Courses']);
  });
});
