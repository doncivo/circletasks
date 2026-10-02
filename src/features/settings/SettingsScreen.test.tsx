import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import type { DataAccess } from '../../db/repositories';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { SettingsScreen } from './SettingsScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000007');

describe('SettingsScreen (T-06)', () => {
  let db: TestDb;
  let container: AppContainer;

  const containerWith = (data: DataAccess): AppContainer =>
    createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data });
  const failing = (method: 'get' | 'set'): DataAccess =>
    ({
      ...db.data,
      repos: { ...db.data.repos, settings: { ...db.data.repos.settings, [method]: () => Promise.reject(new Error('boom')) } },
    }) as DataAccess;
  const renderScreen = (c: AppContainer = container) =>
    render(
      <AppContainerProvider container={c}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
  const toggle = () => screen.getByRole('switch', { name: 'Reporter les tâches non faites' });

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    container = containerWith(db.data);
  });

  afterEach(async () => {
    cleanup();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useAppStore.setState({ timeZone: null });
    await db.close();
  });

  it('T-11 : la ligne « Fuseau horaire » affiche le fuseau courant suivi de « (automatique) » (critère 5)', () => {
    useAppStore.setState({ timeZone: 'Europe/Paris' });
    renderScreen();
    expect(screen.getByText('GÉNÉRAL')).toBeInTheDocument();
    expect(screen.getByText('Fuseau horaire')).toBeInTheDocument();
    expect(screen.getByText('Europe/Paris (automatique)')).toBeInTheDocument();
  });

  it('T-11 : le fuseau suit le store quand il change (critère 6)', async () => {
    useAppStore.setState({ timeZone: 'Europe/Paris' });
    renderScreen();
    useAppStore.getState().setTimeZone('Africa/Tunis');
    expect(await screen.findByText('Africa/Tunis (automatique)')).toBeInTheDocument();
  });

  it('installation neuve : l’interrupteur est activé (critère 11)', async () => {
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Réglages' })).toBeInTheDocument();
    expect(screen.getByText('TÂCHES')).toBeInTheDocument();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('bascule : le choix est enregistré dans le réglage partagé et relu à la réouverture (critère 8)', async () => {
    renderScreen();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    toggle().click();
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
    await waitFor(async () => expect(await db.data.repos.settings.get('tasks.carryOverUndone')).toBe(false));
    cleanup();
    // Nouveau conteneur sur la même base : store neuf, valeur relue depuis le repository.
    renderScreen(containerWith(db.data));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
  });

  it('échec d’écriture : retour à la valeur enregistrée et message', async () => {
    renderScreen(containerWith(failing('set')));
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    toggle().click();
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer ce réglage.');
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('section « DONNÉES ET SÉCURITÉ » : la ligne « Corbeille » ouvre l’écran Corbeille (T-08, critère 5)', async () => {
    renderScreen();
    expect(screen.getByRole('heading', { name: 'DONNÉES ET SÉCURITÉ' })).toBeInTheDocument();
    expect(screen.getByText('Corbeille')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Ouvrir la corbeille' }).click();
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'trash' });
  });

  describe('« Masquer les routines de la liste » (A-03)', () => {
    const hide = () => screen.getByRole('switch', { name: 'Masquer les routines de la liste' });

    it('est désactivé par défaut, dans la section TÂCHES (critère 1)', async () => {
      renderScreen();
      await waitFor(() => expect(hide()).not.toBeDisabled());
      expect(hide()).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByText('Masquer les routines de la liste')).toBeInTheDocument();
    });

    it('bascule, s’enregistre dans le réglage partagé et persiste après redémarrage (critère 6)', async () => {
      renderScreen();
      await waitFor(() => expect(hide()).not.toBeDisabled());
      hide().click();
      await waitFor(() => expect(hide()).toHaveAttribute('aria-checked', 'true'));
      await waitFor(async () => expect(await db.data.repos.settings.get('today.hideRoutines')).toBe(true));
      cleanup();
      renderScreen(containerWith(db.data));
      await waitFor(() => expect(hide()).toHaveAttribute('aria-checked', 'true'));
      hide().click();
      await waitFor(async () => expect(await db.data.repos.settings.get('today.hideRoutines')).toBe(false));
    });

    it('est un bouton focalisable annoncé « interrupteur, activé / désactivé » (critère 8 ; Espace : e2e)', async () => {
      renderScreen();
      await waitFor(() => expect(hide()).not.toBeDisabled());
      expect(hide().tagName).toBe('BUTTON');
      expect(hide()).toHaveAttribute('role', 'switch');
      hide().focus();
      expect(hide()).toHaveFocus();
    });

    it('échec d’écriture : retour à la valeur enregistrée et message', async () => {
      renderScreen(containerWith(failing('set')));
      await waitFor(() => expect(hide()).not.toBeDisabled());
      hide().click();
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer ce réglage.');
      expect(hide()).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('échec de lecture : message, pas de rejet', async () => {
    renderScreen(containerWith(failing('get')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de lire les réglages.');
  });
});
