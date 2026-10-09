// Y-06 (QA) critères 4, 9 et 13 : fenêtre principale. Relance pendant l'affichage (une seule à la fois, aucune après un échec ou en mode
// import), arrivée signalée une seule fois par événement, état `key-mismatch` (association proposée), échec d'arrivée gardé et visible.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { MemorySyncFolder, SyncPlatformError, createMemorySyncPlatform, type MemorySyncPlatform, type SyncPlatform } from '../../platform/sync';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { startDesktopIntegration } from '../app/desktop';
import { JOIN_META, arrivalWatchActive, onPairingChange } from './pairingStatus';
import { SyncDetailsPairing } from './SyncDetailsPairing';
import { JoinProgress } from './JoinProgress';
import { createFakeSyncService, nextCall, type FakeSyncService } from './testKit';

/** Avis `onPairingChange` qui conclut une ouverture de la fenêtre `pairing` (l'événement réel, jamais un sondage). */
function pairingSettled(container: Parameters<typeof onPairingChange>[0]): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = onPairingChange(container, () => {
      stop();
      resolve();
    });
  });
}

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d2');
const NOW = '2026-10-05T08:02:00.000Z';
const SHOW = 'Associer l’iPhone : afficher le code d’association';
const IMPORT = 'Associer cet appareil avec la clé de secours';

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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.close();
});

const renderIn = (container: AppContainer, node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};
const timerCycles = (): number => sync.calls.filter((reason) => reason === 'timer').length;

describe('relance pendant l’affichage du QR (critère 9, QA)', () => {
  it('aucune relance après un échec d’ouverture, ni en mode import', async () => {
    const failing: SyncPlatform = { ...platform, key: { ...platform.key, openPairing: () => Promise.reject(new SyncPlatformError('rate-limited')) } };
    const container = await make(failing);
    renderIn(container, <SyncDetailsPairing />);
    fireEvent.click(await screen.findByRole('button', { name: SHOW }));
    await screen.findByTestId('sync-pairing-notice');
    expect(arrivalWatchActive(container)).toBe(false);
    await advance(30_000);
    expect(timerCycles()).toBe(0);
    cleanup();
    sync.setStatus({ phase: 'needs-pairing' });
    const importing = await make();
    renderIn(importing, <SyncDetailsPairing />);
    // Attente : l'avis `onPairingChange` qui conclut l'ouverture (Y-TECH-02, aucun sondage).
    const opened = pairingSettled(importing);
    fireEvent.click(screen.getByRole('button', { name: IMPORT }));
    await act(async () => {
      await opened;
    });
    expect(platform.testing.pairing()?.mode).toBe('import');
    expect(arrivalWatchActive(importing)).toBe(false);
    await advance(30_000);
    expect(timerCycles()).toBe(0);
  });

  it('sync-paired : un cycle, l’arrivée signalée, aucune relance ensuite ; un écouteur par intégration, retiré à la fin', async () => {
    const container = await make();
    const integration = startDesktopIntegration(container);
    renderIn(container, <SyncDetailsPairing />);
    expect(desktop.syncPairedListeners).toBe(1);
    const opened = pairingSettled(container);
    fireEvent.click(await screen.findByRole('button', { name: SHOW }));
    await act(async () => {
      await opened;
    });
    expect(arrivalWatchActive(container)).toBe(true);
    await act(async () => {
      desktop.emitSyncPaired();
      await Promise.resolve();
    });
    expect((await screen.findByTestId('sync-pairing-notice')).textContent).toBe('iPhone associé');
    expect(sync.calls.filter((reason) => reason === 'manual')).toHaveLength(1);
    await advance(60_000);
    expect(timerCycles()).toBe(0);
    integration.dispose();
    expect(desktop.syncPairedListeners).toBe(0);
  });

  it('key-mismatch : « Associer cet appareil » est proposé (jamais « Associer l’iPhone »)', async () => {
    sync.setStatus({ phase: 'key-mismatch' });
    renderIn(await make(), <SyncDetailsPairing />);
    expect(screen.getByRole('button', { name: IMPORT })).toBeTruthy();
    expect(screen.queryByRole('button', { name: SHOW })).toBeNull();
  });
});

describe('échec d’arrivée visible (exigence d’Ali, critère 13, QA)', () => {
  it('code d’échec inconnu : texte générique, « Réessayer » relance un cycle, aucun contenu affiché', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ epoch: 'e', from: 'x', seq: 1, done: 8, total: 20, failure: 'disk-on-fire' }));
    renderIn(await make(), <JoinProgress />);
    const failure = await screen.findByTestId('sync-join-failure');
    expect((failure.textContent ?? '').trim()).not.toBe('');
    expect(failure.textContent).not.toContain('disk-on-fire');
    const retried = nextCall(sync, 'syncNow');
    fireEvent.click(screen.getByRole('button', { name: /réessayer/i }));
    await retried;
    expect(sync.calls).toContain('manual');
  });
});
