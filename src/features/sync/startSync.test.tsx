// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { SYNCING_BANNER_DELAY_MS } from '../../domain/sync/limits';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { createMemorySyncPlatform, type MemorySyncPlatform, type SyncFolderInfo } from '../../platform/sync';
import { createSyncService, silentSyncLogger } from '../../sync';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { handleSyncPaired, JOIN_META } from './pairingStatus';
import { BLOCKING_PHASE_META, startSyncIntegration, type SyncIntegration } from './startSync';
import { syncStore } from './syncStore';
import { statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Bandeaux A-09 de la synchro (critère 9, solde) : `SyncService` factice, base SQLite de test, horloge manuelle et minuterie factice
 * (`setTimeout` injecté, déclenché à la main) ; aucun délai réel, aucune attente par sondage.
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const LAPTOP = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c3');
const NOW = '2026-10-06T08:00:00.000Z';

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;
let integration: SyncIntegration | null;
/** Minuterie factice : rien ne part tout seul. */
let timers: { handler: () => void; ms: number; cleared: boolean }[];

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

function start(): SyncIntegration {
  integration = startSyncIntegration(container, {
    document: fakeDocument,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  return integration;
}

function stop(): void {
  integration?.dispose();
  integration = null;
}

/** Déclenche les minuteurs armés et non annulés (avance de l'horloge factice). */
function fireTimers(): void {
  for (const timer of timers.splice(0)) if (!timer.cleared) act(() => timer.handler());
}

const banner = (): HTMLElement | null => screen.queryByTestId('status-banner-region')?.querySelector<HTMLElement>('.ct-status-banner') ?? null;
const set = (patch: Partial<SyncStatus>): void => act(() => sync.setStatus(patch));
const device = (deviceId: DeviceId, platform: 'ios' | 'windows', status: SyncDeviceStatus['status'], self = false): SyncDeviceStatus => ({ deviceId, platform, self, status, lastReadAt: null });
const renderBanner = (): void => void render(<AppStatusBanner />);

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService();
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
  timers = [];
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
});

afterEach(async () => {
  cleanup();
  stop();
  vi.restoreAllMocks();
  await db.close();
});

describe('phases en échec ou bloquées (critère 9 c)', () => {
  const cases: readonly { phase: SyncStatus['phase']; patch: Partial<SyncStatus>; text: string }[] = [
    { phase: 'error', patch: { errorCode: 'folder-unreachable' }, text: '' },
    { phase: 'error', patch: { errorCode: null }, text: 'La synchronisation a échoué : nouvel essai au prochain cycle' },
    { phase: 'key-mismatch', patch: {}, text: 'Ce dossier a été chiffré avec une autre clé : associez cet appareil' },
    { phase: 'clock-ahead', patch: { clockAheadDevice: PHONE, devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'clock-ahead')] }, text: 'L’horloge de iPhone est en avance : vérifiez sa date et son heure' },
    { phase: 'needs-pairing', patch: {}, text: 'Associez cet appareil pour synchroniser' },
    { phase: 'restore-choice', patch: {}, text: 'Un choix est à faire après la restauration' },
  ];

  it('chaque phase : bandeau immédiat, texte identique à la ligne de Réglages, role="status", bouton « Voir »', async () => {
    renderBanner();
    await start().refreshed();
    for (const { phase, patch, text } of cases) {
      set({ phase, ...patch });
      const expected = statusLine(sync.status(), db.clock.nowMs());
      if (text) expect(expected).toBe(text);
      expect(banner()?.textContent, phase).toBe(`${expected}Voir`);
      expect(screen.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    }
  });

  it('« Voir » ouvre Réglages › Synchronisation', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'error', errorCode: 'io' });
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'sync' });
  });

  it('restore-choice : « Voir » ouvre directement la fenêtre de choix', async () => {
    const openRestore = vi.fn(() => Promise.resolve());
    syncStore.get(container).setState({ openRestore });
    renderBanner();
    await start().refreshed();
    set({ phase: 'restore-choice' });
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(openRestore).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().route).toEqual(INITIAL_NAVIGATION.route);
  });

  it('disparaît dès que la phase change ; idle, waiting-icloud, not-configured : aucun syncTrouble', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'key-mismatch' });
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('key-mismatch');
    for (const phase of ['idle', 'waiting-icloud', 'not-configured'] as const) {
      set({ phase });
      expect(useAppStatusStore.getState().sources.syncTrouble, phase).toBeUndefined();
    }
    set({ phase: 'idle' });
    expect(banner()).toBeNull();
  });

  it('update-required : couvert par « Mettez à jour l’app », jamais deux bandeaux', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'update-required', devices: [device(SELF, 'windows', 'active', true), { ...device(PHONE, 'ios', 'newer-major'), newer: 'major' }] });
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    expect(document.querySelectorAll('.ct-status-banner')).toHaveLength(1);
    expect(banner()?.textContent).toContain('Mettez à jour');
  });

  it('pendant le cycle suivant, l’échec reste affiché (pas de clignotement) ; il part quand le cycle conclut « à jour »', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'error', errorCode: 'io' });
    const text = banner()?.textContent;
    set({ phase: 'syncing' });
    expect(banner()?.textContent).toBe(text);
    fireTimers();
    // « Synchro en cours » est moins prioritaire : l'échec reste devant.
    expect(banner()?.textContent).toBe(text);
    set({ phase: 'idle', errorCode: null, lastSyncAt: NOW as IsoDateTime });
    expect(banner()).toBeNull();
  });
});

describe('« Synchro en cours » discret (critère 9 d)', () => {
  it('cycle court : rien ne s’affiche, le minuteur est annulé', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'syncing' });
    expect(banner()).toBeNull();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(SYNCING_BANNER_DELAY_MS);
    expect(SYNCING_BANNER_DELAY_MS).toBe(1_000);
    set({ phase: 'idle' });
    expect(timers[0]?.cleared).toBe(true);
    fireTimers();
    expect(banner()).toBeNull();
  });

  it('cycle de plus de 1 s : bandeau à l’échéance, retiré à la fin du cycle', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'syncing' });
    set({ phase: 'syncing', progress: { done: 1, total: 4 } });
    expect(timers).toHaveLength(1);
    fireTimers();
    expect(banner()?.textContent).toBe('Synchro en cours');
    set({ phase: 'idle', progress: null });
    expect(banner()).toBeNull();
  });

  it('« En attente d’iCloud » et un échec s’affichent sans délai', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'waiting-icloud' });
    expect(banner()?.textContent).toBe('En attente d’iCloud');
    set({ phase: 'error', errorCode: 'io' });
    expect(banner()).not.toBeNull();
    expect(timers).toHaveLength(0);
  });
});

describe('« En attente d’iCloud » avec cause (critère 9 e)', () => {
  it('cause connue : texte de la ligne de Réglages ; sans cause : texte générique', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped' });
    expect(banner()?.textContent).toBe('Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour');
    expect(banner()?.textContent).toBe(statusLine(sync.status(), 0));
    set({ phase: 'waiting-icloud', errorCode: 'cloud-pending' });
    expect(banner()?.textContent).toBe(statusLine(sync.status(), 0));
    expect(banner()?.textContent).not.toBe('En attente d’iCloud');
    set({ phase: 'waiting-icloud', errorCode: null });
    expect(banner()?.textContent).toBe('En attente d’iCloud');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('états persistés et redémarrage (critères 9 f, 9 i, 9 j)', () => {
  const failure = { epoch: 'e0001-x', from: SELF, seq: 1, done: 1200, total: 5000, failure: 'io' };

  it('arrivée en échec : bandeau au texte de JoinProgress, avant le premier cycle, après un redémarrage, jusqu’à la réussite', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify(failure));
    renderBanner();
    await start().refreshed();
    const shown = useAppStatusStore.getState().sources.syncTrouble;
    expect(shown?.detail).toBe('join-failed');
    // Même texte que la ligne de JoinProgress (même clé, mêmes nombres formatés ; vérifiée par SyncDetailsPairing.test.tsx).
    const n = new Intl.NumberFormat('fr-FR');
    expect(shown?.message).toBe(`La réception de vos données s’est arrêtée à ${n.format(1200)} / ${n.format(5000)} : elle reprendra à la prochaine synchronisation`);

    // Redémarrage simulé : dispose retire l'état, un nouveau démarrage sur le même stockage le rétablit avant tout cycle.
    stop();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    await start().refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('join-failed');

    // Un cycle réussi d'autre nature ne le retire pas, ni le passage du temps.
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
    db.clock.advance(40 * 86_400_000);
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('join-failed');

    // Réussite : le moteur efface l'entrée, la fin du cycle relit.
    await db.data.repos.sync.setMeta(JOIN_META, null);
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, conflictsThisWeek: 1 });
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('horloge en retard pendant l’arrivée : texte dédié de JoinProgress', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ ...failure, failure: 'clock-ahead' }));
    renderBanner();
    await start().refreshed();
    expect(banner()?.textContent).toContain('l’horloge de cet appareil est en retard');
  });

  it('arrivée en attente sans échec : aucun bandeau d’échec', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ ...failure, failure: null }));
    renderBanner();
    await start().refreshed();
    expect(banner()).toBeNull();
  });

  it('base illisible pendant une relecture : signalée (« (+1) » avec l’échec gardé, qui reste), effacée à la lecture réussie suivante', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify(failure));
    renderBanner();
    await start().refreshed();
    const getMeta = vi.spyOn(db.data.repos.sync, 'getMeta').mockRejectedValue(new Error('base occupée'));
    vi.spyOn(db.data.repos.sync, 'getStates').mockRejectedValue(new Error('base occupée'));
    set({ phase: 'idle' });
    await integration?.refreshed();
    const shown = useAppStatusStore.getState().sources.syncTrouble;
    expect(shown?.detail).toBe('state-unreadable');
    expect(shown?.more).toBe(1);
    expect(banner()?.textContent).toBe('État de la synchro inaccessible, nouvel essai au prochain cycle (+1)Voir');
    expect(screen.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeTruthy();
    // Lecture réussie : le signal part, l'échec gardé reste.
    getMeta.mockRestore();
    set({ phase: 'idle', conflictsThisWeek: 1 });
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('join-failed');
    expect(useAppStatusStore.getState().sources.syncTrouble?.more).toBe(0);
  });

  it('relecture de la base seulement au changement de phase, à la conclusion d’un cycle et sur un changement d’association (revue 4)', async () => {
    renderBanner();
    await start().refreshed();
    const getMeta = vi.spyOn(db.data.repos.sync, 'getMeta');
    set({ phase: 'syncing' });
    await integration?.refreshed();
    const afterPhase = getMeta.mock.calls.length;
    expect(afterPhase).toBeGreaterThan(0);
    for (let done = 1; done <= 5; done += 1) set({ phase: 'syncing', progress: { done, total: 5 } });
    await integration?.refreshed();
    expect(getMeta.mock.calls.length).toBe(afterPhase);
    set({ phase: 'idle', progress: null });
    await integration?.refreshed();
    expect(getMeta.mock.calls.length).toBeGreaterThan(afterPhase);
  });

  it('appareils foreign, corrupt, rollback avant le premier cycle (sync_state), nommés comme dans APPAREILS', async () => {
    await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
    await db.data.repos.sync.saveState(PHONE, { platform: 'ios', status: 'corrupt', stateSeq: 3 });
    await db.data.repos.sync.saveState(LAPTOP, { platform: 'windows', status: 'active', stateSeq: 2 });
    renderBanner();
    await start().refreshed();
    expect(banner()?.textContent).toBe('iPhone : Fichiers illisiblesVoir');
    // Après le premier cycle, l'état exposé fait foi.
    set({ phase: 'idle', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'rollback'), device(LAPTOP, 'windows', 'foreign')] });
    await integration?.refreshed();
    // Deux PC : nommés avec 4 caractères, comme dans APPAREILS.
    expect(banner()?.textContent).toBe('PC 6000 : Clé différente (+1)Voir');
    set({ phase: 'idle', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'active'), device(LAPTOP, 'windows', 'active')] });
    await integration?.refreshed();
    expect(banner()).toBeNull();
  });

  it('avant le premier cycle, tous les autres appareils d’une autre clé : « associez cet appareil »', async () => {
    await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
    await db.data.repos.sync.saveState(PHONE, { platform: 'ios', status: 'foreign', stateSeq: 3 });
    renderBanner();
    await start().refreshed();
    expect(banner()?.textContent).toBe('Ce dossier a été chiffré avec une autre clé : associez cet appareilVoir');
  });

  it('dispose retire tous les états posés par la synchro (critère 9 j), jamais « Hors ligne »', async () => {
    renderBanner();
    const status = useAppStatusStore.getState();
    act(() => status.setStatus('offline', {}));
    await start().refreshed();
    set({ phase: 'syncing', reintegrationFailure: { fields: 2, tables: ['task'], at: NOW as IsoDateTime, errors: ['x'] } });
    fireTimers();
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify(failure));
    set({ phase: 'waiting-icloud', errorCode: 'cloud-pending' });
    await integration?.refreshed();
    set({ phase: 'syncing' });
    fireTimers();
    const sources = useAppStatusStore.getState().sources;
    // « En attente d’iCloud » reste pendant le cycle suivant (QA-2) : les cinq états à la fois.
    expect(Object.keys(sources).sort()).toEqual(['offline', 'syncTrouble', 'syncing', 'updateRequired', 'waitingIcloud']);
    act(() => stop());
    expect(Object.keys(useAppStatusStore.getState().sources)).toEqual(['offline']);
    act(() => status.setStatus('offline', null));
  });
});

describe('un seul bandeau, le plus urgent (critère 9 g) ; sobriété (9 h)', () => {
  it('horloge + arrivée en échec + appareil illisible : le plus urgent, « (+2) »', async () => {
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify({ epoch: 'e', from: SELF, seq: 1, done: 8, total: 20, failure: 'io' }));
    renderBanner();
    await start().refreshed();
    set({ phase: 'clock-ahead', clockAheadDevice: PHONE, devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'clock-ahead'), device(LAPTOP, 'windows', 'corrupt')] });
    await integration?.refreshed();
    expect(document.querySelectorAll('.ct-status-banner')).toHaveLength(1);
    expect(banner()?.textContent).toBe('L’horloge de iPhone est en avance : vérifiez sa date et son heure (+2)Voir');
  });

  it('« Hors ligne » ne masque jamais un échec ; un agenda déconnecté passe devant', async () => {
    renderBanner();
    await start().refreshed();
    act(() => useAppStatusStore.getState().setStatus('offline', {}));
    set({ phase: 'error', errorCode: 'io' });
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeDefined();
    expect(banner()?.textContent).not.toContain('Hors ligne');
    act(() => useAppStatusStore.getState().setStatus('calendarDisconnected', { detail: 'Perso' }));
    expect(banner()?.textContent).toContain('Agenda Perso déconnecté');
    act(() => {
      useAppStatusStore.getState().setStatus('calendarDisconnected', null);
      useAppStatusStore.getState().setStatus('offline', null);
    });
  });

  it('texte sans chemin, clé ni contenu ; un même état reposé ne re-rend pas la source', async () => {
    renderBanner();
    await start().refreshed();
    set({ phase: 'error', errorCode: 'unsafe-folder', folderLabel: 'CircleTasks' });
    const first = useAppStatusStore.getState().sources.syncTrouble;
    expect(first?.message).not.toMatch(/[\\/]|[A-Za-z]:|\.ctx|\.jsonl/);
    set({ conflictsThisWeek: 3 });
    expect(useAppStatusStore.getState().sources.syncTrouble).toBe(first);
  });

  it('sans synchro : rien, aucun état posé', async () => {
    const bare = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: null });
    const none = startSyncIntegration(bare);
    await none.refreshed();
    expect(useAppStatusStore.getState().sources).toEqual({});
    none.dispose();
  });
});

describe('phase bloquante persistée : visible dès le démarrage (revue, point 7)', () => {
  let platform: MemorySyncPlatform;
  beforeEach(() => {
    platform = createMemorySyncPlatform();
  });

  /** Nouveau processus : service neuf (état initial, aucun cycle encore), même base. */
  async function freshProcess(patch: Partial<SyncStatus> = {}): Promise<void> {
    stop();
    sync = createFakeSyncService(patch);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform });
    await act(async () => {
      await start().refreshed();
    });
  }

  const blockedCases: readonly Partial<SyncStatus>[] = [{ phase: 'error', errorCode: 'folder-unreachable' }, { phase: 'needs-pairing' }, { phase: 'key-mismatch' }];
  for (const blocked of blockedCases) {
    it(`${String(blocked.phase)} : gardée à la conclusion du cycle, montrée au redémarrage avant tout cycle, effacée quand un cycle conclut sans elle`, async () => {
      renderBanner();
      await start().refreshed();
      set(blocked);
      await integration?.refreshed();
      const expected = statusLine(sync.status(), db.clock.nowMs());
      await freshProcess();
      expect(sync.status().phase).toBe('not-configured');
      expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe(expected);
      // Le premier cycle conclut sans elle : effacée, et ne revient pas au redémarrage suivant.
      set({ phase: 'idle', errorCode: null });
      await integration?.refreshed();
      expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
      await freshProcess();
      expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    });
  }

  it('clock-ahead : l’appareil est nommé d’après sync_state dès le démarrage', async () => {
    await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
    await db.data.repos.sync.saveState(PHONE, { platform: 'ios', status: 'clock-ahead', stateSeq: 3 });
    renderBanner();
    await start().refreshed();
    set({ phase: 'clock-ahead', clockAheadDevice: PHONE, devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'clock-ahead')] });
    await integration?.refreshed();
    await freshProcess();
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe('L’horloge de iPhone est en avance : vérifiez sa date et son heure');
  });

  it('restore-choice : le marqueur de restauration suffit, dès le démarrage ; « Voir » ouvre la fenêtre de choix', async () => {
    platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 1 });
    renderBanner();
    await freshProcess();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('restore-choice');
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe('Un choix est à faire après la restauration');
    const openRestore = vi.fn(() => Promise.resolve());
    syncStore.get(container).setState({ openRestore });
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(openRestore).toHaveBeenCalledTimes(1);
  });

  it('lecture du marqueur en échec au démarrage : signalée', async () => {
    vi.spyOn(platform.restoreMarker, 'get').mockRejectedValue(new Error('io'));
    renderBanner();
    await freshProcess();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('state-unreadable');
  });
});

describe('« Synchro en cours » avec le vrai service : un seul seuil (revue, point 3)', () => {
  it('cycle sans travail de 1,5 s : bandeau visible dès que le service publie la phase, sans second délai', async () => {
    const base = createMemorySyncPlatform();
    let release: (info: SyncFolderInfo) => void = () => undefined;
    const held = new Promise<SyncFolderInfo>((resolve) => (release = resolve));
    const serviceTimers: (() => void)[] = [];
    const service = createSyncService({
      data: db.data,
      platform: { ...base, folder: { ...base.folder, info: () => held } },
      hlc: createHlcClock({ clock: db.clock, deviceId: SELF }),
      clock: db.clock,
      deviceId: SELF,
      sv: 1,
      logger: silentSyncLogger,
      setTimeout: (handler) => serviceTimers.push(handler),
      clearTimeout: () => undefined,
    });
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: service });
    renderBanner();
    await start().refreshed();
    db.clock.advance(1_500);
    for (const fire of serviceTimers.splice(0)) act(() => fire());
    expect(banner()?.textContent).toBe('Synchro en cours');
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    release({ configured: false, label: null, kind: 'unknown', pinned: false });
    await act(async () => {
      await service.running();
      await integration?.refreshed();
    });
    expect(banner()).toBeNull();
  });

  it('cycle qui travaille dès le début : bandeau seulement au seuil compté depuis le début du cycle', async () => {
    renderBanner();
    await start().refreshed();
    const startedAt = db.clock.nowMs();
    db.clock.advance(400);
    set({ phase: 'syncing', cycleStartedAt: startedAt });
    expect(banner()).toBeNull();
    expect(timers.map((t) => t.ms)).toEqual([600]);
    fireTimers();
    expect(banner()?.textContent).toBe('Synchro en cours');
  });
});

describe('repli visible (revue, point 2)', () => {
  it('une erreur pendant le calcul du bandeau donne un bandeau d’échec, jamais rien', async () => {
    renderBanner();
    await start().refreshed();
    const real = sync.status;
    sync.status = () => {
      throw new Error('état illisible');
    };
    act(() => {
      try {
        sync.setStatus({ phase: 'idle' });
      } finally {
        sync.status = real;
      }
    });
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('error');
    expect(banner()?.textContent).toContain('La synchronisation a échoué');
  });
});

describe('seconde revue A-09', () => {
  const failure = { epoch: 'e0001-x', from: SELF, seq: 1, done: 1200, total: 5000, failure: 'io' };

  it('point 1 : écriture de la phase bloquante en échec signalée, puis retirée au cycle suivant qui n’a rien à écrire', async () => {
    renderBanner();
    await start().refreshed();
    const real = db.data.repos.sync.setMeta.bind(db.data.repos.sync);
    const setMeta = vi.spyOn(db.data.repos.sync, 'setMeta').mockImplementation(async (key, value) => {
      if (key === BLOCKING_PHASE_META) throw new Error('base occupée');
      return real(key, value);
    });
    set({ phase: 'error', errorCode: 'io' });
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('error');
    expect(useAppStatusStore.getState().sources.syncTrouble?.more).toBe(1);
    // Base rétablie ; le cycle conclut « à jour » : rien à écrire (aucune phase gardée), le signal part.
    setMeta.mockRestore();
    set({ phase: 'idle', errorCode: null });
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    expect(banner()).toBeNull();
  });

  it('point 2 : un changement d’association pendant une lecture est relu une fois à la fin, nombre de lectures borné', async () => {
    const real = db.data.repos.sync.getMeta.bind(db.data.repos.sync);
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let joinReads = 0;
    vi.spyOn(db.data.repos.sync, 'getMeta').mockImplementation(async (key) => {
      if (key !== JOIN_META) return real(key);
      joinReads += 1;
      if (joinReads === 1) {
        // Valeur lue avant l'échec ; la réponse n'arrive qu'après.
        const before = await real(key);
        await slow;
        return before;
      }
      return real(key);
    });
    renderBanner();
    const running = start();
    // Pendant la lecture : l'arrivée échoue (moteur) et l'association change.
    await db.data.repos.sync.setMeta(JOIN_META, JSON.stringify(failure));
    await act(async () => {
      await handleSyncPaired(container);
    });
    release();
    await act(async () => {
      await running.refreshed();
    });
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('join-failed');
    expect(joinReads).toBeLessThanOrEqual(3);
  });
});
