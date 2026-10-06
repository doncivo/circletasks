// Y-TECH-02 (QA) : un avertissement du scan qui disparaît retire le bandeau et la section AVERTISSEMENTS (aucun reste affiché).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import type { SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { startSyncIntegration } from './startSync';
import { syncStore } from './syncStore';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f2');
const NOW = '2026-10-06T08:02:00.000Z';
const slots = { pairing: null, conflicts: null, version: null, forget: null, reset: null };

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-06T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

describe('avertissements qui disparaissent', () => {
  it('bandeau : posé avec les avertissements, retiré quand le service n’en rend plus', async () => {
    sync.setStatus({ warnings: ['nonce-budget'] });
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('nonce-budget');
    sync.setStatus({ warnings: [] });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    sync.setStatus({ warnings: ['too-many-devices'], stateUnreadable: true });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('state-unreadable');
    expect(useAppStatusStore.getState().sources.syncTrouble?.more).toBe(1);
    sync.setStatus({ warnings: [], stateUnreadable: false });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('détails : chaque avertissement a son texte ; la section disparaît avec le dernier', () => {
    const status = (patch: Partial<SyncStatus>): void => syncStore.get(container).setState({ status: { ...sync.status(), ...patch } });
    status({ warnings: ['nonce-budget', 'folder-large', 'too-many-devices', 'scan-incomplete'] });
    const view = render(
      <AppContainerProvider container={container}>
        <SyncDetailsScreen slots={slots} />
      </AppContainerProvider>,
    );
    for (const key of ['sync.status.warnNonceBudget', 'sync.status.warnFolderLarge', 'sync.status.warnTooManyDevices', 'sync.status.warnScanIncomplete'] as const) expect(screen.getByText(t(key)), key).toBeTruthy();
    expect(screen.getByText(t('sync.status.sectionWarnings'))).toBeTruthy();
    status({ warnings: [] });
    view.rerender(
      <AppContainerProvider container={container}>
        <SyncDetailsScreen slots={slots} />
      </AppContainerProvider>,
    );
    expect(screen.queryByText(t('sync.status.sectionWarnings'))).toBeNull();
    expect(screen.queryByText(t('sync.status.warnNonceBudget'))).toBeNull();
  });
});
