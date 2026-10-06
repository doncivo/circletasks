// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { SYNC_TROUBLE_ORDER, SYNC_WARNINGS } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { FORGET_META } from '../../sync/forget';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { startSyncIntegration, type SyncIntegration } from './startSync';
import { isTroublePhase, statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Y-10 critères 15 d et 16 (bandeaux A-09, ADR 0011 §19) : appareil local oublié, échec d'un oubli, suppression des fichiers d'un
 * appareil oublié en attente. Chaque état a son bandeau tant qu'il dure, survit au redémarrage (lu dans `sync_meta` avant le premier
 * cycle) et disparaît à la résolution. Aucun délai réel (service factice, horloge de la base de test, minuteries factices).
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const LAPTOP = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c3');
const NOW = '2026-10-06T08:00:00.000Z';

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;
let integration: SyncIntegration | null;

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
const start = (): SyncIntegration =>
  (integration = startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined }));
const restart = async (): Promise<void> => {
  integration?.dispose();
  act(() => {
    start();
  });
  await act(async () => {
    await integration?.refreshed();
  });
};
const set = (patch: Partial<SyncStatus>): void => act(() => sync.setStatus(patch));
const settle = async (): Promise<void> => {
  await act(async () => {
    await integration?.refreshed();
  });
};
const text = (): string | null => screen.queryByRole('status')?.textContent ?? null;
const device = (deviceId: DeviceId, platform: 'ios' | 'windows', status: SyncDeviceStatus['status'], self = false): SyncDeviceStatus => ({ deviceId, platform, self, status, lastReadAt: null });
const DEVICES = [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'forgotten'), device(LAPTOP, 'windows', 'active')];

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

describe('ordre (ADR 0011 §19, emplacements réservés à Y-10)', () => {
  it('« oublié » en tête ; échec d’oubli puis suppression en attente à la fin', () => {
    expect(SYNC_TROUBLE_ORDER[0]).toBe('forgotten');
    // Y-11 : rappel des 30 jours après les états de Y-10 (§19 point 2).
    // Y-TECH-02 : seuls les avertissements du scan (jamais un blocage) viennent après.
    expect(SYNC_TROUBLE_ORDER.filter((code) => !(SYNC_WARNINGS as readonly string[]).includes(code)).slice(-3)).toEqual(['forget-failed', 'forget-pending', 'reset-reminder']);
  });
});

describe('appareil local oublié (critère 16)', () => {
  it('bandeau « Cet appareil a été oublié : associez-le de nouveau », « Voir » ouvre Réglages › Synchronisation ; ligne de Réglages en rouge', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'forgotten', devices: DEVICES });
    expect(text()).toContain('Cet appareil a été oublié : associez-le de nouveau');
    expect(text()).toContain(statusLine(sync.status(), db.clock.nowMs()));
    expect(isTroublePhase(sync.status())).toBe(true);
    expect(screen.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeTruthy();
  });
});

describe('échec d’un oubli et suppression en attente (critère 15 d)', () => {
  it('échec : bandeau avec le texte de Réglages ; gardé dans sync_meta, il revient dès le redémarrage, avant le premier cycle ; retiré à la réussite', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    const forget = { failure: { deviceId: PHONE, code: 'not-foreground', at: NOW as IsoDateTime, step: 'declare' as const }, deletions: [] };
    set({ phase: 'idle', devices: DEVICES, forget });
    expect(text()).toContain('L’oubli de iPhone a échoué : CircleTasks n’était pas au premier plan');
    // Redémarrage : le service repart sans état ; l'échec gardé dans la base est montré dès la première lecture.
    await db.data.repos.sync.setMeta(FORGET_META.failure, JSON.stringify(forget.failure));
    await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
    await db.data.repos.sync.saveState(PHONE, { platform: 'ios', stateSeq: 4, status: 'forgotten' });
    sync = createFakeSyncService();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
    await restart();
    expect(text()).toContain('L’oubli de iPhone a échoué');
    // Réussite : effacé par le moteur ; le cycle suivant conclut sans échec.
    await db.data.repos.sync.setMeta(FORGET_META.failure, null);
    set({ phase: 'idle', devices: DEVICES, forget: null, lastSyncAt: NOW as IsoDateTime });
    await settle();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('suppression en attente : « iPhone oublié : suppression de ses fichiers en attente de PC … », puis en cours, puis plus rien', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'idle', devices: DEVICES, forget: { failure: null, deletions: [{ deviceId: PHONE, state: 'waiting', waitingFor: LAPTOP }] } });
    expect(text()).toMatch(/^iPhone oublié : suppression de ses fichiers en attente de PC/);
    set({ forget: { failure: null, deletions: [{ deviceId: PHONE, state: 'deleting', waitingFor: null }] } });
    expect(text()).toContain('iPhone oublié : suppression de ses fichiers en cours');
    // Seconde revue (§18 point 11) : aucun instantané éligible : dit sur le bandeau, l'oublié nommé.
    set({ forget: { failure: null, deletions: [{ deviceId: PHONE, state: 'no-snapshot', waitingFor: null }] } });
    expect(text()).toMatch(/^iPhone oublié : aucun instantané à jour, ouvrez un autre appareil associé/);
    // Seconde revue point 5 : dossier disparu, pas encore terminé chez Rust : finalisation en attente, nommée, jusqu'à done.
    set({ forget: { failure: null, deletions: [{ deviceId: PHONE, state: 'finalizing', waitingFor: LAPTOP }] } });
    expect(text()).toMatch(/^iPhone oublié : finalisation en attente de PC/);
    set({ forget: null });
    await settle();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('oubli annulé (§18 point 12) : bandeau « oubli en échec » tant que l’appareil n’est pas oublié de nouveau', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({ phase: 'idle', devices: DEVICES, forget: { failure: null, deletions: [], revived: [PHONE] } });
    expect(text()).toMatch(/^Oubli de iPhone annulé : l’appareil qui l’avait oublié a lui-même été oublié/);
    set({ forget: null });
    await settle();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('plusieurs états : le plus urgent, les autres comptés (« oublié » avant l’échec et l’attente)', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    set({
      phase: 'forgotten',
      devices: DEVICES,
      forget: { failure: { deviceId: SELF, code: 'folder-unreachable', at: NOW as IsoDateTime, step: 'rejoin' }, deletions: [{ deviceId: PHONE, state: 'waiting', waitingFor: null }] },
    });
    expect(useAppStatusStore.getState().sources.syncTrouble).toMatchObject({ detail: 'forgotten', more: 2 });
  });
});
