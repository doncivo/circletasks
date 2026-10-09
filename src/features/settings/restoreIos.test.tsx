import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemoryBackup, type BackupVersion, type MemoryBackup } from '../../platform/backup';
import { DbFailureDetails } from '../app/DbFailureDetails';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { useNoticeStore } from '../app/notice';
import { announceRestoreResult } from '../app/startup';
import { createNotificationRunner, getNotificationRunner } from '../reminders/notificationRunner';
import { RestoreMarkerResume } from '../sync/RestoreMarkerResume';
import { restoreMarkerFailure, startSyncIntegration, type SyncIntegration } from '../sync/startSync';
import { createFakeSyncService, type FakeSyncService } from '../sync/testKit';
import { BackupSheet } from './BackupSheet';
import { backupStore, RESTART_ANNOUNCE_MS } from './backupStore';
import { MARKER_FAILED_KEY, readMarkerFailed, RESTORE_RESULT_KEY, writeMarkerFailed, writeRestoreResult } from './restoreMemo';
import { quiesceForRestore } from './restoreQuiesce';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fd');
const VERSION: BackupVersion = { name: 'circletasks-daily-20261007.db', kind: 'daily', stamp: '20261007', size: 20_480, modifiedMs: Date.parse('2026-10-07T03:12:00Z'), tasks: 4, schemaVersion: 17 };
const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

describe('P-04-iOS : restauration sur iPhone (mise au calme, mémo, marqueur, écrans)', () => {
  let db: TestDb;
  let sync: FakeSyncService;
  let backups: MemoryBackup;
  let container: AppContainer;
  let integration: SyncIntegration | null;

  beforeEach(async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
    sync = createFakeSyncService({ phase: 'idle' });
    backups = createMemoryBackup({ versions: [VERSION] });
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, sync, backups, platform: { runtime: 'tauri', os: 'ios' } });
    integration = null;
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  afterEach(async () => {
    integration?.dispose();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAppStatusStore.setState({ sources: {} });
    window.localStorage.clear();
    await db.close();
  });

  const startIntegration = (): SyncIntegration => {
    integration = startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined });
    return integration;
  };

  // --- critère 6 : mise au calme ---

  it('coordinateur des rappels : en pause, aucun passage ne démarre ; la pause attend le passage en cours ; reprise = un passage', async () => {
    let finish: (() => void) | undefined;
    const pass = vi.fn(() => new Promise<{ status: 'done' }>((resolve) => (finish = () => resolve({ status: 'done' }))) as never);
    const runner = createNotificationRunner(pass);
    void runner.request('open');
    let paused = false;
    const pausing = runner.pause().then(() => (paused = true));
    await Promise.resolve();
    expect(paused).toBe(false);
    void runner.request('sync');
    finish?.();
    await pausing;
    expect(pass).toHaveBeenCalledTimes(1);
    runner.resume();
    await waitFor(() => expect(pass).toHaveBeenCalledTimes(2));
    finish?.();
  });

  it('cycle de synchro qui ne finit pas en 10 s : sync-busy, tout est relâché, rien n’est modifié', async () => {
    startIntegration();
    sync.hold = true;
    const running = sync.syncNow('manual');
    vi.spyOn(sync, 'running').mockReturnValue(running);
    expect(await quiesceForRestore(container, 20)).toBe('sync-busy');
    sync.release();
    vi.mocked(sync.running).mockReturnValue(null);
    const handle = await quiesceForRestore(container, 20);
    expect(handle).not.toBe('sync-busy');
    const before = sync.calls.length;
    if (typeof handle === 'object') handle.release();
    // Reprise : un cycle d'ouverture repart.
    await waitFor(() => expect(sync.calls.length).toBe(before + 1));
  });

  it('critère 6 : restauration refusée pendant un cycle : message « synchronisation en cours », « Réessayer » qui réussit ensuite', async () => {
    startIntegration();
    sync.hold = true;
    const running = sync.syncNow('manual');
    const spy = vi.spyOn(sync, 'running').mockReturnValue(running);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = backupStore.get(container);
    const restoring = store.getState().restore(VERSION);
    await vi.advanceTimersByTimeAsync(10_000);
    await restoring;
    expect(store.getState().restorePhase).toBe('failed');
    expect(store.getState().restoreError).toBe('sync-busy');
    expect(backups.restores).toHaveLength(0);
    expect(window.localStorage.getItem(RESTORE_RESULT_KEY)).toBeNull();
    sync.release();
    spy.mockReturnValue(null);
    const again = store.getState().restore(VERSION);
    await vi.advanceTimersByTimeAsync(RESTART_ANNOUNCE_MS);
    await again;
    expect(backups.restores).toHaveLength(1);
    expect(backups.restarts.count).toBe(1);
  });

  // --- critères 7 et 12 : mémo et marqueur ---

  it('critère 12 : marqueur non écrit -> mémos (issue et marqueur), message avant le redémarrage, rechargement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    backups.markerNext({ marker: 'failed', markerCode: 'io' });
    const store = backupStore.get(container);
    const restoring = store.getState().restore(VERSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().markerFailure).toBe('io');
    await vi.advanceTimersByTimeAsync(RESTART_ANNOUNCE_MS);
    await restoring;
    expect(backups.restarts.count).toBe(1);
    expect(readMarkerFailed()).toMatchObject({ backup: VERSION.name, code: 'io' });
    expect(JSON.parse(window.localStorage.getItem(RESTORE_RESULT_KEY) ?? '{}')).toMatchObject({ outcome: 'done', marker: 'failed', markerCode: 'io' });
  });

  it('critère 7 : échec après la fermeture -> issue mémorisée et dite APRÈS le redémarrage (une seule fois), journal restore-failed', async () => {
    backups.failNext('restore', 'io', { databaseClosed: true });
    const store = backupStore.get(container);
    await store.getState().restore(VERSION);
    expect(store.getState().restartNeeded).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(RESTORE_RESULT_KEY) ?? '{}')).toMatchObject({ outcome: 'failed', reason: 'io', databaseClosed: true });
    announceRestoreResult();
    expect(useNoticeStore.getState().notice?.text).toBe('La restauration n’a pas abouti : vos données sont celles d’avant. Code : io');
    expect(window.localStorage.getItem(RESTORE_RESULT_KEY)).toBeNull();
    useNoticeStore.getState().clear();
    announceRestoreResult();
    expect(useNoticeStore.getState().notice).toBeNull();
    writeRestoreResult({ outcome: 'done', reason: null, databaseClosed: false, marker: 'written', markerCode: null });
    announceRestoreResult();
    expect(useNoticeStore.getState().notice?.text).toBe('Restauration terminée.');
  });

  it('critère 12 : au démarrage avec le mémo : aucun cycle, bandeau persistant avec le code ; « Reprendre la synchronisation » après confirmation', async () => {
    writeMarkerFailed({ backup: VERSION.name, code: 'io', at: '2026-10-08T08:00:00.000Z' });
    startIntegration();
    await waitFor(() => expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('restore-marker-failed'));
    expect(sync.calls).toEqual([]);
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toContain('Code : io');
    expect(restoreMarkerFailure(container)).toBe('io');
    render(
      <AppContainerProvider container={container}>
        <RestoreMarkerResume />
      </AppContainerProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre la synchronisation' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reprendre la synchronisation' }));
    expect(window.localStorage.getItem(MARKER_FAILED_KEY)).toBeNull();
    await waitFor(() => expect(sync.calls).toEqual(['open']));
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('critère 12 : marqueur réécrit au démarrage (contexte de restauration présent) : mémo effacé, la fenêtre de choix habituelle reprend', async () => {
    writeMarkerFailed({ backup: VERSION.name, code: 'io', at: '2026-10-08T08:00:00.000Z' });
    sync.restore = { options: ['apply', 'keep'] } as never;
    startIntegration();
    await waitFor(() => expect(readMarkerFailed()).toBeNull());
    await waitFor(() => expect(sync.calls).toEqual(['open']));
  });

  // --- critère 2 : écran de l'iPhone ---

  it('critère 2 : dossier de l’app (non visible dans Fichiers), aucun « Afficher dans le dossier » ; voile « Restauration en cours », app inerte', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    const ios = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, sync, backups: { ...backups, reveal: undefined } as never, platform: { runtime: 'tauri', os: 'ios' } });
    let release: (() => void) | undefined;
    vi.spyOn(getNotificationRunner(ios), 'pause').mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    render(
      <AppContainerProvider container={ios}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Dossier des sauvegardes : Dossier de l’app (non visible dans Fichiers)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Afficher dans le dossier' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /07\/10|7 oct/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
    expect(await screen.findByText('Restauration en cours…')).toBeInTheDocument();
    expect(root).toHaveAttribute('inert');
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    root.remove();
  });

  it('critère 5 : récupération impossible : écran d’erreur sans « Réessayer » (recharger ne peut pas réussir), « Copier le détail » reste', () => {
    render(<DbFailureDetails failure={{ phase: 'open', step: 'load', errorName: 'StartupRecoveryError', message: 'startup-recovery: recovery-conflict' }} retry={false} readEnvironment={() => new Promise(() => undefined)} />);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
    expect(screen.getByTestId('db-failure-detail')).toHaveTextContent('recovery-conflict');
    expect(screen.getByRole('button', { name: /Copier/ })).toBeInTheDocument();
  });
});
