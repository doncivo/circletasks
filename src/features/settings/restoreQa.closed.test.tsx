import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemoryBackup, type BackupVersion, type MemoryBackup } from '../../platform/backup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { BackupRow } from './BackupRow';
import { BackupSheet } from './BackupSheet';
import { backupStore, RESTART_ANNOUNCE_MS } from './backupStore';

/** QA du lot F (tests rouges intégrés avec leur correction) : critères 7 et 13 de P-04-iOS. */
const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fa');
const VERSION: BackupVersion = { name: 'circletasks-daily-20261007.db', kind: 'daily', stamp: '20261007', size: 20_480, modifiedMs: Date.parse('2026-10-07T03:12:00Z'), tasks: 4, schemaVersion: 17 };

describe('P-04-iOS : défauts', () => {
  let db: TestDb;
  let backups: MemoryBackup;
  let container: AppContainer;
  beforeEach(async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
    backups = createMemoryBackup({ versions: [VERSION] });
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, backups, platform: { runtime: 'tauri', os: 'ios' } });
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    await db.close();
  });

  it('critère 7 : échec après la fermeture de la base -> l’app se recharge quand même (jamais d’app utilisable avec une connexion fermée)', async () => {
    backups.failNext('restore', 'io', { databaseClosed: true });
    render(
      <AppContainerProvider container={container}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /07\/10|7 oct/ }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(backupStore.get(container).getState().restartNeeded).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_ANNOUNCE_MS * 3);
    });
    expect(backups.restarts.count).toBe(1);
  });

  it('critère 13 : un échec de sauvegarde quotidienne s’affiche en rouge « Dernière sauvegarde échouée » AVEC LE CODE dans la ligne de Réglages', async () => {
    backups.versions.length = 0;
    backups.failNext('daily', 'io');
    render(
      <AppContainerProvider container={container}>
        <BackupRow />
      </AppContainerProvider>,
    );
    await act(async () => {
      await backupStore.get(container).getState().runDaily();
    });
    const summary = await screen.findByTestId('backup-summary');
    expect(summary).toHaveTextContent('Dernière sauvegarde échouée');
    expect(summary).toHaveTextContent(/Code : io/);
  });
});
