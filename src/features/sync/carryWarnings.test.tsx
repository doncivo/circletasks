// Y-FIX-04 (critère 13, revue I2) : avertissements du report d'époque d'une ligne dont le parent a été remplacé. `carry-held` (ligne mise de
// côté) et `carry-report` (compte rendu du changement d'époque, Y-TECH-05, remplace `carry-reattached`) interdisent « À jour ». Texte de
// `carry-held` : section AVERTISSEMENTS des détails (`warningText`) et bandeau (`syncBannerFor` puis `syncTroubleText`) ; le texte de
// `carry-report` est composé par un bloc à la demande (`carryReportBannerLine`, `carryReportScenario.test.tsx`) : ni l'un ni l'autre ne le portent.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { syncBannerFor } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { syncTroubleText } from './startSync';
import { statusLine, warningText } from './syncText';
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
const upToDate = (): string => statusLine(status({}), NOW_MS);

describe('avertissements du report d’époque (Y-FIX-04, critère 13)', () => {
  it('carry-held : « Synchro incomplète », jamais « À jour »', () => {
    expect(upToDate()).toBe('À jour · il y a 2 min');
    expect(statusLine(status({ warnings: ['carry-held'] }), NOW_MS)).toBe(t('sync.status.incomplete'));
  });

  it('carry-report : « Synchro incomplète », jamais « À jour » (ADR 0011 §29 point 5, critère 16)', () => {
    expect(statusLine(status({ warnings: ['carry-report'] }), NOW_MS)).toBe(t('sync.status.incomplete'));
  });

  it('bandeau : les deux avertissements, carry-held d’abord ; le texte de carry-report vient du bloc à la demande', () => {
    const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(status({ warnings: ['carry-report', 'carry-held'], devices: [] }), NO_PERSISTED);
    expect(banners.troubles.map((x) => x.code)).toEqual(['carry-held', 'carry-report']);
    expect(banners.troubles.map((x) => syncTroubleText(x, banners.textStatus, [], 0))).toEqual([t('sync.status.warnCarryHeld'), '']);
    expect(warningText('carry-held')).toBe(t('sync.status.warnCarryHeld'));
  });

  it('section AVERTISSEMENTS des détails : carry-held y figure, carry-report a sa propre ligne (compte rendu)', () => {
    syncStore.get(container).setState({ status: status({ warnings: ['carry-held', 'carry-report'] }) });
    render(
      <AppContainerProvider container={container}>
        <SyncDetailsScreen slots={SLOTS} />
      </AppContainerProvider>,
    );
    expect(screen.getByText(t('sync.status.sectionWarnings'))).toBeTruthy();
    expect(screen.getByText(t('sync.status.warnCarryHeld'))).toBeTruthy();
    expect(document.querySelector('[data-warning="carry-report"]')).toBeNull();
  });
});
