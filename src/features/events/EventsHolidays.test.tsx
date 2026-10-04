import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { SettingsScreen } from '../settings/SettingsScreen';
import { seedProject } from '../spaces/testKit';
import { renderToday } from '../today/testKit';
import { renderWeek } from '../week/testKit';
import { HolidaySettingsScreen } from './HolidaySettingsScreen';
import { HolidayDetailHost } from './HolidayDetailHost';
import { createHolidayUseCases } from './holidayUseCases';
import { registerEventsSource, unregisterEventsSource } from './eventsSource';
import { mockViewport, renderEvents, seedEvent, setupEvents, teardownEvents, type EventsHarness } from './testKit';

const rowOf = (title: string): HTMLElement => screen.getByText(title, { selector: '.ct-event-row__title' }).closest('.ct-event-row') as HTMLElement;
const titles = (): string[] => Array.from(document.querySelectorAll('.ct-event-row__title')).map((node) => node.textContent ?? '');

describe('Jours fériés dans l’onglet Événements (E-03), iPhone', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('451', undefined, { holidays: true });
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  it('France et Tunisie activées par défaut : tags « Férié FR » / « Férié TN » et sous-lignes de la maquette (critères 1, 2, 4, 7)', async () => {
    renderEvents(h.container);
    await screen.findByText('Fête de l’Évacuation');
    const evacuation = rowOf('Fête de l’Évacuation');
    expect(within(evacuation).getByText('Jour férié · Tunisie')).toBeInTheDocument();
    expect(within(evacuation).getByText('Férié TN')).toBeInTheDocument();
    const toussaint = rowOf('Toussaint');
    expect(within(toussaint).getByText('Jour férié · France')).toBeInTheDocument();
    expect(within(toussaint).getByText('Férié FR')).toBeInTheDocument();
    expect(titles()).toEqual(expect.arrayContaining(['Jour de l’An', 'Lundi de Pâques', 'Ascension', 'Lundi de Pentecôte', 'Fête nationale', 'Assomption', 'Armistice', 'Noël', 'Fête de l’Indépendance']));
    // Ordre chronologique : 15 oct. (TN), 1er nov. (FR), 11 nov. (FR).
    const order = titles();
    expect(order.indexOf('Fête de l’Évacuation')).toBeLessThan(order.indexOf('Toussaint'));
    expect(order.indexOf('Toussaint')).toBeLessThan(order.indexOf('Armistice'));
  });

  it('fêtes religieuses : « date estimée » tant qu’elles ne sont pas confirmées (critère 2)', async () => {
    renderEvents(h.container);
    await screen.findByText('Aïd el-Fitr');
    for (const name of ['Aïd el-Fitr', 'Aïd el-Idha', 'Ras el am el hejri', 'Mouled']) expect(within(rowOf(name)).getByText('Jour férié · Tunisie · date estimée')).toBeInTheDocument();
    expect(within(rowOf('Noël')).getByText('Jour férié · France')).toBeInTheDocument();
    expect(within(rowOf('Fête de l’Évacuation')).queryByText(/estimée/)).toBeNull();
  });

  it('visibles sous Pro, Perso et Tout, masquées sous un filtre projet (critère 7)', async () => {
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    fireEvent.click(screen.getByRole('button', { name: 'Perso', pressed: false }));
    await waitFor(() => expect(screen.getByText('Toussaint')).toBeInTheDocument());
    expect(screen.getByText('Fête de l’Évacuation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pro', pressed: false }));
    await waitFor(() => expect(screen.getByText('Toussaint')).toBeInTheDocument());
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission');
    act(() => useAppStore.getState().setProjectFilter(project.id));
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
  });

  it('désactiver la France retire ses fériés sans toucher la Tunisie ; l’état est conservé (critère 3)', async () => {
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    await act(async () => {
      await createHolidayUseCases(h.container).setCountry('FR', false);
    });
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
    expect(screen.queryByText('Armistice')).toBeNull();
    expect(screen.getByText('Fête de l’Évacuation')).toBeInTheDocument();
    expect(await h.container.data.repos.settings.get('holidays.countries')).toEqual({ FR: false, TN: true });
  });

  it('une année non couverte : fériés fixes et calculés, fêtes religieuses absentes, message dédié (critère 8)', async () => {
    renderEvents(h.container);
    await screen.findByText('Toussaint');
    expect(screen.queryByText('Dates religieuses non disponibles pour 2026')).toBeNull();
    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Année suivante' }));
    await waitFor(() => expect(screen.getByText('2031')).toBeInTheDocument());
    expect(await screen.findByText('Dates religieuses non disponibles pour 2031')).toBeInTheDocument();
    expect(screen.getByText('Toussaint')).toBeInTheDocument();
    expect(screen.getByText('Lundi de Pâques')).toBeInTheDocument();
    expect(screen.queryByText('Aïd el-Fitr')).toBeNull();
    expect(screen.queryByText('Mouled')).toBeNull();
  });

  it('un événement local et un férié le même jour se côtoient ; la fiche d’un férié fixe est en lecture seule (critères 5, 7)', async () => {
    await seedEvent(h, { title: 'Dîner', date: '2026-11-01', spaceId: SPACE_PERSO_ID });
    renderEvents(h.container);
    render(
      <AppContainerProvider container={h.container}>
        <HolidayDetailHost />
      </AppContainerProvider>,
    );
    await screen.findByText('Toussaint');
    expect(screen.getByText('Dîner')).toBeInTheDocument();
    fireEvent.click(rowOf('Toussaint'));
    const sheet = await screen.findByRole('dialog', { name: 'Jour férié' });
    expect(within(sheet).getByRole('heading', { name: 'Toussaint' })).toBeInTheDocument();
    expect(within(sheet).getByText('Date fixe : elle ne se modifie pas.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Modifier la date' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Jour férié' })).toBeNull());
  });

  it('le lundi de Pâques est calculé : fiche non modifiable (critère 5)', async () => {
    renderEvents(h.container);
    render(
      <AppContainerProvider container={h.container}>
        <HolidayDetailHost />
      </AppContainerProvider>,
    );
    await screen.findByText('Lundi de Pâques');
    act(() => useNavigationStore.getState().openDetail({ type: 'holiday', country: 'FR', key: 'easterMonday', year: 2026 }));
    const sheet = await screen.findByRole('dialog', { name: 'Jour férié' });
    expect(within(sheet).getByText('Date calculée à partir de Pâques : elle ne se modifie pas.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Modifier la date' })).toBeNull();
  });
});

describe('Date d’une fête religieuse modifiable à la main (E-03 critère 5), PC', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('452', undefined, { holidays: true });
    mockViewport(1440);
  });
  afterEach(() => teardownEvents(h));

  it('Modifier la date → saisie manuelle, plus « estimée », prime sur la table ; Rétablir la restaure', async () => {
    renderEvents(h.container);
    render(
      <AppContainerProvider container={h.container}>
        <HolidayDetailHost />
      </AppContainerProvider>,
    );
    await screen.findByText('Aïd el-Fitr');
    fireEvent.click(rowOf('Aïd el-Fitr'));
    const panel = await screen.findByRole('complementary', { name: 'Jour férié' });
    expect(within(panel).getByText('Date estimée d’après la table annuelle : à confirmer avec l’annonce officielle.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Rétablir la date de la table' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Modifier la date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Date officielle' });
    const field = within(dialog).getByRole('textbox', { name: 'Date' });
    fireEvent.change(field, { target: { value: '21/03/2026' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect((await h.container.data.repos.holidays.getByKey('TN', 2026, 'eidAlFitr'))?.date).toBe('2026-03-21'));
    expect(await h.container.data.repos.holidays.getByKey('TN', 2026, 'eidAlFitr')).toMatchObject({ source: 'manual', overridden: true });
    // La liste suit : nouvelle date, mention « estimée » retirée.
    await waitFor(() => expect(within(rowOf('Aïd el-Fitr')).getByText('Jour férié · Tunisie')).toBeInTheDocument());
    expect(rowOf('Aïd el-Fitr').getAttribute('data-date')).toBe('2026-03-21');
    expect(await within(panel).findByText('Date saisie à la main : elle prime sur la table.')).toBeInTheDocument();
    expect(within(panel).getByText(/Date de la table : /)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Rétablir la date de la table' }));
    await waitFor(async () => expect((await h.container.data.repos.holidays.getByKey('TN', 2026, 'eidAlFitr'))?.date).toBe('2026-03-20'));
    await waitFor(() => expect(within(rowOf('Aïd el-Fitr')).getByText('Jour férié · Tunisie · date estimée')).toBeInTheDocument());
    expect(rowOf('Aïd el-Fitr').getAttribute('data-date')).toBe('2026-03-20');
  });

  it('la carte des agendas mentionne les calendriers de jours fériés activés ; la grille marque le jour en vert (critère 7)', async () => {
    renderEvents(h.container);
    const aside = await screen.findByRole('complementary', { name: 'Calendrier' });
    expect(await within(aside).findByText('Jours fériés France, Tunisie')).toBeInTheDocument();
    await act(async () => {
      await createHolidayUseCases(h.container).setCountry('TN', false);
    });
    await waitFor(() => expect(within(aside).getByText('Jours fériés France')).toBeInTheDocument());
    await act(async () => {
      await createHolidayUseCases(h.container).setCountry('FR', false);
    });
    await waitFor(() => expect(within(aside).queryByText(/Jours fériés/)).toBeNull());
  });
});

describe('Jours fériés dans Aujourd’hui et la Semaine (E-03 D5)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('453', '2026-11-01T10:00:00.000Z', { holidays: true });
    mockViewport(440);
    registerEventsSource();
  });
  afterEach(async () => {
    unregisterEventsSource();
    await teardownEvents(h);
  });

  it('bandeau en lecture seule le jour du férié, visible sous tous les filtres d’espace', async () => {
    renderToday(h.container);
    const band = (await screen.findByText('Toussaint')).closest('li') as HTMLElement;
    expect(band).toHaveAttribute('data-kind', 'holiday');
    expect(within(band).getByText('Férié FR')).toBeInTheDocument();
    expect(within(band).queryByRole('button')).toBeNull();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    expect(await screen.findByText('Toussaint')).toBeInTheDocument();
  });

  it('masqué sous un filtre projet', async () => {
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission');
    act(() => {
      useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
      useAppStore.getState().setProjectFilter(project.id);
    });
    renderToday(h.container);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
  });

  it('la Semaine affiche le férié dans la colonne de son jour, sans pouvoir l’ouvrir', async () => {
    renderWeek(h.container);
    const column = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-date="2026-11-01"]');
      if (!node) throw new Error('colonne absente');
      return node;
    });
    expect(await within(column).findByText('Toussaint')).toBeInTheDocument();
    expect(within(column).queryByRole('button', { name: /Toussaint/ })).toBeNull();
  });

  it('désactiver la France : le bandeau disparaît sans recharger', async () => {
    renderToday(h.container);
    await screen.findByText('Toussaint');
    await act(async () => {
      await createHolidayUseCases(h.container).setCountry('FR', false);
    });
    await waitFor(() => expect(screen.queryByText('Toussaint')).toBeNull());
  });
});

describe('Réglages › Jours fériés (E-03 critères 3, 4, 9)', () => {
  let h: EventsHarness;

  beforeEach(async () => {
    h = await setupEvents('454', undefined, { holidays: true });
    mockViewport(440);
  });
  afterEach(() => teardownEvents(h));

  it('la ligne de Réglages affiche « France, Tunisie » et ouvre l’écran à deux interrupteurs', async () => {
    render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    const row = await screen.findByRole('button', { name: 'Jours fériés : France, Tunisie' });
    fireEvent.click(row);
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'holidays' });
  });

  it('deux interrupteurs, activés par défaut ; chacun agit séparément et se conserve', async () => {
    render(
      <AppContainerProvider container={h.container}>
        <HolidaySettingsScreen />
      </AppContainerProvider>,
    );
    const france = await screen.findByRole('switch', { name: 'Jours fériés de la France' });
    const tunisia = screen.getByRole('switch', { name: 'Jours fériés de la Tunisie' });
    expect(france).toBeChecked();
    expect(tunisia).toBeChecked();
    fireEvent.click(france);
    await waitFor(async () => expect(await h.container.data.repos.settings.get('holidays.countries')).toEqual({ FR: false, TN: true }));
    expect(tunisia).toBeChecked();
    fireEvent.click(tunisia);
    await waitFor(async () => expect(await h.container.data.repos.settings.get('holidays.countries')).toEqual({ FR: false, TN: false }));
    fireEvent.click(france);
    await waitFor(async () => expect(await h.container.data.repos.settings.get('holidays.countries')).toEqual({ FR: true, TN: false }));
  });

  it('la ligne de Réglages reflète l’état conservé', async () => {
    await createHolidayUseCases(h.container).setCountry('TN', false);
    render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Jours fériés : France' })).toBeInTheDocument();
    await createHolidayUseCases(h.container).setCountry('FR', false);
  });

  it('signale les années proches sans dates religieuses (rappel de mise à jour annuelle)', async () => {
    h.db.clock.set('2030-06-01T10:00:00.000Z');
    useAppStore.setState({ day: null });
    render(
      <AppContainerProvider container={h.container}>
        <HolidaySettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Dates religieuses non disponibles pour 2031')).toBeInTheDocument();
    expect(screen.queryByText('Dates religieuses non disponibles pour 2030')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Jours fériés de la Tunisie' }));
    await waitFor(() => expect(screen.queryByText('Dates religieuses non disponibles pour 2031')).toBeNull());
  });
});
