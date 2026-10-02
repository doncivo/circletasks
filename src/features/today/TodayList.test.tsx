import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { ChecklistSummary, Goal, Routine } from '../../domain/model';
import { asEntityId, asLocalTime, type RoutineId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource, type TodayExtras, type TodaySource } from './todaySources';

describe('Aujourd’hui : liste du jour (A-01)', () => {
  let h: TodayHarness;
  const unregister: (() => void)[] = [];

  beforeEach(async () => {
    h = await setupToday('101');
  });

  afterEach(async () => {
    for (const off of unregister.splice(0)) off();
    await teardownToday(h);
  });

  it('en-tête iPhone : mois court, jour court et badge AUJOURD’HUI (critère 2)', async () => {
    mockViewport(440);
    renderToday(h.container);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/^2 ven\.$/);
    expect(screen.getByText('oct. 2026')).toBeInTheDocument();
    expect(screen.getByText('Aujourd’hui')).toBeInTheDocument();
  });

  it('en-tête PC : mois et jour en toutes lettres (critère 2)', async () => {
    mockViewport(1440);
    renderToday(h.container);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('2 vendredi');
    expect(screen.getByText('octobre 2026')).toBeInTheDocument();
  });

  it('chaque tâche affiche « HH:MM · Espace » en filtre Tout, l’heure seule en filtre Pro (critères 5, 6)', async () => {
    await seedTask(h, { title: 'Envoyer la facture', time: '09:00' });
    await seedTask(h, { title: 'Appeler le notaire', time: '14:00', spaceId: SPACE_PERSO_ID });
    mockViewport(440);
    renderToday(h.container);
    const facture = (await screen.findByRole('button', { name: 'Envoyer la facture' })).closest('.ct-list-row') as HTMLElement;
    expect(facture).toHaveTextContent('09:00 · Pro');
    expect(within(facture).getByText('Pro')).toHaveStyle({ color: '#2f6b7a' });
    const notaire = screen.getByRole('button', { name: 'Appeler le notaire' }).closest('.ct-list-row') as HTMLElement;
    expect(notaire).toHaveTextContent('14:00 · Perso');

    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Appeler le notaire' })).toBeNull());
    const proRow = screen.getByRole('button', { name: 'Envoyer la facture' }).closest('.ct-list-row') as HTMLElement;
    expect(proRow.querySelector('.ct-list-row__subtitle')).toHaveTextContent(/^09:00$/);
  });

  it('PC : la ligne dont la fiche est ouverte est surlignée, et la liste reste utilisable (A-08 critères 1, 4)', async () => {
    await seedTask(h, { title: 'Première' });
    await seedTask(h, { title: 'Seconde' });
    mockViewport(1440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Première' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    expect(screen.getAllByRole('button', { name: 'Première' })[0]?.closest('.ct-list-row')).toHaveAttribute('data-selected', 'true');
    // Une autre tâche choisie : le panneau suit sans se fermer.
    fireEvent.click(screen.getAllByRole('button', { name: 'Seconde' })[0] as HTMLElement);
    await waitFor(() => expect(within(panel).getByRole('heading', { name: 'Seconde' })).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Seconde' })[0]?.closest('.ct-list-row')).toHaveAttribute('data-selected', 'true');
  });

  it('exclut les tâches des autres jours (critère 4)', async () => {
    await seedTask(h, { title: 'Du jour' });
    await seedTask(h, { title: 'Demain', date: addDays(h.today, 1) });
    mockViewport(440);
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Du jour' });
    expect(screen.queryByRole('button', { name: 'Demain' })).toBeNull();
  });

  it('place les terminées en bas et les barre (critère 3)', async () => {
    await seedTask(h, { title: 'Faite' });
    await seedTask(h, { title: 'Restante' });
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Faite' }));
    await waitFor(() => {
      const titles = screen.getAllByRole('listitem').map((item) => item.textContent);
      expect(titles[0]).toContain('Restante');
      expect(titles[1]).toContain('Faite');
    });
    expect(screen.getByRole('button', { name: 'Faite' })).toHaveAttribute('data-done', 'true');
  });

  it('sans source de routine, d’événement ni de checklist : rien d’inventé (critère 3)', async () => {
    await seedTask(h, { title: 'Seule' });
    mockViewport(440);
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Seule' });
    expect(screen.queryByRole('list', { name: 'Événements du jour' })).toBeNull();
    expect(screen.queryByText('Checklists')).toBeNull();
    expect(screen.queryByText(/Routine/)).toBeNull();
  });

  describe('avec les sources des autres modules (routines, événements, checklists, objectif)', () => {
    function routine(title: string, time: string | null, spaceId = SPACE_PRO_ID): Routine {
      return {
        id: asEntityId<RoutineId>(`7000000${String(title.length % 10)}-0000-4000-8000-000000000000`),
        spaceId,
        title,
        icon: null,
        time: time === null ? null : asLocalTime(time),
        paused: false,
        archived: false,
        deletedAt: null,
      } as unknown as Routine;
    }

    function plug(source: Partial<TodayExtras>, extra: Partial<TodaySource> = {}): void {
      unregister.push(registerTodaySource({ id: 'test', load: () => Promise.resolve(source), ...extra }));
    }

    const checklist = (date: string): ChecklistSummary => ({
      checklist: { id: 'c1', spaceId: SPACE_PRO_ID, title: 'Valise', date, isTemplate: false, deletedAt: null } as unknown as ChecklistSummary['checklist'],
      checked: 3,
      total: 5,
    });

    it('ordre vertical : objectif, événements, routines et tâches mêlées, terminées, checklists (critère 3)', async () => {
      await seedTask(h, { title: 'Envoyer la facture', time: '09:00' });
      plug({
        goal: { goal: { id: 'g', spaceId: SPACE_PRO_ID, title: 'Finaliser le PRD', icon: null, deletedAt: null } as unknown as Goal, progress: { done: 2, total: 5 } },
        events: [{ id: 'e', title: 'Point client', allDay: false, startTime: asLocalTime('10:00'), spaceId: null, calendarName: 'Google Agenda', icon: null }],
        routines: [
          { routine: routine('Boire de l’eau', '08:30'), done: false },
          { routine: routine('Faire mon lit', '07:00'), done: true },
        ],
        checklists: [checklist(h.today)],
      });
      mockViewport(440);
      renderToday(h.container);
      await screen.findByText('Finaliser le PRD');

      const first = screen.getByText('Boire de l’eau');
      const order = [
        screen.getByText('Finaliser le PRD'),
        screen.getByText('Point client'),
        first,
        screen.getByRole('button', { name: 'Envoyer la facture' }),
        screen.getByText('Faire mon lit'),
        screen.getByText('Valise'),
      ];
      for (let i = 0; i < order.length - 1; i += 1) {
        expect((order[i] as Node).compareDocumentPosition(order[i + 1] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(screen.getByText('2/5')).toBeInTheDocument();
      expect(screen.getByText('Google Agenda')).toBeInTheDocument();
      expect(screen.getByText('3/5')).toBeInTheDocument();
      // Routine : « HH:MM · Routine », sans case tant qu'aucun module ne sait la valider.
      expect(first.closest('.ct-list-row')).toHaveTextContent('08:30 · Routine');
      expect(screen.queryByRole('checkbox', { name: 'Terminer : Boire de l’eau' })).toBeNull();
    });

    it('un événement ou une checklist d’un autre espace disparaît en filtre Perso (critère 6)', async () => {
      plug({
        events: [{ id: 'e', title: 'Réunion Pro', allDay: false, startTime: asLocalTime('10:00'), spaceId: SPACE_PRO_ID, calendarName: null, icon: null }],
        checklists: [checklist(h.today)],
      });
      useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
      mockViewport(440);
      renderToday(h.container);
      await screen.findByText('Rien de prévu aujourd’hui.');
      expect(screen.queryByText('Réunion Pro')).toBeNull();
      expect(screen.queryByText('Valise')).toBeNull();
    });

    it('la case d’une routine apparaît quand une source sait la valider (R-03) et appelle la source', async () => {
      const toggle = vi.fn(() => Promise.resolve());
      plug({ routines: [{ routine: routine('Sport', '18:00'), done: false }] }, { toggleRoutine: toggle });
      mockViewport(440);
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Sport' }));
      await waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
    });

    it('« Masquer les routines » retire les routines de la liste, pas les tâches ; les décocher les ramène (A-03 critères 2, 5)', async () => {
      await seedTask(h, { title: 'Une tâche' });
      plug({ routines: [{ routine: routine('Boire de l’eau', '08:30'), done: false }, { routine: routine('Faire mon lit', '07:00'), done: true }] });
      await h.container.data.repos.settings.set('today.hideRoutines', true);
      mockViewport(440);
      const first = renderToday(h.container);
      await screen.findByRole('button', { name: 'Une tâche' });
      expect(screen.queryByText('Boire de l’eau')).toBeNull();
      expect(screen.queryByText('Faire mon lit')).toBeNull();
      expect(screen.queryByText(/Routine/)).toBeNull();
      first.unmount();

      await h.container.data.repos.settings.set('today.hideRoutines', false);
      renderToday(h.container);
      expect(await screen.findByText('Boire de l’eau')).toBeInTheDocument();
      expect(screen.getByText('Faire mon lit')).toBeInTheDocument(); // avec son état : validée, en bas
      expect(screen.getByRole('button', { name: 'Une tâche' })).toBeInTheDocument();
    });

    it('une journée sans tâche dont les routines sont masquées affiche l’état vide (A-03 critère 7)', async () => {
      plug({ routines: [{ routine: routine('Sport', '18:00'), done: false }] });
      await h.container.data.repos.settings.set('today.hideRoutines', true);
      mockViewport(440);
      renderToday(h.container);
      expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();
      expect(screen.queryByText('Sport')).toBeNull();
    });

    it('un échec de source affiche un message sans masquer les tâches', async () => {
      await seedTask(h, { title: 'Reste visible' });
      unregister.push(registerTodaySource({ id: 'cassee', load: () => Promise.reject(new Error('boom')) }));
      mockViewport(440);
      renderToday(h.container);
      expect(await screen.findByRole('alert')).toHaveTextContent('Certains éléments du jour');
      expect(screen.getByRole('button', { name: 'Reste visible' })).toBeInTheDocument();
    });
  });

  it('état vide : phrase du jour et aide ; pas de bouton « Un jour » tant que SD-01 n’existe pas (critère 7)', async () => {
    mockViewport(440);
    renderToday(h.container);
    expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();
    expect(screen.getByText(/Ajoutez une tâche ci-dessous/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Un jour/ })).toBeNull();
  });

  describe('flèches de jour sur PC (Q10, critère 10)', () => {
    it('« Jour suivant » affiche demain sans badge, « Jour précédent » revient puis va à hier', async () => {
      await seedTask(h, { title: 'Aujourd’hui seulement' });
      await seedTask(h, { title: 'Pour demain', date: addDays(h.today, 1) });
      mockViewport(1440);
      renderToday(h.container);
      await screen.findByRole('button', { name: 'Aujourd’hui seulement' });

      fireEvent.click(screen.getByRole('button', { name: 'Jour suivant' }));
      expect(await screen.findByRole('button', { name: 'Pour demain' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('3 samedi');
      expect(screen.queryByText('Aujourd’hui')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Aujourd’hui seulement' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Jour précédent' }));
      expect(await screen.findByRole('button', { name: 'Aujourd’hui seulement' })).toBeInTheDocument();
      expect(screen.getByText('Aujourd’hui')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Jour précédent' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1 jeudi'));
      expect(await screen.findByText('Rien de prévu ce jeudi.')).toBeInTheDocument();
      expect(screen.queryByText('Aujourd’hui')).toBeNull();
    });

    it('goToToday ramène au jour courant avec le badge', async () => {
      mockViewport(1440);
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Jour suivant' }));
      await screen.findByText('Rien de prévu ce samedi.');
      act(() => useNavigationStore.getState().goToToday());
      expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();
      expect(screen.getByText('Aujourd’hui')).toBeInTheDocument();
    });

    it('les flèches n’existent pas sur iPhone', async () => {
      mockViewport(440);
      renderToday(h.container);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByRole('button', { name: 'Jour suivant' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Jour précédent' })).toBeNull();
    });

    it('une tâche créée depuis un autre jour est datée de ce jour', async () => {
      mockViewport(1440);
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Jour suivant' }));
      await screen.findByText('Rien de prévu ce samedi.');
      const field = screen.getByLabelText('Nouvelle tâche');
      fireEvent.change(field, { target: { value: 'Ajoutée samedi' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      expect(await screen.findByRole('button', { name: 'Ajoutée samedi' })).toBeInTheDocument();
      const [created] = await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all');
      expect(created?.title).toBe('Ajoutée samedi');
    });
  });
});
