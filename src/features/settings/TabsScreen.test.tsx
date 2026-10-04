import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { DEFAULT_TABS_CONFIG } from '../../domain/tabs';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import type { KeyInput } from '../app/shortcuts';
import { registerTabShortcuts } from '../app/tabShortcuts';
import { useTabsConfigStore } from '../app/tabsConfig';
import { restoreAppearance } from './appearance';
import { SettingsScreen } from './SettingsScreen';
import { TabsScreen } from './TabsScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000009');
const alt = (digit: number): KeyInput => ({ key: String(digit), code: `Digit${String(digit)}`, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, editable: false });

describe('Onglets (P-01)', () => {
  let db: TestDb;
  let container: AppContainer;
  const renderIn = (ui: React.ReactElement) => render(<AppContainerProvider container={container}>{ui}</AppContainerProvider>);
  const names = (): string[] =>
    within(screen.getByRole('list', { name: 'Onglets de la colonne' }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.ct-tabs__name')?.firstChild?.textContent ?? '');
  const stored = () => db.data.repos.settings.get('ui.tabs');

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useTabsConfigStore.setState({ config: DEFAULT_TABS_CONFIG });
  });

  afterEach(async () => {
    cleanup();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useTabsConfigStore.setState({ config: DEFAULT_TABS_CONFIG });
    await db.close();
  });

  it('liste cinq onglets avec poignée, pastille et interrupteur « Afficher », et rappelle que Réglages reste en bas (critère 1)', () => {
    renderIn(<TabsScreen />);
    expect(names()).toEqual(['Tâches', 'Semaine', 'Routines', 'Événements', 'Checklists']);
    expect(screen.getByText('Réglages reste toujours en bas.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Afficher Réglages' })).toBeNull();
    for (const name of ['Semaine', 'Routines', 'Événements', 'Checklists']) {
      expect(screen.getByRole('switch', { name: `Afficher ${name}` })).toBeChecked();
      expect(screen.getByRole('button', { name: `Déplacer l’onglet ${name}` })).toBeInTheDocument();
    }
  });

  it('Tâches : interrupteur inactif « Toujours affiché », sans poignée (critère 5)', () => {
    renderIn(<TabsScreen />);
    const tasks = screen.getByRole('switch', { name: 'Afficher Tâches' });
    expect(tasks).toBeDisabled();
    expect(tasks).toBeChecked();
    expect(screen.getByText('Toujours affiché')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Déplacer l’onglet Tâches' })).toBeNull();
  });

  it('↑ deux fois sur la poignée de Checklists la place au-dessus de Routines, annonce la position et enregistre (critères 2 et 3)', async () => {
    renderIn(<TabsScreen />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer l’onglet Checklists' }), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer l’onglet Checklists' }), { key: 'ArrowUp' });
    expect(names()).toEqual(['Tâches', 'Semaine', 'Checklists', 'Routines', 'Événements']);
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Checklists, position 3 sur 5');
    await waitFor(async () => expect((await stored()).order).toEqual(['week', 'checklists', 'routines', 'events']));
  });

  it('glisser la poignée de Checklists au-dessus de Routines change la colonne aussitôt et l’ordre est enregistré (critère 2)', async () => {
    const ROWS = ['tasks', 'week', 'routines', 'events', 'checklists'];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = ROWS.indexOf(this.dataset['sortableId'] ?? '') * 50;
      return { top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y: top, toJSON: () => ({}) };
    });
    const pointer = (target: EventTarget, type: string, clientY: number): void => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    renderIn(<TabsScreen />);
    pointer(screen.getByRole('button', { name: 'Déplacer l’onglet Checklists' }), 'pointerdown', 225);
    pointer(window, 'pointermove', 120); // centre 120 : après Semaine (75), avant Routines (125)
    pointer(window, 'pointerup', 120);
    expect(useTabsConfigStore.getState().config.order).toEqual(['week', 'checklists', 'routines', 'events']);
    expect(names()).toEqual(['Tâches', 'Semaine', 'Checklists', 'Routines', 'Événements']);
    await waitFor(async () => expect((await stored()).order).toEqual(['week', 'checklists', 'routines', 'events']));
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.restoreAllMocks();
  });

  it('↓ sur la dernière ligne et ↑ sur la première ligne modifiable ne font rien', () => {
    renderIn(<TabsScreen />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer l’onglet Checklists' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer l’onglet Semaine' }), { key: 'ArrowUp' });
    expect(names()).toEqual(['Tâches', 'Semaine', 'Routines', 'Événements', 'Checklists']);
  });

  it('désactiver Événements le retire de la colonne, le rétablir le remet (critère 4)', async () => {
    renderIn(<TabsScreen />);
    fireEvent.click(screen.getByRole('switch', { name: 'Afficher Événements' }));
    expect(useTabsConfigStore.getState().config.hidden).toEqual(['events']);
    expect(screen.getByRole('switch', { name: 'Afficher Événements' })).not.toBeChecked();
    await waitFor(async () => expect((await stored()).hidden).toEqual(['events']));
    fireEvent.click(screen.getByRole('switch', { name: 'Afficher Événements' }));
    expect(useTabsConfigStore.getState().config.hidden).toEqual([]);
  });

  it('les raccourcis suivent l’onglet, pas sa position ; un onglet masqué n’y répond plus (critère 6)', () => {
    const off = registerTabShortcuts(container.shortcuts, () => false);
    useTabsConfigStore.setState({ config: { order: ['checklists', 'week', 'routines', 'events'], hidden: ['events'] } });
    container.shortcuts.handle(alt(5));
    expect(useNavigationStore.getState().route.tab).toBe('checklists');
    container.shortcuts.handle(alt(2));
    expect(useNavigationStore.getState().route.tab).toBe('week');
    container.shortcuts.handle(alt(4)); // Événements masqué
    expect(useNavigationStore.getState().route.tab).toBe('week');
    container.shortcuts.handle(alt(6));
    expect(useNavigationStore.getState().route.tab).toBe('settings');
    off();
  });

  it('un lien (navigate) ouvre quand même un onglet masqué, qui reste atteignable depuis lui-même (critère 7)', () => {
    useTabsConfigStore.setState({ config: { order: [], hidden: ['events'] } });
    useNavigationStore.getState().navigate({ tab: 'events' });
    expect(useNavigationStore.getState().route.tab).toBe('events');
    useNavigationStore.getState().goToTab('events');
    expect(useNavigationStore.getState().route.tab).toBe('events');
  });

  it('« Rétablir l’ordre par défaut » remet l’ordre et affiche tout ; annulable (critère 8)', async () => {
    useTabsConfigStore.setState({ config: { order: ['checklists', 'week', 'routines', 'events'], hidden: ['events', 'week'] } });
    renderIn(<TabsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Rétablir l’ordre par défaut' }));
    expect(useTabsConfigStore.getState().config).toEqual(DEFAULT_TABS_CONFIG);
    expect(names()).toEqual(['Tâches', 'Semaine', 'Routines', 'Événements', 'Checklists']);
    await waitFor(async () => expect(await stored()).toEqual({ order: [], hidden: [] }));
    const result = await container.undo.undoLast();
    expect(result.status).toBe('undone');
    expect(useTabsConfigStore.getState().config.hidden).toEqual(['events', 'week']);
    await waitFor(async () => expect((await stored()).order).toEqual(['checklists', 'week', 'routines', 'events']));
  });

  it('le réglage est local et survit au redémarrage ; un identifiant inconnu est ignoré (critères 2 et 9)', async () => {
    await db.data.repos.settings.set('ui.tabs', { order: ['future', 'checklists'], hidden: ['future', 'events'] });
    await restoreAppearance(container);
    expect(useTabsConfigStore.getState().config).toEqual({ order: ['future', 'checklists'], hidden: ['future', 'events'] });
    renderIn(<TabsScreen />);
    expect(names()).toEqual(['Tâches', 'Checklists', 'Semaine', 'Routines', 'Événements']);
    expect(screen.getByRole('switch', { name: 'Afficher Événements' })).not.toBeChecked();
  });

  it('une valeur corrompue en base est assainie', async () => {
    await db.data.repos.settings.set('ui.tabs', { order: 'oups', hidden: [1, 'events'] } as never);
    await restoreAppearance(container);
    expect(useTabsConfigStore.getState().config).toEqual({ order: [], hidden: ['events'] });
  });

  it('une écriture qui échoue rétablit la disposition précédente', async () => {
    container = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: { ...db.data, repos: { ...db.data.repos, settings: { ...db.data.repos.settings, set: () => Promise.reject(new Error('boom')) } } } as never,
    });
    renderIn(<TabsScreen />);
    fireEvent.click(screen.getByRole('switch', { name: 'Afficher Semaine' }));
    await waitFor(() => expect(useTabsConfigStore.getState().config).toEqual(DEFAULT_TABS_CONFIG));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer ce réglage.');
  });

  it('la ligne « Onglets » de Réglages affiche « 5 visibles » puis « 4 visibles » et ouvre l’écran', async () => {
    renderIn(<SettingsScreen />);
    expect(await screen.findByRole('button', { name: 'Onglets : 5 visibles' })).toBeInTheDocument();
    useTabsConfigStore.setState({ config: { order: [], hidden: ['events'] } });
    const row = await screen.findByRole('button', { name: 'Onglets : 4 visibles' });
    fireEvent.click(row);
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'tabs' });
  });
});
