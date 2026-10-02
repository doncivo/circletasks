import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent, type FixtureExternalEvent } from '../../db/seed/externalEventFixtures';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : mer. 23 sept. 2026 10:00 UTC, semaine ISO 39 (21 au 27 sept.). */
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const eventsOf = (iso: string): HTMLElement[] => [...day(iso).querySelectorAll<HTMLElement>('.ct-week-event')];

describe('Semaine : événements d’agenda externes (S-05)', () => {
  let h: WeekHarness;

  async function seedAccount(): Promise<void> {
    await insertCalendarAccount(h.db.driver, {
      id: 'acc-google',
      provider: 'google',
      label: 'Google Agenda',
      calendars: [
        { id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
        { id: 'perso', name: 'Famille', spaceId: SPACE_PERSO_ID, shown: true },
        { id: 'libre', name: 'Libre', spaceId: null, shown: true },
      ],
    });
  }
  const seedEvent = (event: Partial<FixtureExternalEvent> & Pick<FixtureExternalEvent, 'id' | 'title'>): Promise<void> =>
    insertExternalEvent(h.db.driver, { accountId: 'acc-google', calendarId: 'pro', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', ...event });

  beforeEach(async () => {
    h = await setupWeek('305', '2026-09-23T10:00:00.000Z');
    useAppStore.getState().setTimeZone('Europe/Paris');
    await seedAccount();
  });
  afterEach(async () => {
    useAppStore.setState({ timeZone: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  describe('PC', () => {
    beforeEach(() => mockViewport(1440));

    it('affiche l’événement du 23 sept. 08:00Z le mer. 23 à « 10:00 », en tête du jour, avec le nom de la source (critère 1)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-23'), time: '09:00' });
      renderWeek(h.container);
      await screen.findByText('10:00 Point client');
      const [event] = eventsOf('2026-09-23');
      expect(event).toHaveTextContent('10:00 Point client');
      expect(event).toHaveTextContent('Google Agenda');
      expect(event).toHaveAttribute('data-source', 'external');
      // En tête du jour : avant la tâche, qui est pourtant à 09:00.
      const items = [...day('2026-09-23').querySelectorAll('.ct-week-event, .ct-week-item')];
      expect(items[0]).toBe(event);
      expect(eventsOf('2026-09-22')).toEqual([]);
    });

    it('lecture seule : ni case, ni poignée, ni suppression ; non déplaçable ; annoncé « Événement, lecture seule » (critères 2 et 8)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      renderWeek(h.container);
      const button = await screen.findByRole('button', { name: /Point client/ });
      expect(button).toHaveAccessibleName(/Point client.*Événement, lecture seule/);
      expect(within(button).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(button.closest('[data-drag-id]')).toBeNull();
      expect(button.querySelector('[data-drag-id], .ct-drag-handle')).toBeNull();
      expect(screen.queryByRole('button', { name: /Supprimer/ })).not.toBeInTheDocument();
    });

    it('un clic ouvre une fiche en lecture seule : titre, date, heures locales, agenda source ; aucun champ modifiable (critère 3)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('button', { name: /Point client/ }));
      const panel = await screen.findByRole('complementary', { name: 'Détail de l’événement' });
      expect(within(panel).getByRole('heading', { name: 'Point client' })).toBeInTheDocument();
      expect(panel).toHaveTextContent('Mer. 23 sept. 2026');
      expect(panel).toHaveTextContent('Début10:00');
      expect(panel).toHaveTextContent('Fin11:00');
      expect(panel).toHaveTextContent('Travail · Google Agenda');
      expect(panel).toHaveTextContent('Cet événement vient de votre agenda');
      expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /Reporter|Supprimer|Dupliquer|Terminer|Un jour/ })).not.toBeInTheDocument();
      expect(useNavigationStore.getState().detail).toEqual({ type: 'externalEvent', id: 'e1' });
      // Échap referme la fiche.
      fireEvent.keyDown(panel, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Détail de l’événement' })).not.toBeInTheDocument());
    });

    it('l’heure se recale au changement de fuseau, sans relire la base (dette T-11)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      renderWeek(h.container);
      await screen.findByText('10:00 Point client');
      const reads = h.container.data.repos.externalEvents.listBetween;
      let calls = 0;
      h.container.data.repos.externalEvents.listBetween = (...args) => {
        calls += 1;
        return reads(...args);
      };
      act(() => useAppStore.getState().setTimeZone('Africa/Tunis'));
      expect(await screen.findByText('09:00 Point client')).toBeInTheDocument();
      act(() => useAppStore.getState().setTimeZone('America/New_York'));
      expect(await screen.findByText('04:00 Point client')).toBeInTheDocument();
      expect(calls).toBe(0);
      // La fiche ouverte suit aussi.
      fireEvent.click(screen.getByRole('button', { name: /Point client/ }));
      expect(await screen.findByRole('complementary', { name: 'Détail de l’événement' })).toHaveTextContent('Début04:00');
      act(() => useAppStore.getState().setTimeZone('Europe/Paris'));
      await waitFor(() => expect(screen.getByRole('complementary', { name: 'Détail de l’événement' })).toHaveTextContent('Début10:00'));
    });

    it('une journée entière s’affiche sans heure, en premier, sur sa date, sans décalage de fuseau (critère 4)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      await seedEvent({ id: 'e2', title: 'Congé', allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-24T00:00:00Z' });
      renderWeek(h.container);
      await screen.findByText(/Congé/);
      const [first, second] = eventsOf('2026-09-23');
      expect(first).toHaveTextContent('Congé');
      expect(first).toHaveTextContent('Toute la journée');
      expect(first).not.toHaveTextContent(/\d\d:\d\d/);
      expect(second).toHaveTextContent('10:00 Point client');
      act(() => useAppStore.getState().setTimeZone('Pacific/Honolulu'));
      await screen.findByText(/Congé/);
      expect(eventsOf('2026-09-23').map((el) => el.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Congé')]));
      expect(eventsOf('2026-09-22').some((el) => /Congé/.test(el.textContent ?? ''))).toBe(false); // la journée entière ne glisse pas au jour d'avant
      fireEvent.click(screen.getByRole('button', { name: /Congé/ }));
      expect(await screen.findByRole('complementary', { name: 'Détail de l’événement' })).toHaveTextContent('Toute la journée');
    });

    it('un événement de plusieurs jours est affiché sur chaque jour couvert (critère 5)', async () => {
      await seedEvent({ id: 'e1', title: 'Voyage', startUtc: '2026-09-24T07:00:00Z', endUtc: '2026-09-26T16:00:00Z' });
      renderWeek(h.container);
      await screen.findAllByText(/Voyage/);
      expect(eventsOf('2026-09-24')[0]).toHaveTextContent('09:00 Voyage');
      expect(eventsOf('2026-09-25')[0]).toHaveTextContent('Voyage');
      expect(eventsOf('2026-09-26')[0]).toHaveTextContent('Voyage');
      expect(eventsOf('2026-09-27')).toEqual([]);
      fireEvent.click(within(day('2026-09-25')).getByRole('button', { name: /Voyage/ }));
      expect(await screen.findByRole('complementary', { name: 'Détail de l’événement' })).toHaveTextContent('Du Jeu. 24 sept. au Sam. 26 sept. 2026');
    });

    it('trie les événements d’un jour : journée entière, puis par heure de début (critère 6)', async () => {
      await seedEvent({ id: 'tard', title: 'Tard', startUtc: '2026-09-23T15:00:00Z', endUtc: '2026-09-23T16:00:00Z' });
      await seedEvent({ id: 'tot', title: 'Tôt', startUtc: '2026-09-23T06:00:00Z', endUtc: '2026-09-23T07:00:00Z' });
      await seedEvent({ id: 'jour', title: 'Journée', allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-24T00:00:00Z' });
      renderWeek(h.container);
      await screen.findByText(/Tard/);
      expect(eventsOf('2026-09-23').map((el) => el.querySelector('.ct-week-item__title')?.textContent)).toEqual(['Journée', '08:00 Tôt', '17:00 Tard']);
    });

    it('le filtre d’espace affiche l’événement si son agenda est rattaché à cet espace ; un agenda libre seulement sous « Tout » (critère 7)', async () => {
      await seedEvent({ id: 'e1', title: 'Pro seul', calendarId: 'pro' });
      await seedEvent({ id: 'e2', title: 'Perso seul', calendarId: 'perso' });
      await seedEvent({ id: 'e3', title: 'Agenda libre', calendarId: 'libre' });
      renderWeek(h.container);
      await screen.findByText(/Agenda libre/);
      expect(eventsOf('2026-09-23')).toHaveLength(3);
      fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
      await waitFor(() => expect(screen.queryByText(/Perso seul/)).not.toBeInTheDocument());
      expect(eventsOf('2026-09-23').map((el) => el.textContent)).toEqual([expect.stringContaining('Pro seul')]);
      fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
      await screen.findByText(/Perso seul/);
      expect(eventsOf('2026-09-23')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Tout' }));
      await screen.findByText(/Agenda libre/);
      expect(eventsOf('2026-09-23')).toHaveLength(3);
    });

    it('chaque semaine charge ses propres événements', async () => {
      await seedEvent({ id: 'e1', title: 'Réunion A' });
      await seedEvent({ id: 'e2', title: 'Réunion B', startUtc: '2026-09-30T08:00:00Z', endUtc: '2026-09-30T09:00:00Z' });
      renderWeek(h.container);
      await screen.findByText(/Réunion A/);
      expect(screen.queryByText(/Réunion B/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(await screen.findByText(/Réunion B/)).toBeInTheDocument();
      expect(screen.queryByText(/Réunion A/)).not.toBeInTheDocument();
    });

    it('un événement de calendrier ne se déplace pas : aucune zone cible au glisser (critère 2)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      renderWeek(h.container);
      const event = (await screen.findByText(/Point client/)).closest('.ct-week-event') as HTMLElement;
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        const pointer = new MouseEvent(type, { bubbles: true, clientX: 200 + (type === 'pointerdown' ? 0 : 150), clientY: 40, button: 0 });
        Object.defineProperties(pointer, { pointerType: { value: 'mouse' }, pointerId: { value: 1 } });
        act(() => {
          (type === 'pointerdown' ? event : window).dispatchEvent(pointer);
        });
      }
      expect(screen.queryByText(/Déposer ici/)).not.toBeInTheDocument();
    });

    it('un échec de lecture des agendas affiche un message et garde les tâches', async () => {
      h.container.data.repos.externalEvents.listBetween = () => Promise.reject(new Error('boom'));
      await seedTask(h, { title: 'Reste là', date: asLocalDate('2026-09-23') });
      renderWeek(h.container);
      expect(await screen.findByRole('button', { name: 'Reste là' })).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent('Certains éléments de la semaine n’ont pas pu être chargés.');
    });
  });

  describe('iPhone', () => {
    beforeEach(() => mockViewport(440));

    it('affiche une ligne à icône calendrier, « 10:00 Point client », sans case, qui ouvre la fiche en feuille (critères 1, 2, 3)', async () => {
      await seedEvent({ id: 'e1', title: 'Point client' });
      renderWeek(h.container);
      const row = (await screen.findByRole('button', { name: /Point client/ })) as HTMLElement;
      expect(row).toHaveClass('ct-week-event');
      expect(row.querySelector('svg')).not.toBeNull();
      expect(row).toHaveTextContent('10:00Point client');
      expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
      fireEvent.click(row);
      const sheet = await screen.findByRole('dialog', { name: 'Détail de l’événement' });
      expect(sheet).toHaveTextContent('Point client');
      expect(sheet).toHaveTextContent('Google Agenda');
    });
  });
});
