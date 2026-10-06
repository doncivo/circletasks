// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncStatus } from '../../platform/sync/types';
import { FORGET_META } from '../../sync/forget';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { BLOCKING_PHASE_META, startSyncIntegration, type SyncIntegration } from './startSync';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Y-10, QA (critère 15 d et 16) : les trois bandeaux `forgotten`, `forget-failed` et `forget-pending` sont visibles **dès le
 * démarrage** (lus dans la base avant le premier cycle, vrai `readForgetStatus`) et effacés **à la résolution**, jamais avant. Service
 * factice, minuteries factices, aucun délai réel.
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
const settle = async (): Promise<void> => {
  await act(async () => {
    await integration?.refreshed();
  });
};
/** Redémarrage de l'app : nouveau service sans état (premier cycle pas encore fait), même base. */
const restart = async (initial: Partial<SyncStatus> = {}): Promise<void> => {
  integration?.dispose();
  sync = createFakeSyncService(initial);
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
  act(() => {
    start();
  });
  await settle();
};
const text = (): string | null => screen.queryByRole('status')?.textContent ?? null;
const trouble = (): unknown => useAppStatusStore.getState().sources.syncTrouble;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
  await db.data.repos.sync.saveState(PHONE, { platform: 'ios', stateSeq: 4, status: 'forgotten' });
  await db.data.repos.sync.saveState(LAPTOP, { platform: 'windows', stateSeq: 2, status: 'active' });
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

describe('bandeau « forgotten » (critère 16) : dès le démarrage, effacé à la résolution', () => {
  it('l’appareil oublié le reste affiché après un redémarrage, avant le premier cycle ; il disparaît quand un cycle conclut sans oubli', async () => {
    render(<AppStatusBanner />);
    start();
    await settle();
    act(() => sync.setStatus({ phase: 'forgotten', lastSyncAt: NOW as IsoDateTime }));
    await settle();
    expect(text()).toContain('Cet appareil a été oublié : associez-le de nouveau');
    expect(await db.data.repos.sync.getMeta(BLOCKING_PHASE_META)).toContain('forgotten');
    // Redémarrage : le service repart en « synchro en cours » sans rien savoir ; le bandeau vient de la base.
    await restart({ phase: 'syncing' });
    expect(text()).toContain('Cet appareil a été oublié : associez-le de nouveau');
    // Résolution (« Associer de nouveau » faite, premier cycle sans oubli) : le bandeau disparaît.
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime }));
    await settle();
    expect(trouble()).toBeUndefined();
    expect(await db.data.repos.sync.getMeta(BLOCKING_PHASE_META)).toBeNull();
    // Et il ne revient pas au redémarrage suivant.
    await restart({ phase: 'syncing' });
    expect(trouble()).toBeUndefined();
  });
});

describe('bandeau « forget-pending » : dès le démarrage, effacé quand les fichiers ont disparu', () => {
  it('l’attente gardée dans sync_meta est montrée avant le premier cycle, nomme l’appareil attendu, et disparaît quand un cycle conclut sans elle', async () => {
    await db.data.repos.sync.setMeta(FORGET_META.deletions, JSON.stringify([{ deviceId: PHONE, state: 'waiting', waitingFor: LAPTOP }]));
    render(<AppStatusBanner />);
    await restart({ phase: 'syncing' });
    expect(text()).toMatch(/^iPhone oublié : suppression de ses fichiers en attente de PC/);
    // Les fichiers ont disparu : le moteur écrit « done » ; un cycle conclu efface le bandeau.
    await db.data.repos.sync.setMeta(FORGET_META.deletions, JSON.stringify([{ deviceId: PHONE, state: 'done', waitingFor: null }]));
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, forget: null }));
    await settle();
    expect(trouble()).toBeUndefined();
    await restart({ phase: 'syncing' });
    expect(trouble()).toBeUndefined();
  });

  it('une attente que le moteur n’a pas soldée reste affichée à chaque démarrage : rien ne l’efface sauf la résolution', async () => {
    await db.data.repos.sync.setMeta(FORGET_META.deletions, JSON.stringify([{ deviceId: PHONE, state: 'waiting', waitingFor: null }]));
    render(<AppStatusBanner />);
    for (let i = 0; i < 3; i += 1) {
      await restart({ phase: 'syncing' });
      expect(text()).toContain('iPhone oublié : suppression de ses fichiers en attente');
    }
  });
});

describe('bandeau « forget-failed » : dès le démarrage, effacé à la réussite seulement', () => {
  it('l’échec gardé revient à chaque démarrage tant que forgetFailure n’est pas effacé, puis disparaît', async () => {
    await db.data.repos.sync.setMeta(FORGET_META.failure, JSON.stringify({ deviceId: PHONE, code: 'cloud-pending', at: NOW, step: 'delete' }));
    render(<AppStatusBanner />);
    for (let i = 0; i < 2; i += 1) {
      await restart({ phase: 'syncing' });
      expect(text()).toContain('iPhone');
      expect(trouble()).toMatchObject({ detail: 'forget-failed' });
    }
    // Un cycle conclu sans que le moteur ait effacé l'échec : il persiste (jamais effacé par un simple cycle conclu).
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime }));
    await settle();
    await restart({ phase: 'syncing' });
    expect(trouble()).toMatchObject({ detail: 'forget-failed' });
    // Réussite : effacé par le moteur.
    await db.data.repos.sync.setMeta(FORGET_META.failure, null);
    await restart({ phase: 'syncing' });
    expect(trouble()).toBeUndefined();
  });

  it('une valeur illisible de forgetFailure ne casse rien : état local illisible signalé (Y-TECH-02, jamais lue comme « aucune »)', async () => {
    await db.data.repos.sync.setMeta(FORGET_META.failure, '{pas du json');
    render(<AppStatusBanner />);
    await restart({ phase: 'syncing' });
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('state-unreadable');
  });
});
