import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemoryBackup, type BackupFailureReason, type BackupVersion, type MemoryBackup } from '../../platform/backup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { startSyncIntegration } from '../sync/startSync';
import { createFakeSyncService } from '../sync/testKit';
import { BackupSheet } from './BackupSheet';
import { backupStore, RESTART_ANNOUNCE_MS } from './backupStore';
import { RESTORE_RESULT_KEY } from './restoreMemo';

/**
 * QA du lot F, P-04-iOS critères 6 et 7 : chaque état d'échec de la restauration offre une action utile (jamais un « Réessayer » qui ne peut
 * pas réussir), sans chemin dans le message, et l'action offerte fonctionne vraiment.
 */
const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fe');
const VERSION: BackupVersion = { name: 'circletasks-daily-20261007.db', kind: 'daily', stamp: '20261007', size: 20_480, modifiedMs: Date.parse('2026-10-07T03:12:00Z'), tasks: 4, schemaVersion: 17 };

describe('P-04-iOS QA : états d’échec de la restauration, une action utile chacun', () => {
  let db: TestDb;
  let backups: MemoryBackup;
  let container: AppContainer;

  beforeEach(async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
    backups = createMemoryBackup({ versions: [VERSION] });
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, backups, platform: { runtime: 'tauri', os: 'ios' } });
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAppStatusStore.setState({ sources: {} });
    window.localStorage.clear();
    await db.close();
  });

  async function openAndRestore(): Promise<HTMLElement> {
    render(
      <AppContainerProvider container={container}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /07\/10|7 oct/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
    return screen.findByRole('alert');
  }

  // Raison -> la base est-elle fermée quand elle survient ? (Rust vérifie `check_backup` AVANT la fermeture ; les autres arrivent après.)
  const NOT_RETRYABLE_OPEN: readonly BackupFailureReason[] = ['corrupt', 'newer-schema', 'not-found'];
  const NOT_RETRYABLE_CLOSED: readonly BackupFailureReason[] = ['corrupt', 'rollback-failed', 'restore-pending', 'restore-unconfirmed', 'io'];
  const RETRYABLE: readonly BackupFailureReason[] = ['io', 'sync-busy', 'busy', 'db-open'];

  it.each(NOT_RETRYABLE_OPEN)('critère 7 : %s, base ouverte : aucun « Réessayer » (ce fichier ne passera jamais), l’utilisateur peut choisir une autre version ou fermer', async (reason) => {
    backups.failNext('restore', reason, { databaseClosed: false });
    const alert = await openAndRestore();
    expect(alert.textContent).not.toMatch(/[A-Za-z]:\\|\/var\/|\/private\//);
    expect(within(alert).queryByRole('button', { name: 'Réessayer' })).toBeNull();
    expect(within(alert).queryByRole('button', { name: 'Redémarrer' })).toBeNull();
    expect(screen.getByRole('button', { name: /07\/10|7 oct/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeEnabled();
    expect(backups.restarts.count).toBe(0);
    expect(window.localStorage.getItem(RESTORE_RESULT_KEY)).toBeNull();
  });

  it.each(NOT_RETRYABLE_CLOSED)('critère 7 : %s, base fermée : « Redémarrer » est l’action offerte, jamais « Réessayer », et il recharge', async (reason) => {
    backups.failNext('restore', reason, { databaseClosed: true });
    const alert = await openAndRestore();
    expect(alert.textContent).not.toMatch(/[A-Za-z]:\\|\/var\/|\/private\//);
    expect(within(alert).queryByRole('button', { name: 'Réessayer' })).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Redémarrer' }));
    await waitFor(() => expect(backups.restarts.count).toBe(1));
  });

  it('restore-unconfirmed : texte dédié (rouvrir, puis « Garder les données synchronisées »), pas celui de la restauration interrompue', async () => {
    backups.failNext('restore', 'restore-unconfirmed', { databaseClosed: true });
    const alert = await openAndRestore();
    expect(alert).toHaveTextContent('La restauration précédente n’est pas encore confirmée');
    expect(alert).toHaveTextContent('Garder les données synchronisées');
    expect(alert).not.toHaveTextContent('interrompue');
  });

  it.each(RETRYABLE)('critère 7 : %s, base ouverte : « Réessayer » relance réellement la restauration et elle aboutit', async (reason) => {
    backups.failNext('restore', reason, { databaseClosed: false });
    const alert = await openAndRestore();
    expect(within(alert).queryByRole('button', { name: 'Redémarrer' })).toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    await vi.waitFor(() => expect(backups.restores).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(RESTART_ANNOUNCE_MS);
    expect(backups.restarts.count).toBe(1);
    expect(backupStore.get(container).getState().restorePhase).toBe('done');
  });


  it('critère 6 : après un refus « base ouverte », la synchro repart (rien n’est resté en pause) et aucun rechargement n’a lieu', async () => {
    const sync = createFakeSyncService({ phase: 'idle' });
    const withSync = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, backups, sync, platform: { runtime: 'tauri', os: 'ios' } });
    const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
    const integration = startSyncIntegration(withSync, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined });
    try {
      await vi.waitFor(() => expect(sync.calls).toEqual(['open']));
      backups.failNext('restore', 'corrupt', { databaseClosed: false });
      render(
        <AppContainerProvider container={withSync}>
          <BackupSheet onClose={() => undefined} />
        </AppContainerProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: /07\/10|7 oct/ }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
      await screen.findByRole('alert');
      // La reprise du planificateur relance un cycle d'ouverture : la synchro n'est pas restée suspendue.
      await vi.waitFor(() => expect(sync.calls).toEqual(['open', 'open']));
      expect(backups.restarts.count).toBe(0);
    } finally {
      integration.dispose();
    }
  });

  it('critère 4 : liste illisible -> message dans la feuille ; « Sauvegarder maintenant » reste disponible et rend la liste', async () => {
    backups.failNext('list', 'io');
    render(
      <AppContainerProvider container={container}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Impossible de lire la liste des sauvegardes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /07\/10|7 oct/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sauvegarder maintenant' }));
    expect(await screen.findByRole('button', { name: /07\/10|7 oct/ })).toBeInTheDocument();
    expect(screen.queryByText('Impossible de lire la liste des sauvegardes.')).toBeNull();
  });
});
