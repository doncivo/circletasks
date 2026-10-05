// Y-06 critères 4, 9, 10, 12 et 13, et exigence d'Ali (échecs visibles, persistants, effacés à la réussite) : fenêtre principale.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { MemorySyncFolder, SyncPlatformError, createMemorySyncPlatform, type MemorySyncPlatform, type SyncPlatform } from '../../platform/sync';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { JOIN_META } from '../../sync/join';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { startDesktopIntegration } from '../app/desktop';
import { JoinProgress } from './JoinProgress';
import { JOIN_STATE_META, PAIRING_FAILURE_META, arrivalWatchActive } from './pairingStatus';
import { SyncDetailsPairing } from './SyncDetailsPairing';
import { SyncSettingsSection } from './SyncSettingsSection';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d1');
const NOW = '2026-10-05T08:02:00.000Z';

let db: TestDb;
let sync: FakeSyncService;
let platform: MemorySyncPlatform;
let desktop: FakeDesktop;

async function make(platformOverride?: SyncPlatform): Promise<AppContainer> {
  return createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platformOverride ?? platform, desktop });
}

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  platform = createMemorySyncPlatform({ folder: new MemorySyncFolder() });
  await platform.folder.choose();
  await platform.bindDevice(SELF);
  await platform.key.create();
  desktop = createFakeDesktop();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.close();
});

const renderIn = (container: AppContainer, node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);

describe('« Associer l’iPhone » (critère 4)', () => {
  it('ouvre l’instance show après la confirmation native ; aucune boîte de notre côté', async () => {
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(platform.testing.pairing()).toEqual({ mode: 'show', generation: 1 }));
    expect(platform.testing.consentPrompts()).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(arrivalWatchActive(container)).toBe(true);
  });

  it.each([
    ['refus de la boîte (consent-denied)', (p: MemorySyncPlatform) => p.testing.setConsent(false), 'Affichage annulé'],
    ['app pas au premier plan (not-foreground)', (p: MemorySyncPlatform) => p.testing.setForeground(false), 'Revenez dans l’application et réessayez'],
  ])('%s : « %s », aucune fenêtre, rien de gardé', async (_case, arrange, text) => {
    arrange(platform);
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe(text);
    expect(platform.testing.pairing()).toBeNull();
    expect(await db.data.repos.sync.getMeta(PAIRING_FAILURE_META)).toBeNull();
  });

  it('rate-limited et io : message, gardé après un redémarrage, effacé par une ouverture réussie', async () => {
    const failing: SyncPlatform = { ...platform, key: { ...platform.key, openPairing: () => Promise.reject(new SyncPlatformError('io')) } };
    const container = await make(failing);
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('Installation incomplète : réinstallez l’application');
    // Redémarrage : nouveau conteneur, même base.
    cleanup();
    const restarted = await make();
    renderIn(restarted, <SyncDetailsPairing />);
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('Installation incomplète : réinstallez l’application');
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(screen.queryByTestId('sync-pairing-notice')).toBeNull());
    expect(await db.data.repos.sync.getMeta(PAIRING_FAILURE_META)).toBeNull();
    // Trop de demandes.
    cleanup();
    const limited: SyncPlatform = { ...platform, key: { ...platform.key, openPairing: () => Promise.reject(new SyncPlatformError('rate-limited')) } };
    renderIn(await make(limited), <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('Trop de demandes : réessayez dans 10 minutes');
  });

  it('fenêtre déjà ouverte (already-open) : « La fenêtre d’association est déjà ouverte », rien de gardé, l’instance reste', async () => {
    await platform.key.openPairing('show');
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('La fenêtre d’association est déjà ouverte');
    expect(platform.testing.pairing()).toEqual({ mode: 'show', generation: 1 });
    expect(await db.data.repos.sync.getMeta(PAIRING_FAILURE_META)).toBeNull();
  });

  it('mode import : texte neutre pour un refus, jamais « Affichage annulé »', async () => {
    const { pairingOpenErrorKey } = await import('./pairingStatus');
    expect(pairingOpenErrorKey('consent-denied', 'import')).toBe('sync.pairing.importCancelled');
    expect(pairingOpenErrorKey('consent-denied', 'show')).toBe('sync.pairing.openDenied');
    expect(pairingOpenErrorKey('not-foreground', 'import')).toBe('sync.pairing.openBackground');
    expect(pairingOpenErrorKey('already-open', 'import')).toBe('sync.pairing.openAlreadyOpen');
  });

  it('dossier lié sans clé : « Associer cet appareil » ouvre l’instance import, sans confirmation', async () => {
    sync.setStatus({ phase: 'needs-pairing' });
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer cet appareil avec la clé de secours' }));
    await waitFor(() => expect(platform.testing.pairing()?.mode).toBe('import'));
    expect(platform.testing.consentPrompts()).toBe(0);
  });

  it('synchro non configurée : rien n’est proposé', async () => {
    sync.setStatus({ phase: 'not-configured' });
    renderIn(await make(), <SyncDetailsPairing />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('aucun échec silencieux (revue, faibles)', () => {
  it('lecture de sync_meta impossible : message visible, effacé quand la lecture réussit', async () => {
    const getMeta = vi.spyOn(db.data.repos.sync, 'getMeta').mockRejectedValue(new Error('base occupée'));
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('L’état de l’association n’a pas pu être lu ou enregistré : réessayez');
    getMeta.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(screen.queryByTestId('sync-pairing-notice')).toBeNull());
  });

  it('écriture de sync_meta impossible après un échec d’ouverture : le message le dit', async () => {
    vi.spyOn(db.data.repos.sync, 'setMeta').mockRejectedValue(new Error('disque plein'));
    const failing: SyncPlatform = { ...platform, key: { ...platform.key, openPairing: () => Promise.reject(new SyncPlatformError('io')) } };
    const container = await make(failing);
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(screen.getAllByRole('status').map((n) => n.textContent).join(' | ')).toContain('n’a pas pu être lu ou enregistré'));
  });

  it('appareil associé mais premier cycle en échec : « iPhone associé » ne masque pas l’échec', async () => {
    const container = await make();
    startDesktopIntegration(container);
    renderIn(container, <SyncDetailsPairing />);
    sync.syncNow = (reason) => {
      sync.calls.push(reason);
      sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable' });
      return Promise.resolve();
    };
    await act(async () => {
      desktop.emitSyncPaired();
      await Promise.resolve();
    });
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('iPhone associé, mais la synchronisation qui suit a échoué : voir l’état ci-dessus');
  });
});

describe('arrivée de l’appareil associé (critère 9)', () => {
  it('relance un cycle toutes les 10 s pendant l’affichage, puis sync-paired : « iPhone associé », cycle, relance arrêtée', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const container = await make();
    const integration = startDesktopIntegration(container);
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(arrivalWatchActive(container)).toBe(true));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(sync.calls.filter((reason) => reason === 'timer')).toHaveLength(2);
    expect(desktop.syncPairedListeners).toBe(1);
    await act(async () => {
      desktop.emitSyncPaired();
      await Promise.resolve();
    });
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('iPhone associé');
    expect(sync.calls).toContain('manual');
    expect(arrivalWatchActive(container)).toBe(false);
    integration.dispose();
    expect(desktop.syncPairedListeners).toBe(0);
  });

  it('la relance s’arrête seule après 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const container = await make();
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }));
    await waitFor(() => expect(arrivalWatchActive(container)).toBe(true));
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
      await Promise.resolve();
    });
    expect(sync.calls.filter((reason) => reason === 'timer')).toHaveLength(30);
    expect(arrivalWatchActive(container)).toBe(false);
  });
});

describe('ligne de Réglages, branche needsPairing (critères 10 et 12)', () => {
  it('dossier lié sans clé : message, « Associer cet appareil » ; à l’association, retour à l’état normal', async () => {
    const folder = new MemorySyncFolder();
    const first = createMemorySyncPlatform({ folder });
    await first.folder.choose();
    await first.bindDevice('70000000-0000-4000-8000-000000000008' as DeviceId);
    await first.key.create();
    const joiner = createMemorySyncPlatform({ folder });
    joiner.testing.setChooser(folder);
    await joiner.folder.choose();
    await joiner.bindDevice(SELF);
    // Le dossier contient des données chiffrées : la clé n'est pas créée.
    vi.spyOn(joiner.key, 'create').mockRejectedValue(new SyncPlatformError('folder-has-data'));
    const container = await make(joiner);
    startDesktopIntegration(container);
    renderIn(container, <SyncSettingsSection platform={joiner} />);
    expect(await screen.findByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Associer cet appareil avec la clé de secours' }));
    await waitFor(() => expect(joiner.testing.pairing()?.mode).toBe('import'));
    // L'import a réussi dans la fenêtre pairing (simulé : la clé est là), Rust émet sync-paired.
    vi.spyOn(joiner.key, 'status').mockResolvedValue({ present: true, kid: '0123456789abcdef' });
    await act(async () => {
      desktop.emitSyncPaired();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Associer cet appareil avec la clé de secours' })).toBeNull();
    expect(sync.calls).toContain('manual');
  });

  it('sans dossier lié, « Associer cet appareil » n’est pas proposé', async () => {
    const empty = createMemorySyncPlatform({ folder: new MemorySyncFolder() });
    renderIn(await make(empty), <SyncSettingsSection platform={empty} />);
    expect(await screen.findByText('Non configurée')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Associer cet appareil avec la clé de secours' })).toBeNull();
  });
});

describe('progression et échec de l’arrivée (critère 13, exigence d’Ali)', () => {
  it('« Réception de vos données… 1 200 / 5 000 » pendant la reprise, puis rien', async () => {
    renderIn(await make(), <JoinProgress />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => sync.setStatus({ phase: 'syncing', progress: { done: 1200, total: 5000 } }));
    expect(screen.getByRole('status').textContent).toBe('Réception de vos données… 1 200 / 5 000');
    expect(screen.getByLabelText('Réception des données de la synchronisation')).toBeTruthy();
    act(() => sync.setStatus({ phase: 'idle', progress: null }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('échec mémorisé par le moteur : affiché en rouge avec « Réessayer », après un redémarrage aussi, effacé à la réussite', async () => {
    expect(JOIN_STATE_META).toBe(JOIN_META);
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ epoch: 'e0001-x', from: SELF, seq: 1, done: 8, total: 20, failure: 'io' }));
    renderIn(await make(), <JoinProgress />);
    expect((await screen.findByTestId('sync-join-failure')).textContent).toContain('La réception de vos données s’est arrêtée à 8 / 20 : elle reprendra à la prochaine synchronisation');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer la réception des données' }));
    expect(sync.calls).toContain('manual');
    cleanup();
    renderIn(await make(), <JoinProgress />);
    expect(await screen.findByTestId('sync-join-failure')).toBeTruthy();
    // Réussite : le moteur efface l'entrée ; la fin du cycle relit.
    await db.data.repos.sync.setMeta(JOIN_META, null);
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime }));
    await waitFor(() => expect(screen.queryByTestId('sync-join-failure')).toBeNull());
  });

  it('horloge en retard : texte dédié ; attente sans échec : affichage neutre', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ epoch: 'e0001-x', from: SELF, seq: 1, done: 0, total: 20, failure: 'clock-ahead' }));
    renderIn(await make(), <JoinProgress />);
    expect((await screen.findByTestId('sync-join-failure')).textContent).toContain('l’horloge de cet appareil est en retard');
    cleanup();
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ epoch: 'e0001-x', from: SELF, seq: 1, done: 4, total: 20, failure: null }));
    renderIn(await make(), <JoinProgress />);
    const waiting = await screen.findByTestId('sync-join-waiting');
    expect(waiting.textContent).toBe('Réception de vos données en attente : 4 / 20');
    expect(waiting.querySelector('.ct-settings__hint--danger')).toBeNull();
  });
});
