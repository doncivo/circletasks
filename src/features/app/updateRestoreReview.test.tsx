import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import type { BackupFailureReason } from '../../platform/backup';
import { openStartupRecovery, type StartupRecoveryApi } from '../../platform/backup/recovery';
import { createMemorySyncPlatform } from '../../platform/sync/memory';
import { createSyncService } from '../../sync';
import { silentSyncLogger } from '../../sync/log';
import { UpdateRestoreAction } from './UpdateRestoreAction';
import { restoreUpdateBackup, updateRestoreFailureText } from './updateRestore';

/**
 * Revue I-06 : B1 (raison `restore-unconfirmed`), I2 (restauration d'avant la mise à jour = retour arrière local, aucun marqueur de synchro,
 * jamais la fenêtre de choix), I3 (relance hors de la restauration, consigne visible si elle échoue), M6 (aucune entrée de « réussite » dans
 * l'entonnoir des échecs : l'issue est dite après le redémarrage).
 */

const BACKUP = 'circletasks-pre-migration-v0018-to-v0019-20261009T080000Z.db';
const clock = createManualClock('2026-10-09T08:00:00.000Z');
const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fc');

function api(options: { relaunchFails?: boolean } = {}): StartupRecoveryApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rollback: (name, stamp) => {
      calls.push(`rollback ${name} ${stamp}`);
      return Promise.resolve({ marker: 'skipped', markerCode: null });
    },
    relaunch: () => {
      calls.push('relaunch');
      return options.relaunchFails ? Promise.reject(new Error('relance refusée')) : Promise.resolve();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('B1 : restore-unconfirmed', () => {
  it('texte de P-04 « restauration précédente pas encore confirmée », jamais une clé brute', () => {
    const reason: BackupFailureReason = 'restore-unconfirmed';
    expect(updateRestoreFailureText(reason, false)).toBe(t('backup.errorUnconfirmed'));
    expect(updateRestoreFailureText(reason, true)).toBe(t('backup.errorUnconfirmed'));
  });
});

describe('I2 : retour arrière local, aucun marqueur de synchro', () => {
  it('aucun marqueur écrit ni mémorisé ; la synchro ne passe pas en « choix après restauration »', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recovery = openStartupRecovery('tauri', 'windows', api());
    await expect(restoreUpdateBackup(BACKUP, clock, recovery)).resolves.toEqual({ ok: true });
    expect(localStorage.getItem('ct.restore.markerFailed')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ct.restore.result') ?? 'null')).toEqual({ outcome: 'done', reason: null, databaseClosed: false, marker: null, markerCode: null });
    // M6 : aucune « réussite » dans l'entonnoir des échecs (l'issue est annoncée après le redémarrage, entrée `restore-done`).
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).some((line) => line.includes('restore-done'))).toBe(false);

    // Après le redémarrage : le marqueur de la plateforme est absent (Rust n'en écrit aucun) -> fusion normale, jamais `restore-choice`.
    const db = await openTestDb(DEVICE, '2026-10-09T08:00:00.000Z');
    const platform = createMemorySyncPlatform();
    await platform.folder.choose();
    await platform.key.create();
    const service = createSyncService({ data: db.data, platform, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), clock: db.clock, deviceId: DEVICE, sv: 18, appVersion: '0.3.0', logger: silentSyncLogger, setTimeout: () => 0, clearTimeout: () => undefined });
    await service.syncNow('manual');
    expect(await platform.restoreMarker.get()).toBeNull();
    expect(service.status().phase).not.toBe('restore-choice');
    await db.close();
  });
});

describe('I3 : relance hors de la restauration', () => {
  it('relance impossible : restauration réussie, consigne « Relancez CircleTasks » visible, action retirée', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recovery = openStartupRecovery('tauri', 'windows', api({ relaunchFails: true }));
    const outcome = await restoreUpdateBackup(BACKUP, clock, recovery);
    expect(outcome).toEqual({ ok: true, restartFailed: true });
    expect(JSON.parse(localStorage.getItem('ct.restore.result') ?? 'null')).toMatchObject({ outcome: 'done' });

    render(<UpdateRestoreAction name={BACKUP} restore={() => Promise.resolve(outcome)} />);
    fireEvent.click(screen.getByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(tUpdateRestore('restartManually'));
    expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
  });

  it('relance réussie : issue simple (ok), aucune consigne', async () => {
    const calls = api();
    await expect(restoreUpdateBackup(BACKUP, clock, openStartupRecovery('tauri', 'windows', calls))).resolves.toEqual({ ok: true });
    expect(calls.calls).toEqual([`rollback ${BACKUP} 20261009T080000Z`, 'relaunch']);
  });
});
