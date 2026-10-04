import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, fakePendingUpdate, type FakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { updaterStore } from '../updater';
import { SettingsScreen } from './SettingsScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d2');

describe('SettingsScreen PC (D-02, D-03)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let container: AppContainer;

  const containerWith = (d: FakeDesktop | null): AppContainer =>
    createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop: d });
  const renderScreen = (c: AppContainer = container) =>
    render(
      <AppContainerProvider container={c}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
  const startup = () => screen.getByRole('switch', { name: 'Démarrer avec Windows' });

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = containerWith(desktop);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await db.close();
  });

  describe('démarrage avec Windows (D-02)', () => {
    it('hors PC : pas de ligne « Démarrer avec Windows » ni de ligne de mise à jour (critère 1 ; GÉNÉRAL porte le fuseau de T-11 ; À PROPOS ne porte que le guide, P-05)', async () => {
      renderScreen(containerWith(null));
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Reporter les tâches non faites' })).not.toBeDisabled());
      expect(screen.queryByRole('switch', { name: 'Démarrer avec Windows' })).not.toBeInTheDocument();
      expect(screen.getByText('À PROPOS')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Rechercher une mise à jour' })).not.toBeInTheDocument();
    });

    it('sur PC : section GÉNÉRAL, interrupteur désactivé par défaut (critère 1)', async () => {
      renderScreen();
      expect(await screen.findByText('GÉNÉRAL')).toBeInTheDocument();
      await waitFor(() => expect(startup()).toHaveAttribute('aria-checked', 'false'));
    });

    it('activer crée l’entrée et mémorise le réglage local ; désactiver la supprime (critères 2 et 3)', async () => {
      renderScreen();
      await screen.findByText('GÉNÉRAL');
      startup().click();
      await waitFor(() => expect(startup()).toHaveAttribute('aria-checked', 'true'));
      await waitFor(() => expect(desktop.autostart).toBe(true));
      await waitFor(async () => expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(true));
      startup().click();
      await waitFor(() => expect(desktop.autostart).toBe(false));
      await waitFor(async () => expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(false));
    });

    it('entrée retirée hors de l’app : l’interrupteur reflète l’état réel et le réglage local est réaligné (critère 6)', async () => {
      await db.data.repos.settings.set('desktop.launchAtStartup', true);
      desktop.autostart = false;
      renderScreen();
      await screen.findByText('GÉNÉRAL');
      await waitFor(() => expect(startup()).toHaveAttribute('aria-checked', 'false'));
      await waitFor(async () => expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(false));
    });

    it('entrée présente : interrupteur activé à l’ouverture', async () => {
      desktop.autostart = true;
      renderScreen();
      await waitFor(() => expect(startup()).toHaveAttribute('aria-checked', 'true'));
    });

    it('échec du registre : retour à l’état précédent et message', async () => {
      renderScreen();
      await screen.findByText('GÉNÉRAL');
      desktop.failAutostart = true;
      startup().click();
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de modifier le démarrage avec Windows.');
      expect(startup()).toHaveAttribute('aria-checked', 'false');
      expect(await db.data.repos.settings.get('desktop.launchAtStartup')).toBe(false);
    });
  });

  describe('À propos (D-03)', () => {
    it('affiche la version installée et le bouton de recherche (critère 7)', async () => {
      desktop.version = '0.1.0';
      renderScreen();
      expect(await screen.findByText('Version 0.1.0')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Rechercher une mise à jour' })).toBeEnabled();
    });

    it('à jour : « CircleTasks est à jour »', async () => {
      renderScreen();
      (await screen.findByRole('button', { name: 'Rechercher une mise à jour' })).click();
      expect(await screen.findByText('CircleTasks est à jour')).toBeInTheDocument();
    });

    it('latest.json inaccessible : « Impossible de vérifier les mises à jour »', async () => {
      desktop.nextCheck = new Error('hors ligne');
      renderScreen();
      (await screen.findByRole('button', { name: 'Rechercher une mise à jour' })).click();
      expect(await screen.findByText('Impossible de vérifier les mises à jour')).toBeInTheDocument();
    });

    it('nouvelle version : l’état du store propose le bandeau (rendu par la coquille)', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0');
      renderScreen();
      (await screen.findByRole('button', { name: 'Rechercher une mise à jour' })).click();
      await waitFor(() => expect(updaterStore.get(container).getState()).toMatchObject({ status: 'available', bannerVisible: true }));
    });

    it('le lien « Dernière version » ouvre la page des versions', async () => {
      renderScreen();
      (await screen.findByRole('button', { name: 'Ouvrir la page de la dernière version' })).click();
      await waitFor(() => expect(desktop.openedReleases).toBe(1));
    });

    it('échec d’ouverture du lien : message', async () => {
      desktop.openLatestRelease = () => Promise.reject(new Error('navigateur introuvable'));
      renderScreen();
      (await screen.findByRole('button', { name: 'Ouvrir la page de la dernière version' })).click();
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’ouvrir la page de la dernière version.');
    });
  });
});
