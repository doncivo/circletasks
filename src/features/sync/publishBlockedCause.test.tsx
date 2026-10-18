// Y-FIX-02 (ADR 0011 §30, critère 11) : cause nommée de `publish-blocked` pendant une première publication interrompue. Section
// AVERTISSEMENTS des détails : le texte de la cause (catalogue à la demande `syncPublishCauseText`) à côté de l'avertissement ; bandeau :
// l'avertissement `publish-blocked` (une cause n'est jamais un bandeau à part) ; jamais « À jour ».
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { syncBannerFor } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { syncPublishCauseEn } from '../../i18n/en.syncPublishCause';
import { syncPublishCauseFr } from '../../i18n/fr.syncPublishCause';
import { isPublishBlockedCause, publishCauseText } from '../../i18n/syncPublishCauseText';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { syncTroubleText } from './startSync';
import { statusLine } from './syncText';
import { syncStore } from './syncStore';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f4');
const NOW = '2026-10-18T08:02:00.000Z';
const NOW_MS = Date.parse(NOW);
const NO_PERSISTED = { join: null, devices: null, blocking: null, readFailed: false } as const;
const SLOTS = { pairing: null, conflicts: null, version: null, forget: null, reset: null, carryReport: null } as const;

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-18T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  await db.close();
});

const status = (patch: Partial<SyncStatus>): SyncStatus => ({ ...sync.status(), ...patch });

function renderDetails(s: SyncStatus): void {
  syncStore.get(container).setState({ status: s });
  render(
    <AppContainerProvider container={container}>
      <SyncDetailsScreen slots={SLOTS} />
    </AppContainerProvider>,
  );
}

describe('cause nommée de publish-blocked (Y-FIX-02, critère 11)', () => {
  for (const cause of ['first-publication-state-refused', 'unexplained-files'] as const) {
    it(`${cause} : AVERTISSEMENTS des détails montre la cause, le bandeau l’avertissement, jamais « À jour »`, () => {
      const s = status({ warnings: ['publish-blocked', cause] });
      expect(statusLine(s, NOW_MS)).toBe(t('sync.status.incomplete'));
      renderDetails(s);
      expect(screen.getByText(t('sync.status.sectionWarnings'))).toBeTruthy();
      expect(screen.getByText(t('sync.status.warnPublishBlocked'))).toBeTruthy();
      expect(screen.getByText(syncPublishCauseFr[cause])).toBeTruthy();
      expect(document.querySelector(`[data-warning="${cause}"]`)?.textContent).toBe(syncPublishCauseFr[cause]);
      const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(s, NO_PERSISTED);
      expect(banners.troubles.map((x) => x.code)).toEqual(['publish-blocked']);
      expect(banners.troubles.map((x) => syncTroubleText(x, banners.textStatus, [], 0))).toEqual([t('sync.status.warnPublishBlocked')]);
    });
  }

  it('échec io pendant la première publication : phase d’erreur en tête du bandeau, cause toujours nommée dans les détails', () => {
    const s = status({ phase: 'error', errorCode: 'io', warnings: ['publish-blocked', 'first-publication-state-refused'] });
    expect(statusLine(s, NOW_MS)).not.toContain('À jour');
    renderDetails(s);
    expect(screen.getByText(syncPublishCauseFr['first-publication-state-refused'])).toBeTruthy();
    const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(s, NO_PERSISTED);
    expect(banners.troubles.map((x) => x.code)).toEqual(['error', 'publish-blocked']);
  });

  it('catalogue : français et anglais aux mêmes clés, aucun avertissement de SYNC_WARNINGS pris pour une cause', () => {
    expect(Object.keys(syncPublishCauseEn).sort()).toEqual(Object.keys(syncPublishCauseFr).sort());
    expect(publishCauseText('unexplained-files')).toBe(syncPublishCauseFr['unexplained-files']);
    expect(isPublishBlockedCause('publish-blocked')).toBe(false);
    expect(isPublishBlockedCause('first-publication-state-refused')).toBe(true);
  });
});
