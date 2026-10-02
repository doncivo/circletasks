import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SettingsScreen } from '../settings/SettingsScreen';
import { RecapSettingsScreen } from './RecapSettingsScreen';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { loadRecap } from './recapUseCases';
import { formatRecapSummary, formatRecapTitle } from './recapText';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e4');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/** Réplique du routage de l'App : Réglages › RAPPELS › Récapitulatifs. */
function Routed() {
  const route = useNavigationStore((s) => s.route);
  return route.tab === 'settings' && route.screen === 'reminders' ? <RecapSettingsScreen /> : <SettingsScreen />;
}

describe('Réglages des récapitulatifs (N-04)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    mockViewport(440);
    db = await openTestDb(DEVICE, '2026-09-23T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'home' });
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  const renderApp = () =>
    render(
      <AppContainerProvider container={container}>
        <Routed />
      </AppContainerProvider>,
    );
  const rowButton = () => screen.getByRole('button', { name: /^Récapitulatifs :/ });

  it('installation neuve : section RAPPELS, ligne « Récapitulatifs » = « 07:30 · 21:00 » (QB-09, critères 1, 9)', async () => {
    renderApp();
    expect(screen.getByText('RAPPELS')).toBeInTheDocument();
    expect(rowButton()).toHaveTextContent('07:30 · 21:00');
  });

  it('la ligne ouvre l’écran : Matin et Soir, interrupteur et heure 24 h chacun (critère 2)', async () => {
    renderApp();
    fireEvent.click(rowButton());
    expect(await screen.findByRole('heading', { name: 'Récapitulatifs' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Récapitulatif du matin' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Récapitulatif du soir' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Heure du récapitulatif du matin (HH:MM)')).toHaveValue('07:30');
    expect(screen.getByLabelText('Heure du récapitulatif du soir (HH:MM)')).toHaveValue('21:00');
    // iPhone : pas de mention « Envoyé sur l'iPhone » (réservée au PC).
    expect(screen.queryByText('Envoyé sur l’iPhone')).toBeNull();
  });

  it('matin à 07:00 : enregistré dans le réglage partagé, ligne « 07:00 · 21:00 », persiste après redémarrage (critère 3)', async () => {
    renderApp();
    fireEvent.click(rowButton());
    const morning = await screen.findByLabelText('Heure du récapitulatif du matin (HH:MM)');
    fireEvent.change(morning, { target: { value: '7h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(rowButton()).toHaveTextContent('07:00 · 21:00'));
    expect(await db.data.repos.settings.get('reminders.morningRecap')).toEqual({ enabled: true, time: '07:00' });

    // Redémarrage : nouveau conteneur sur la même base.
    cleanup();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    renderApp();
    await waitFor(() => expect(rowButton()).toHaveTextContent('07:00 · 21:00'));
  });

  it('désactiver le soir : la ligne n’affiche que l’heure active ; les deux désactivés : « Désactivés » (critère 1)', async () => {
    renderApp();
    fireEvent.click(rowButton());
    fireEvent.click(await screen.findByRole('switch', { name: 'Récapitulatif du soir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(rowButton()).toHaveTextContent('07:30'));
    expect(rowButton()).not.toHaveTextContent('21:00');
    fireEvent.click(rowButton());
    fireEvent.click(await screen.findByRole('switch', { name: 'Récapitulatif du matin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(rowButton()).toHaveTextContent('Désactivés'));
  });

  it('matin ≥ soir : refusé avec le message, rien d’écrit (critère 4)', async () => {
    renderApp();
    fireEvent.click(rowButton());
    fireEvent.change(await screen.findByLabelText('Heure du récapitulatif du matin (HH:MM)'), { target: { value: '22:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('L’heure du soir doit suivre celle du matin');
    expect(await db.data.repos.settings.get('reminders.morningRecap')).toEqual({ enabled: true, time: '07:30' });
    expect(screen.getByRole('heading', { name: 'Récapitulatifs' })).toBeInTheDocument();
  });

  it('heure illisible : message d’erreur, rien d’écrit', async () => {
    renderApp();
    fireEvent.click(rowButton());
    fireEvent.change(await screen.findByLabelText('Heure du récapitulatif du soir (HH:MM)'), { target: { value: '25:99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Heure invalide');
  });

  it('PC : l’écran indique « Envoyé sur l’iPhone » (critère 7)', async () => {
    mockViewport(1440);
    renderApp();
    fireEvent.click(rowButton());
    expect(await screen.findByText('Envoyé sur l’iPhone')).toBeInTheDocument();
  });

  it('textes : titres du matin et du soir (critères 5, 6)', () => {
    expect(formatRecapTitle({ kind: 'morning', count: 5 })).toBe('5 éléments aujourd’hui');
    expect(formatRecapTitle({ kind: 'morning', count: 1 })).toBe('1 élément aujourd’hui');
    expect(formatRecapTitle({ kind: 'evening', count: 4 })).toBe('4 éléments non faits');
    expect(formatRecapTitle({ kind: 'evening', count: 0 })).toBe('Tout est fait');
    expect(formatRecapSummary({ morning: { enabled: false, time: '07:30' as never }, evening: { enabled: false, time: '21:00' as never } })).toBe('Désactivés');
  });

  it('loadRecap lit la base, tous espaces : 3 tâches dont 1 faite, matin 3 éléments, soir 2 (critères 5, 6, 8)', async () => {
    const { repos } = container.data;
    const spaces = await repos.spaces.listAll();
    const useCases = createTaskUseCases(container);
    const day = '2026-09-23' as never;
    const [pro, perso] = spaces;
    if (!pro || !perso) throw new Error('espaces');
    await useCases.create({ title: 'A', spaceId: pro.id, date: day });
    await useCases.create({ title: 'B', spaceId: perso.id, date: day });
    const c = await useCases.create({ title: 'C', spaceId: pro.id, date: day });
    if (!c.ok) throw new Error('création');
    await useCases.complete(c.value.id);
    const morning = await loadRecap(container, 'morning', day);
    const evening = await loadRecap(container, 'evening', day);
    expect(morning.count).toBe(3);
    expect(evening.count).toBe(2);
    expect(evening.lines.map((line) => line.title).sort()).toEqual(['A', 'B']);
  });
});
