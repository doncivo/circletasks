import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { setFormatPrefs, getFirstWeekday, getTimeFormat } from '../../i18n/formatPrefs';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { AppearanceScreen } from './AppearanceScreen';
import { restoreAppearance } from './appearance';
import { SettingsScreen } from './SettingsScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000008');

describe('Apparence et formats (P-03)', () => {
  let db: TestDb;
  let container: AppContainer;
  const renderIn = (ui: React.ReactElement) => render(<AppContainerProvider container={container}>{ui}</AppContainerProvider>);

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    setFormatPrefs({ firstWeekday: 'monday', timeFormat: '24h' });
  });

  afterEach(async () => {
    cleanup();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    setFormatPrefs({ firstWeekday: 'monday', timeFormat: '24h' });
    await db.close();
  });

  it('propose Lundi (défaut), Samedi, Dimanche et 24 h (défaut) ou 12 h en groupes radio (critères 1, 5 et 11)', async () => {
    renderIn(<AppearanceScreen />);
    const week = await screen.findByRole('radiogroup', { name: 'Premier jour de la semaine' });
    expect(within(week).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Lundi', 'Samedi', 'Dimanche']);
    expect(within(week).getByRole('radio', { name: 'Lundi' })).toBeChecked();
    const time = screen.getByRole('radiogroup', { name: 'Format de l’heure' });
    expect(within(time).getByRole('radio', { name: '24 h' })).toBeChecked();
    expect(screen.getByText('Exemple : 15:30')).toBeInTheDocument();
  });

  it('la langue est affichée en lecture seule avec son aide (critère 4)', async () => {
    renderIn(<AppearanceScreen />);
    expect(await screen.findByText('Français')).toBeInTheDocument();
    expect(screen.getByText('D’autres langues ne sont pas prévues')).toBeInTheDocument();
  });

  it('choisir Dimanche et 12 h change aussitôt l’affichage et enregistre les réglages partagés (critères 2, 6, 8, 9)', async () => {
    renderIn(<AppearanceScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Dimanche' }));
    fireEvent.click(screen.getByRole('radio', { name: '12 h' }));
    expect(getFirstWeekday()).toBe('sunday');
    expect(getTimeFormat()).toBe('12h');
    expect(screen.getByText('Exemple : 3:30 PM')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.data.repos.settings.get('general.firstWeekday')).toBe('sunday');
      expect(await db.data.repos.settings.get('general.timeFormat')).toBe('12h');
    });
  });

  it('flèche droite déplace le choix dans le groupe', async () => {
    renderIn(<AppearanceScreen />);
    const monday = await screen.findByRole('radio', { name: 'Lundi' });
    monday.focus();
    fireEvent.keyDown(monday, { key: 'ArrowRight' });
    expect(getFirstWeekday()).toBe('saturday');
  });

  it('une écriture qui échoue rétablit la valeur enregistrée', async () => {
    container = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: { ...db.data, repos: { ...db.data.repos, settings: { ...db.data.repos.settings, set: () => Promise.reject(new Error('boom')) } } } as never,
    });
    renderIn(<AppearanceScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: '12 h' }));
    await waitFor(() => expect(getTimeFormat()).toBe('24h'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer ce réglage.');
  });

  it('restoreAppearance applique les réglages enregistrés avant le premier rendu (critère 8)', async () => {
    await db.data.repos.settings.set('general.firstWeekday', 'saturday');
    await db.data.repos.settings.set('general.timeFormat', '12h');
    await restoreAppearance(container);
    expect(getFirstWeekday()).toBe('saturday');
    expect(getTimeFormat()).toBe('12h');
  });

  it('la ligne de Réglages affiche « lundi · 24 h » puis « dimanche · 12 h » (critère 9)', async () => {
    renderIn(<SettingsScreen />);
    expect(await screen.findByRole('button', { name: 'Thème · semaine · heure : lundi · 24 h' })).toBeInTheDocument();
    await container.data.repos.settings.set('general.firstWeekday', 'sunday');
    await container.data.repos.settings.set('general.timeFormat', '12h');
    cleanup();
    renderIn(<AppearanceScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Dimanche' }));
    cleanup();
    renderIn(<SettingsScreen />);
    expect(await screen.findByRole('button', { name: /dimanche · 12 h/ })).toBeInTheDocument();
  });
});
