// Y-TECH-02, cinquième revue, point 7 (ADR 0011 §5.5, visibilité) : un appareil `corrupt` par un trou impossible à combler porte
// `gapSince` et un texte distinct (« Journaux déjà supprimés, en attente d'un instantané récent »), dans le bandeau d'appareil et dans
// Réglages › Synchronisation (Détails), avant le premier cycle comme après ; « Fichiers illisibles » reste pour les autres `corrupt`.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { syncBannerFor } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { startSyncIntegration, syncTroubleText } from './startSync';
import { syncStore } from './syncStore';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f4');
const OTHER = asEntityId<DeviceId>('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const NOW = '2026-10-07T08:00:00.000Z';
const SINCE = '2026-10-06T08:00:00.000Z' as IsoDateTime;
const NO_PERSISTED = { join: null, devices: null, blocking: null, readFailed: false } as const;

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-07T07:59:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

const device = (patch: Partial<SyncDeviceStatus>): SyncDeviceStatus => ({ deviceId: OTHER, platform: 'ios', self: false, lastReadAt: null, status: 'corrupt', ...patch });
const status = (devices: SyncDeviceStatus[]): SyncStatus => ({ ...sync.status(), devices });
const slots = { pairing: null, conflicts: null, version: null, forget: null, reset: null };

describe('texte distinct d’un trou impossible à combler', () => {
  it('bandeau d’appareil : texte du trou avec gapSince, « Fichiers illisibles » sans', () => {
    for (const [d, text] of [
      [device({ gapSince: SINCE }), t('sync.status.stateGap')],
      [device({}), t('sync.status.stateCorrupt')],
    ] as const) {
      const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(status([d]), NO_PERSISTED);
      const first = banners.troubles[0];
      expect(first?.code).toBe('device-corrupt');
      expect(first && syncTroubleText(first, banners.textStatus, [d], 0)).toContain(text);
    }
  });

  it('Réglages › Synchronisation (Détails) : texte du trou, disparu quand le trou est effacé', () => {
    syncStore.get(container).setState({ status: status([device({ gapSince: SINCE })]) });
    render(<AppContainerProvider container={container}><SyncDetailsScreen slots={slots} /></AppContainerProvider>);
    expect(screen.getByText(t('sync.status.stateGap'))).toBeTruthy();
    cleanup();
    syncStore.get(container).setState({ status: status([device({ status: 'active' })]) });
    render(<AppContainerProvider container={container}><SyncDetailsScreen slots={slots} /></AppContainerProvider>);
    expect(screen.queryByText(t('sync.status.stateGap'))).toBeNull();
  });

  it('avant le premier cycle (états persistés) : bandeau avec le texte du trou, lu de sync_state et sync_meta.segmentGaps', async () => {
    await db.data.repos.sync.saveState(OTHER, { status: 'corrupt', stateSeq: 3, platform: 'ios' });
    await db.data.repos.sync.setMeta('segmentGaps', JSON.stringify({ [OTHER]: { epoch: `e0001-${OTHER}`, segment: 0, author: OTHER, seq: 1, since: SINCE } }));
    sync.setStatus({ phase: 'idle', devices: [] });
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toContain(t('sync.status.stateGap'));
    integration.dispose();
  });
});
