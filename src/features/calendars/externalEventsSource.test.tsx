import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent, type FixtureExternalEvent } from '../../db/seed/externalEventFixtures';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { emitEventsChanged } from '../events/eventEvents';
import { loadTodayExtras } from '../today/todaySources';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { registerExternalEventsSource, unregisterExternalEventsSource } from './externalEventsSource';

/** Aujourd'hui du banc : mer. 23 sept. 2026 10:00 UTC (12:00 à Paris). */
const TODAY = asLocalDate('2026-09-23');

describe('source des événements externes d’Aujourd’hui (K-03 critère 9)', () => {
  let h: TodayHarness;

  const seed = (event: Partial<FixtureExternalEvent> & Pick<FixtureExternalEvent, 'id' | 'title'>): Promise<void> =>
    insertExternalEvent(h.db.driver, { accountId: 'acc', calendarId: 'pro', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', ...event });

  beforeEach(async () => {
    h = await setupToday('310', '2026-09-23T10:00:00.000Z');
    useAppStore.getState().setTimeZone('Europe/Paris');
    await insertCalendarAccount(h.db.driver, {
      id: 'acc',
      provider: 'google',
      label: 'Google Agenda',
      calendars: [
        { id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
        { id: 'perso', name: 'Famille', spaceId: SPACE_PERSO_ID, shown: true },
      ],
    });
    registerExternalEventsSource();
  });
  afterEach(async () => {
    unregisterExternalEventsSource();
    useAppStore.setState({ timeZone: null });
    await teardownToday(h);
  });

  it('le bandeau donne l’heure locale (08:00Z = 10:00 à Paris), la source, sans espace propre', async () => {
    await seed({ id: 'e1', title: 'Point client' });
    const { extras } = await loadTodayExtras(h.container, TODAY, 'all');
    expect(extras.events).toEqual([expect.objectContaining({ id: 'e1', title: 'Point client', allDay: false, startTime: '10:00', calendarName: 'Google Agenda', spaceId: null })]);
  });

  it('journée entière sans décalage, événement de plusieurs jours « toute la journée » les jours suivants, titre vide « (Sans titre) »', async () => {
    await seed({ id: 'conge', title: 'Congé', allDay: true, startUtc: '2026-09-23', endUtc: '2026-09-24' });
    await seed({ id: 'sejour', title: 'Séjour', startUtc: '2026-09-22T10:00:00Z', endUtc: '2026-09-24T10:00:00Z' });
    await seed({ id: 'vide', title: '', startUtc: '2026-09-23T14:00:00Z', endUtc: '2026-09-23T15:00:00Z' });
    const { extras } = await loadTodayExtras(h.container, TODAY, 'all');
    expect(extras.events.map((entry) => [entry.title, entry.allDay, entry.startTime]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'fr'))).toEqual([
      ['(Sans titre)', false, '16:00'],
      ['Congé', true, null],
      ['Séjour', true, null],
    ]);
  });

  it('suit le filtre d’espace de l’agenda (ES-06) et ignore un agenda masqué ou un jour sans événement', async () => {
    await seed({ id: 'pro', title: 'Pro', calendarId: 'pro' });
    await seed({ id: 'perso', title: 'Perso', calendarId: 'perso', startUtc: '2026-09-23T09:00:00Z', endUtc: '2026-09-23T10:00:00Z' });
    await seed({ id: 'demain', title: 'Demain', startUtc: '2026-09-24T09:00:00Z', endUtc: '2026-09-24T10:00:00Z' });
    expect((await loadTodayExtras(h.container, TODAY, SPACE_PRO_ID)).extras.events.map((entry) => entry.title)).toEqual(['Pro']);
    expect((await loadTodayExtras(h.container, TODAY, SPACE_PERSO_ID)).extras.events.map((entry) => entry.title)).toEqual(['Perso']);
    expect((await loadTodayExtras(h.container, TODAY, 'all')).extras.events.map((entry) => entry.title)).toEqual(['Pro', 'Perso']);
    expect((await loadTodayExtras(h.container, asLocalDate('2026-09-25'), 'all')).extras.events).toEqual([]);
  });

  it('la Semaine ne charge pas cette source (elle lit les mêmes lignes par son propre store)', async () => {
    await seed({ id: 'e1', title: 'Point client' });
    expect((await loadTodayExtras(h.container, TODAY, 'all', 'week')).extras.events).toEqual([]);
  });

  it('Aujourd’hui affiche le bandeau (source, sans case) et le met à jour après un rafraîchissement', async () => {
    mockViewport(440);
    await seed({ id: 'e1', title: 'Point client' });
    renderToday(h.container);
    const band = (await screen.findByText('Point client')).closest('div,li,section,article') as HTMLElement;
    expect(within(band).getByText('Google Agenda')).toBeInTheDocument();
    expect(within(band).queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('10:00')).toBeInTheDocument();
    await seed({ id: 'e2', title: 'Appel', startUtc: '2026-09-23T13:00:00Z', endUtc: '2026-09-23T13:30:00Z' });
    await act(async () => {
      emitEventsChanged(h.container.data);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByText('Appel')).toBeInTheDocument();
  });
});
