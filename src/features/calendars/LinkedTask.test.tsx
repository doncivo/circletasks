import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent } from '../../db/seed/externalEventFixtures';
import { externalEventRowId } from '../../domain/calendarProvider';
import type { CalendarAccountId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { mockViewport, renderWeek, setupWeek, teardownWeek, type WeekHarness } from '../week/testKit';

/** Tâche créée depuis un événement externe, vue par la fiche de l'événement (Semaine) puis par la fiche de la tâche (K-04). */
const ACCOUNT = 'acc-google';
const EVENT_ID = externalEventRowId(ACCOUNT as CalendarAccountId, 'pro', 'ext-e1');

describe('K-04 — tâche depuis un événement externe', () => {
  let h: WeekHarness;

  async function seed(title = 'Point client'): Promise<void> {
    await insertExternalEvent(h.db.driver, { id: EVENT_ID, accountId: ACCOUNT, calendarId: 'pro', title, startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
  }
  const eventPanel = (): Promise<HTMLElement> => screen.findByRole('complementary', { name: 'Détail de l’événement' });

  async function openEvent(): Promise<HTMLElement> {
    renderWeek(h.container);
    fireEvent.click(await screen.findByRole('button', { name: /Point client/ }));
    return eventPanel();
  }

  beforeEach(async () => {
    h = await setupWeek('340', '2026-09-23T10:00:00.000Z');
    mockViewport(1440);
    useAppStore.getState().setTimeZone('Europe/Paris');
    await insertCalendarAccount(h.db.driver, { id: ACCOUNT, provider: 'google', label: 'Google Agenda', calendars: [{ id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true }] });
    await seed();
  });
  afterEach(async () => {
    useAppStore.setState({ timeZone: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  it('la fiche affiche « Créer une tâche » nommé « Créer une tâche depuis : <titre> » (critères 1 et 10)', async () => {
    const panel = await openEvent();
    const button = await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' });
    expect(button).toHaveTextContent('Créer une tâche');
  });

  it('un clic crée la tâche du jour de l’événement, annonce « Tâche créée pour le 23 sept. » avec « Annuler » ; le bouton devient « Voir la tâche liée » (critères 2, 3, 5)', async () => {
    const panel = await openEvent();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Tâche créée pour le 23 sept.');
    expect(within(status).getByRole('button', { name: 'Annuler' })).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Voir la tâche liée' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Créer une tâche/ })).toBeNull();
    // La tâche est dans la Semaine, à la date de l'événement.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Point client' }).length).toBeGreaterThan(0));
    const created = (await h.container.data.repos.tasks.listForWeek('2026-09-21' as never, 'all')).find((task) => task.title === 'Point client');
    expect(created).toMatchObject({ date: '2026-09-23', time: null, spaceId: SPACE_PRO_ID, externalEventId: EVENT_ID });
  });

  it('« Annuler » supprime la tâche et rétablit le bouton « Créer une tâche » (critère 8)', async () => {
    const panel = await openEvent();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' }));
    fireEvent.click(within(await screen.findByRole('status')).getByRole('button', { name: 'Annuler' }));
    expect(await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Voir la tâche liée' })).toBeNull();
    expect(await h.container.data.repos.tasks.findByExternalEvent(EVENT_ID)).toBeNull();
  });

  it('« Voir la tâche liée » ouvre la fiche de la tâche, qui porte la ligne « Événement : Point client » ouvrant la fiche de l’événement (critère 3)', async () => {
    const panel = await openEvent();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Voir la tâche liée' }));
    const taskPanel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    const link = await within(taskPanel).findByRole('button', { name: 'Événement : Point client, ouvrir la fiche' });
    expect(within(taskPanel).getByText('Événement')).toBeInTheDocument();
    fireEvent.click(link);
    expect(await eventPanel()).toHaveTextContent('Point client');
  });

  it('événement disparu : la ligne dit « Événement supprimé », non cliquable, la tâche garde titre et date (critères 6 et 9)', async () => {
    const panel = await openEvent();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Créer une tâche depuis : Point client' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Voir la tâche liée' }));
    const taskPanel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    await within(taskPanel).findByRole('button', { name: 'Événement : Point client, ouvrir la fiche' });
    await act(async () => {
      await h.db.driver.execute('DELETE FROM external_event WHERE id = ?', [EVENT_ID]);
      const { emitEventsChanged } = await import('../events/eventEvents');
      emitEventsChanged(h.container.data);
    });
    expect(await within(taskPanel).findByText('Événement supprimé')).toBeInTheDocument();
    expect(within(taskPanel).queryByRole('button', { name: /ouvrir la fiche/ })).toBeNull();
    expect(taskPanel).toHaveTextContent('Point client');
  });
});
