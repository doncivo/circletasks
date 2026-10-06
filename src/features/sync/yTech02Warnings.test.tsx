// Y-TECH-02 (point 1) : avertissements du scan et état local illisible visibles dans le bandeau (règle existante : le plus urgent, « (+N) »)
// et dans Réglages › Synchronisation (section AVERTISSEMENTS) ; fenêtre de restauration quand le dossier n'a pas pu être vérifié.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { SYNC_TROUBLE_ORDER, syncBannerFor } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { RestoreChoiceDialog } from './RestoreChoiceDialog';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { startSyncIntegration, syncTroubleText } from './startSync';
import { syncStore } from './syncStore';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f1');
const NOW = '2026-10-06T08:02:00.000Z';
const NO_PERSISTED = { join: null, devices: null, blocking: null, readFailed: false } as const;

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

const renderIn = (node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);
const status = (patch: Partial<SyncStatus>): SyncStatus => ({ ...sync.status(), ...patch });

describe('décision et texte du bandeau', () => {
  it('avertissements à la fin de SYNC_TROUBLE_ORDER, jamais avant un échec ; texte de chacun', () => {
    expect(SYNC_TROUBLE_ORDER.slice(-4)).toEqual(['nonce-budget', 'folder-large', 'too-many-devices', 'scan-incomplete']);
    const s = status({ warnings: ['scan-incomplete', 'nonce-budget'], devices: [] });
    const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(s, NO_PERSISTED);
    expect(banners.troubles.map((x) => x.code)).toEqual(['nonce-budget', 'scan-incomplete']);
    expect(banners.troubles.map((x) => syncTroubleText(x, banners.textStatus, [], 0))).toEqual([t('sync.status.warnNonceBudget'), t('sync.status.warnScanIncomplete')]);
    const failing = syncBannerFor<SyncDeviceStatus, SyncStatus>(status({ phase: 'error', errorCode: 'io', warnings: ['folder-large'] }), NO_PERSISTED);
    expect(failing.troubles.map((x) => x.code)).toEqual(['error', 'folder-large']);
  });

  it('état local illisible signalé par le service : state-unreadable, une seule fois même si la relecture de l’interface échoue aussi', () => {
    const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(status({ stateUnreadable: true }), { ...NO_PERSISTED, readFailed: true });
    expect(banners.troubles.map((x) => x.code)).toEqual(['state-unreadable']);
  });

  it('bandeau posé par l’intégration : le plus urgent des avertissements, les autres en « (+N) »', async () => {
    sync.setStatus({ warnings: ['folder-large', 'too-many-devices'] });
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const banner = useAppStatusStore.getState().sources.syncTrouble;
    expect(banner?.detail).toBe('folder-large');
    expect(banner?.message).toBe(t('sync.status.warnFolderLarge'));
    expect(banner?.more).toBe(1);
    integration.dispose();
  });
});

describe('Réglages › Synchronisation', () => {
  it('section AVERTISSEMENTS : état illisible et avertissements du scan ; absente sans avertissement', () => {
    renderIn(<SyncDetailsScreen slots={{ pairing: null, conflicts: null, version: null, forget: null, reset: null }} />);
    expect(screen.queryByText(t('sync.status.sectionWarnings'))).toBeNull();
    cleanup();
    syncStore.get(container).setState({ status: status({ warnings: ['nonce-budget', 'scan-incomplete'], stateUnreadable: true }) });
    renderIn(<SyncDetailsScreen slots={{ pairing: null, conflicts: null, version: null, forget: null, reset: null }} />);
    expect(screen.getByText(t('sync.status.sectionWarnings'))).toBeTruthy();
    expect(screen.getByText(t('status.syncStateUnreadable'))).toBeTruthy();
    expect(screen.getByText(t('sync.status.warnNonceBudget'))).toBeTruthy();
    expect(screen.getByText(t('sync.status.warnScanIncomplete'))).toBeTruthy();
  });
});

describe('fenêtre de restauration (point 3)', () => {
  it('dossier non vérifié : le texte le dit, sans « Appliquer partout »', async () => {
    sync.restore = {
      marker: { backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 },
      options: ['keep-synced'],
      notice: 'scan-failed',
    };
    await syncStore.get(container).getState().openRestore();
    renderIn(<RestoreChoiceDialog />);
    expect(screen.getByText(t('sync.restore.scanFailed'))).toBeTruthy();
    expect(screen.queryByText(t('sync.restore.applyEverywhere'))).toBeNull();
  });
});
