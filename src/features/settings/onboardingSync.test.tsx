// Y-06 critère 15 (P-05, D5) : étape « Synchronisation » de l'assistant, seulement quand la synchro est disponible.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { MemorySyncFolder, createMemorySyncPlatform, type MemorySyncPlatform } from '../../platform/sync';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createFakeSyncService, type FakeSyncService } from '../sync/testKit';
import { OnboardingHost } from './OnboardingHost';
import { onboardingCapabilities, onboardingStore } from './onboardingStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a6');

describe('étape « Synchronisation » de l’assistant (critère 15)', () => {
  let db: TestDb;
  let platform: MemorySyncPlatform;
  let sync: FakeSyncService;

  const containerWith = (runtime: 'tauri' | 'web', syncPlatform: MemorySyncPlatform | null): AppContainer =>
    createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: db.data,
      platform: { runtime, os: 'windows' },
      syncPlatform,
      sync: syncPlatform ? sync : null,
    });

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-05T08:00:00.000Z');
    platform = createMemorySyncPlatform({ folder: new MemorySyncFolder() });
    sync = createFakeSyncService({ phase: 'not-configured' });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('min-width: 1024px'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    delete (globalThis as { __ctSync?: unknown }).__ctSync;
    useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  it('disponibilité : app installée avec synchro, ou simulateur de développement ; sinon 3 étapes', () => {
    expect(onboardingCapabilities(containerWith('tauri', platform)).pairing).toBe(true);
    expect(onboardingCapabilities(containerWith('tauri', null)).pairing).toBe(false);
    expect(onboardingCapabilities(containerWith('tauri', createMemorySyncPlatform({ available: false }))).pairing).toBe(false);
    expect(onboardingCapabilities(containerWith('web', platform)).pairing).toBe(false);
    (globalThis as { __ctSync?: unknown }).__ctSync = platform;
    expect(onboardingCapabilities(containerWith('web', platform)).pairing).toBe(true);
  });

  it('PC : « Étape 3 sur 4 » avant les données d’exemple, réutilise la section de Réglages, passable ; relançable', async () => {
    const container = containerWith('tauri', platform);
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    render(
      <AppContainerProvider container={container}>
        <OnboardingHost />
      </AppContainerProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(onboardingStore.get(container).getState().steps).toEqual(['language', 'spaces', 'pairing', 'sample']);
    expect(dialog.textContent).toContain('Étape 1 sur 4');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Continuer' })));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Continuer' })));
    expect(screen.getByText('Étape 3 sur 4')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Synchronisation' })).toBeTruthy();
    // La section de Réglages elle-même : « Choisir le dossier ».
    const choose = await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' });
    await act(async () => void fireEvent.click(choose));
    // Dossier choisi, clé créée : « Associer l'iPhone » est proposé (fenêtre pairing, mode show).
    await waitFor(() => expect(screen.queryByText('Non configurée')).toBeNull());
    expect((await platform.key.status()).present).toBe(true);
    act(() => sync.setStatus({ phase: 'idle' }));
    expect(await screen.findByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' })).toBeTruthy();
    expect(sync.calls).toContain('open');
    // Passable : « Continuer » mène aux données d'exemple.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Continuer' })));
    expect(screen.getByText('Étape 4 sur 4')).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Passer le guide de bienvenue' })));
    // Relancée depuis Réglages : l'étape est là de nouveau.
    await act(async () => onboardingStore.get(container).getState().relaunch());
    expect(onboardingStore.get(container).getState().steps).toContain('pairing');
  });
});
