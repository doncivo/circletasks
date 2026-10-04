import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { seedProject } from '../spaces/testKit';
import { renderToday } from '../today/testKit';
import { loadTodayExtras } from '../today/todaySources';
import { renderWeek } from '../week/testKit';
import { createEventUseCases } from './eventUseCases';
import { registerEventsSource, unregisterEventsSource } from './eventsSource';
import { mockViewport, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const day = (iso: string) => iso as LocalDate;

describe('Source des événements : chargement par jour (E-01 critères 4, 6, 10, 11)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('421');
    mockViewport(440);
    registerEventsSource();
    registerEventsSource(); // idempotent : une seule source
  });
  afterEach(async () => {
    unregisterEventsSource();
    await teardownEvents(h);
  });

  const titlesOn = async (iso: string, filter: 'all' | typeof SPACE_PRO_ID | typeof SPACE_PERSO_ID = 'all'): Promise<string[]> =>
    (await loadTodayExtras(h.container, day(iso), filter)).extras.events.map((event) => event.title);

  it('un événement unique n’apparaît que le jour de sa date ; une plage horaire donne son heure de début', async () => {
    await seedEvent(h, { title: 'Point client', date: '2026-10-02', start: '10:00', end: '11:00' });
    const { extras } = await loadTodayExtras(h.container, day('2026-10-02'), 'all');
    expect(extras.events).toMatchObject([{ title: 'Point client', allDay: false, startTime: '10:00', calendarName: null, spaceId: SPACE_PRO_ID }]);
    expect(await titlesOn('2026-10-03')).toEqual([]);
  });

  it('une plage qui passe minuit : heure le premier jour, « toute la journée » le suivant', async () => {
    await seedEvent(h, { title: 'Nuit', date: '2026-10-02', endDate: '2026-10-03', start: '22:00', end: '02:00' });
    expect((await loadTodayExtras(h.container, day('2026-10-03'), 'all')).extras.events).toMatchObject([{ title: 'Nuit', allDay: true, startTime: null }]);
  });

  it('série mensuelle et annuelle : le même quantième, le 31 devient le dernier jour (critère 4)', async () => {
    await seedEvent(h, { title: 'Fin de mois', date: '2026-01-31', repeat: 'monthly' });
    await seedEvent(h, { title: 'Bissextile', date: '2024-02-29', repeat: 'yearly' });
    expect((await titlesOn('2026-02-28')).sort()).toEqual(['Bissextile', 'Fin de mois']);
    expect(await titlesOn('2026-04-30')).toEqual(['Fin de mois']);
    expect((await titlesOn('2028-02-29')).sort()).toEqual(['Bissextile', 'Fin de mois']);
    expect(await titlesOn('2026-03-15')).toEqual([]);
  });

  it('le filtre d’espace s’applique', async () => {
    await seedEvent(h, { title: 'Réunion', date: '2026-10-02', spaceId: SPACE_PRO_ID });
    await seedEvent(h, { title: 'Dîner', date: '2026-10-02', spaceId: SPACE_PERSO_ID });
    expect(await titlesOn('2026-10-02', SPACE_PERSO_ID)).toEqual(['Dîner']);
    expect(await titlesOn('2026-10-02', SPACE_PRO_ID)).toEqual(['Réunion']);
  });

  it('un événement supprimé disparaît de la source', async () => {
    const event = await seedEvent(h, { title: 'Réunion', date: '2026-10-02' });
    await createEventUseCases(h.container).remove(event.id);
    expect(await titlesOn('2026-10-02')).toEqual([]);
  });
});

describe('Événements dans Aujourd’hui et la Semaine (E-01 critères 6, 7, 10, 11)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('422');
    mockViewport(440);
    registerEventsSource();
  });
  afterEach(async () => {
    unregisterEventsSource();
    await teardownEvents(h);
  });

  it('bandeau en tête d’Aujourd’hui à sa date ; le toucher ouvre la fiche (critères 6, 7, 11)', async () => {
    await seedEvent(h, { title: 'Point client', date: '2026-10-02', start: '10:00', end: '11:00' });
    await seedEvent(h, { title: 'Demain', date: '2026-10-03' });
    renderToday(h.container);
    const band = await screen.findByRole('button', { name: /Point client/ });
    expect(band).toHaveTextContent('10:00');
    expect(screen.queryByText('Demain')).toBeNull();
    fireEvent.click(band);
    expect(useNavigationStore.getState().detail).toMatchObject({ type: 'event' });
  });

  it('sous un filtre projet, aucun bandeau (critère 10)', async () => {
    await seedEvent(h, { title: 'Point client', date: '2026-10-02' });
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission');
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    useAppStore.getState().setProjectFilter(project.id);
    renderToday(h.container);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByText('Point client')).toBeNull());
  });

  it('la Semaine affiche l’événement dans la colonne de son jour (critère 6)', async () => {
    await seedEvent(h, { title: 'Point client', date: '2026-10-02', start: '10:00', end: '11:00' });
    await seedEvent(h, { title: 'Dîner', date: '2026-10-03', spaceId: SPACE_PERSO_ID });
    renderWeek(h.container);
    const column = async (iso: string): Promise<HTMLElement> => (await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-date="${iso}"]`);
      if (!node) throw new Error('colonne absente');
      return node;
    }));
    expect(await within(await column('2026-10-02')).findByText(/Point client/)).toBeInTheDocument();
    expect(within(await column('2026-10-03')).getByText('Dîner')).toBeInTheDocument();
    expect(within(await column('2026-10-02')).queryByText('Dîner')).toBeNull();
  });

  it('une suppression annulée met les bandeaux à jour sans recharger', async () => {
    const event = await seedEvent(h, { title: 'Point client', date: '2026-10-02' });
    renderToday(h.container);
    await screen.findByText('Point client');
    await act(async () => {
      await createEventUseCases(h.container).remove(event.id);
    });
    await waitFor(() => expect(screen.queryByText('Point client')).toBeNull());
    await act(async () => {
      await h.container.undo.undoLast();
    });
    expect(await screen.findByText('Point client')).toBeInTheDocument();
  });
});
