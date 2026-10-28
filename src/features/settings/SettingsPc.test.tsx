import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SettingsScreen } from './SettingsScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d9');
const SECTIONS = ['Général', 'Tâches', 'Rappels', 'Espaces et agendas', 'Synchronisation', 'Sauvegardes et données', 'Clavier', 'À propos'];

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/**
 * UI-REFONTE-09 — Réglages sur PC (docs/maquettes-refonte/PC-Reglages.html) : sommaire à gauche, colonne bornée, titres en minuscules,
 * « Général » en six lignes (Thème, Début de semaine, Format de l'heure, Fuseau horaire, Onglets visibles, Démarrer avec Windows),
 * « Clavier » avec « Tous les raccourcis » et le conflit expliqué en une phrase. L'iPhone ne change pas.
 */
describe('UI-REFONTE-09 — Réglages sur PC (PC-Reglages.html)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let container: AppContainer;
  let scrolled: Element[];

  const containerWith = (d: FakeDesktop | null): AppContainer =>
    createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop: d });
  const renderScreen = (c: AppContainer = container) =>
    render(
      <AppContainerProvider container={c}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
  const ready = () => screen.findByRole('switch', { name: 'Démarrer avec Windows' });
  const region = (name: string) => screen.getByRole('region', { name });
  const summary = () => screen.getByRole('group', { name: 'Sections des réglages' });

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = containerWith(desktop);
    mockViewport(1440);
    useAppStore.setState({ timeZone: 'Europe/Paris' });
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useAppStore.setState({ timeZone: null });
    await db.close();
  });

  it('sommaire : titre, huit sections dans l’ordre en minuscules, section courante, un clic fait défiler la section (critères 1, 2)', async () => {
    renderScreen();
    await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument();
    const nav = summary();
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(SECTIONS);
    for (const name of SECTIONS) expect(within(region(name)).getByRole('heading', { level: 2, name })).toBeInTheDocument();
    for (const old of ['GÉNÉRAL', 'TÂCHES', 'RAPPELS', 'ESPACES ET CALENDRIERS', 'SYNCHRONISATION', 'DONNÉES ET SÉCURITÉ', 'CLAVIER', 'À PROPOS']) {
      expect(screen.queryByText(old)).toBeNull();
    }
    expect(within(nav).getByRole('button', { name: 'Général' })).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('button', { name: 'À propos' })).not.toHaveAttribute('aria-current');
    fireEvent.click(within(nav).getByRole('button', { name: 'À propos' }));
    expect(scrolled).toEqual([region('À propos')]);
    expect(within(nav).getByRole('button', { name: 'À propos' })).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('button', { name: 'Général' })).not.toHaveAttribute('aria-current');
    expect(document.querySelector('.ct-settings__rule')).toBeNull();
  });

  it('Général : Thème, Début de semaine et Format de l’heure en trois lignes vers Apparence ; Onglets visibles « 5 sur 5 » ; fuseau expliqué ; démarrage expliqué (critère 3)', async () => {
    renderScreen();
    await ready();
    const general = region('Général');
    expect(within(general).queryByRole('button', { name: /^Thème · semaine · heure/ })).toBeNull();
    const rows = ['Thème : Système', 'Début de semaine : Lundi', 'Format de l’heure : 24 h'];
    for (const name of rows) {
      fireEvent.click(within(general).getByRole('button', { name }));
      expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'appearance' });
      useNavigationStore.setState(INITIAL_NAVIGATION);
    }
    fireEvent.click(within(general).getByRole('button', { name: 'Onglets visibles : 5 sur 5' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'tabs' });
    expect(within(general).getByText('Fuseau horaire')).toBeInTheDocument();
    expect(within(general).getByText('Suit celui de Windows')).toBeInTheDocument();
    expect(within(general).getByText('Europe/Paris')).toBeInTheDocument();
    expect(screen.queryByText(/\(automatique\)/)).toBeNull();
    expect(within(general).getByText('CircleTasks s’ouvre réduit dans la zone de notification')).toBeInTheDocument();
    expect(within(general).getByRole('switch', { name: 'Démarrer avec Windows' })).toBeInTheDocument();
  });

  it('les lignes partagées rejoignent leurs sections (critère 4)', async () => {
    renderScreen();
    await ready();
    const tasks = region('Tâches');
    expect(within(tasks).getByRole('switch', { name: 'Reporter les tâches non faites' })).toBeInTheDocument();
    expect(within(tasks).getByRole('switch', { name: 'Masquer les routines de la liste' })).toBeInTheDocument();
    expect(within(region('Rappels')).getByRole('button', { name: /^Récapitulatifs :/ })).toBeInTheDocument();
    const spaces = region('Espaces et agendas');
    expect(within(spaces).getByRole('button', { name: /^Espaces et projets :/ })).toBeInTheDocument();
    expect(within(spaces).getByRole('button', { name: /^Agendas · Rappels Apple :/ })).toBeInTheDocument();
    expect(within(spaces).getByRole('button', { name: /^Jours fériés :/ })).toBeInTheDocument();
    expect(within(tasks).queryByRole('button', { name: /^Jours fériés :/ })).toBeNull();
    const data = region('Sauvegardes et données');
    expect(within(data).getByRole('button', { name: 'Ouvrir la corbeille' })).toBeInTheDocument();
    expect(within(data).getByRole('button', { name: 'Importer des tâches depuis un fichier CSV' })).toBeInTheDocument();
    const about = region('À propos');
    expect(within(about).getByRole('button', { name: 'Rechercher une mise à jour' })).toBeInTheDocument();
    expect(within(about).getByRole('button', { name: 'Revoir le guide de bienvenue' })).toBeInTheDocument();
  });

  it('Clavier : « Tous les raccourcis » avec « Ctrl / » ouvre la liste ; une combinaison prise s’explique en une phrase, sans note barrée (critère 5)', async () => {
    desktop.takenChords.add('Ctrl+Alt+Space');
    renderScreen();
    await ready();
    const keyboard = region('Clavier');
    const all = within(keyboard).getByRole('button', { name: 'Afficher les raccourcis clavier' });
    expect(all).toHaveTextContent('Tous les raccourcis');
    expect(all).toHaveTextContent('Ctrl /');
    expect(all).toHaveClass('ct-settings__rowButton');
    expect(screen.queryByText('Raccourcis clavier')).toBeNull();
    fireEvent.click(all);
    expect(useNavigationStore.getState().overlays).toEqual([{ kind: 'shortcutsHelp' }]);
    const sentence = await within(keyboard).findByText('Ctrl+Alt+Espace est utilisé par une autre application. Choisissez-en un autre.');
    expect(sentence).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByText('Indisponible : combinaison prise par une autre application')).toBeNull();
    expect(within(keyboard).getByRole('button', { name: /^Capture rapide : Ctrl\+Alt\+Espace/ })).toHaveAttribute('data-state', 'unavailable');
  });

  it('iPhone : écran inchangé (critère 7)', async () => {
    mockViewport(440);
    renderScreen(containerWith(null));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Reporter les tâches non faites' })).not.toBeDisabled());
    expect(screen.queryByRole('navigation', { name: 'Sections des réglages' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'GÉNÉRAL' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'DONNÉES ET SÉCURITÉ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Thème · semaine · heure :/ })).toBeInTheDocument();
    expect(screen.getByText('Europe/Paris (automatique)')).toBeInTheDocument();
    expect(screen.queryByText('Suit celui de Windows')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thème : Système' })).toBeNull();
  });
});
