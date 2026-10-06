// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { SYNC_TROUBLE_ORDER } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncDeviceStatus, SyncResetStatus, SyncStatus } from '../../platform/sync/types';
import { RESET_META } from '../../sync/reset';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { startSyncIntegration, type SyncIntegration } from './startSync';
import { isTroublePhase, statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Y-11 critères 17 et 18 (bandeaux A-09, ADR 0011 §19 point 2) : appareil à associer de nouveau (en tête), réinitialisation en cours ou en
 * échec (après l'arrivée en échec), rappel des 30 jours (à la fin) ; chaque état a son bandeau tant qu'il dure, survit au redémarrage (lu
 * dans `sync_meta` avant le premier cycle) et disparaît à la résolution. Aucun délai réel.
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const NOW = '2026-10-06T08:00:00.000Z';

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;
let integration: SyncIntegration | null;

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
const start = (): SyncIntegration =>
  (integration = startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined }));
const set = (patch: Partial<SyncStatus>): void => act(() => sync.setStatus(patch));
const settle = async (): Promise<void> => {
  await act(async () => {
    await integration?.refreshed();
  });
};
const text = (): string | null => screen.queryByRole('status')?.textContent ?? null;
const device = (deviceId: DeviceId, platform: 'ios' | 'windows', self = false): SyncDeviceStatus => ({ deviceId, platform, self, status: 'active', lastReadAt: null });
const DEVICES = [device(SELF, 'windows', true), device(PHONE, 'ios')];
const reset = (patch: Partial<SyncResetStatus>): SyncResetStatus => ({
  role: 'initiator',
  step: 'waiting-devices',
  by: SELF,
  superseded: false,
  waiting: [PHONE],
  reminder: false,
  startedAt: NOW as IsoDateTime,
  resumed: false,
  failure: null,
  ...patch,
});

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService();
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
});

afterEach(async () => {
  cleanup();
  integration?.dispose();
  integration = null;
  await db.close();
});

describe('ordre (ADR 0011 §19 point 2, emplacements réservés à Y-11)', () => {
  it('à associer en tête (après « oublié ») ; en cours ou en échec après l’arrivée en échec ; rappel des 30 jours à la fin', () => {
    expect(SYNC_TROUBLE_ORDER.slice(0, 2)).toEqual(['forgotten', 'reset-required']);
    expect(SYNC_TROUBLE_ORDER.indexOf('reset-progress')).toBe(SYNC_TROUBLE_ORDER.indexOf('join-failed') + 1);
    expect(SYNC_TROUBLE_ORDER.at(-1)).toBe('reset-reminder');
  });
});

describe('bandeaux de la réinitialisation (critères 17 et 18)', () => {
  it('appareil à associer de nouveau : texte de la ligne de Réglages, en rouge ; perdant : appareil gagnant nommé', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'reset-required', devices: DEVICES, reset: reset({ role: 'required', step: 'required', by: PHONE }) });
    expect(text()).toContain('Cet appareil doit être associé de nouveau');
    expect(text()).toContain(statusLine(sync.status(), db.clock.nowMs()));
    expect(isTroublePhase(sync.status())).toBe(true);
    set({ reset: reset({ step: 'superseded', superseded: true, by: PHONE }) });
    expect(text()).toContain('Une réinitialisation lancée sur iPhone l’emporte : associez cet appareil avec sa nouvelle clé');
  });

  it('§18 points 15 et 16 : réinitialisation interrompue (restauration, ou perte close) : bandeau « relancez-la », jamais « à associer »', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'idle', devices: DEVICES, reset: reset({ step: 'superseded', superseded: true, restore: true, by: PHONE }) });
    expect(text()).toContain('Réinitialisation interrompue par une restauration sur iPhone : relancez-la');
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reset-progress');
    set({ reset: reset({ step: 'superseded', superseded: true, closed: true, by: null }) });
    expect(text()).toContain('Réinitialisation interrompue : relancez-la');
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reset-progress');
  });

  it('réinitialisation en cours puis en échec ; gardée dans sync_meta, elle revient dès le redémarrage ; retirée à la fin de la bascule', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'idle', devices: DEVICES, reset: reset({}) });
    expect(text()).toContain('Réinitialisation : en attente d’un appareil');
    const failed = reset({ step: 'snapshot', failure: { code: 'cloud-pending', at: NOW as IsoDateTime, step: 'snapshot' } });
    set({ reset: failed });
    expect(text()).toContain('La réinitialisation a échoué (ouverture de la nouvelle époque) : un fichier attend encore iCloud');
    // Redémarrage : le service repart sans état ; l'état gardé dans la base est montré dès la première lecture.
    await db.data.repos.sync.setMeta(RESET_META, JSON.stringify({ ...failed, kid: null, epoch: null, waitingSince: null, republished: false }));
    integration?.dispose();
    sync = createFakeSyncService();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
    act(() => {
      start();
    });
    await settle();
    expect(text()).toContain('La réinitialisation a échoué (ouverture de la nouvelle époque)');
    // Fin de la bascule : plus de bandeau d'échec ni d'étape.
    await db.data.repos.sync.setMeta(RESET_META, null);
    set({ phase: 'idle', devices: DEVICES, reset: reset({ step: 'done', waiting: [] }), lastSyncAt: NOW as IsoDateTime });
    await settle();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('rappel des 30 jours : appareils nommés, sans action ; appareil à associer de nouveau montré avant le premier cycle', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'idle', devices: DEVICES, reset: reset({ reminder: true }) });
    // En cours d'abord (plus urgent), le rappel compte dans « (+1) ».
    expect(text()).toContain('Réinitialisation : en attente d’un appareil');
    expect(useAppStatusStore.getState().sources.syncTrouble?.more).toBe(1);
    integration?.dispose();
    await db.data.repos.sync.setMeta(RESET_META, JSON.stringify({ role: 'required', step: 'required', by: PHONE, startedAt: NOW, waiting: [], failure: null }));
    sync = createFakeSyncService();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
    act(() => {
      start();
    });
    await settle();
    expect(text()).toContain('Cet appareil doit être associé de nouveau');
  });
});
