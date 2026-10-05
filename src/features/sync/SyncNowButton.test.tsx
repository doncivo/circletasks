import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { startDesktopIntegration } from '../app/desktop';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { RestoreChoiceDialog } from './RestoreChoiceDialog';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { SyncStatusLine } from './SyncStatusLine';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/** Je lance une synchro manuelle (ADR 0011, sections 10.1, 10.4, 11.2 ; Y-03 critères 1 à 8). */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e1');
const NOW = '2026-10-05T08:00:30.000Z';

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'iCloud Drive / CircleTasks' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  await db.close();
});

const renderIn = (node: React.ReactNode, c: AppContainer = container) => render(<AppContainerProvider container={c}>{node}</AppContainerProvider>);

describe('bouton « Synchroniser » (Y-03 critères 1, 2, 7, 8)', () => {
  it('présent dans la ligne de Réglages et dans les détails quand la synchro est configurée ; absent sinon', () => {
    renderIn(<SyncStatusLine />);
    expect(screen.getByRole('button', { name: 'Synchroniser' })).toBeTruthy();
    cleanup();
    renderIn(<SyncDetailsScreen />);
    expect(screen.getByRole('button', { name: 'Synchroniser' })).toBeTruthy();
    cleanup();
    sync.setStatus({ phase: 'not-configured' });
    renderIn(<SyncStatusLine />);
    expect(screen.queryByRole('button', { name: 'Synchroniser' })).toBeNull();
    cleanup();
    const plain = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data });
    renderIn(<SyncStatusLine />, plain);
    expect(screen.queryByRole('button', { name: /Synchroni/ })).toBeNull();
  });

  it('pendant le cycle : désactivé, « Synchronisation… », aria-busy ; à la fin « À jour · à l’instant »', async () => {
    sync.hold = true;
    renderIn(<SyncStatusLine />);
    fireEvent.click(screen.getByRole('button', { name: 'Synchroniser' }));
    const busy = await screen.findByRole('button', { name: 'Synchronisation…' });
    expect(busy).toHaveProperty('disabled', true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(sync.calls).toEqual(['manual']);
    sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
    sync.release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Synchroniser' })).toHaveProperty('disabled', false));
    expect(screen.getByRole('status').textContent).toBe('À jour · à l’instant');
  });

  it('erreur : le bouton redevient actif, la sous-ligne reprend le message, aucune boîte bloquante', async () => {
    renderIn(<SyncStatusLine />);
    fireEvent.click(screen.getByRole('button', { name: 'Synchroniser' }));
    sync.setStatus({ phase: 'error', errorCode: 'cloud-provider-stopped' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour'));
    expect(screen.getByRole('button', { name: 'Synchroniser' })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('D2 : pendant le choix de restauration, « Synchroniser » rouvre la fenêtre de choix et ne lance aucun cycle', async () => {
    sync.restore = { marker: { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 }, options: ['apply-everywhere', 'keep-synced'] };
    renderIn(
      <>
        <SyncStatusLine />
        <RestoreChoiceDialog />
      </>,
    );
    sync.setStatus({ phase: 'restore-choice' });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Plus tard' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Synchroniser' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(sync.calls).toEqual([]);
  });
});

describe('zone de notification (Y-03 critères 4 et 5)', () => {
  it('synchro configurée : libellé envoyé par set_tray_labels, syncEnabled vrai, l’entrée appelle syncNow(« tray ») sans changer d’écran', async () => {
    const desktop = createFakeDesktop();
    const c = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, desktop });
    const integration = startDesktopIntegration(c);
    await vi.waitFor(() => expect(desktop.trayLabels?.syncEnabled).toBe(true));
    expect(desktop.trayLabels?.sync).toBe('Synchroniser maintenant');
    await vi.waitFor(() => expect(desktop.traySyncListeners).toBe(1));
    desktop.emitTraySyncNow();
    await vi.waitFor(() => expect(sync.calls).toEqual(['tray']));
    expect(useNavigationStore.getState().route).toEqual(INITIAL_NAVIGATION.route);
    integration.dispose();
  });

  it('D1 : sans synchro configurée, l’entrée ouvre Réglages › Synchronisation ; le libellé suit la configuration', async () => {
    const desktop = createFakeDesktop();
    sync.setStatus({ phase: 'not-configured' });
    const c = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, desktop });
    const integration = startDesktopIntegration(c);
    await vi.waitFor(() => expect(desktop.traySyncListeners).toBe(1));
    expect(desktop.trayLabels?.syncEnabled).toBe(false);
    desktop.emitTraySyncNow();
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'sync' });
    expect(sync.calls).toEqual([]);
    sync.setStatus({ phase: 'idle' });
    await vi.waitFor(() => expect(desktop.trayLabels?.syncEnabled).toBe(true));
    integration.dispose();
    expect(desktop.traySyncListeners).toBe(0);
  });
});
