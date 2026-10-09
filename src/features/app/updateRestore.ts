import { backupStamp } from '../../db/migrationBackup';
import type { Clock } from '../../domain/clock';
import { t } from '../../i18n';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import { tBackupRestore } from '../../i18n/backupRestoreText';
import { backupFailureOf, type BackupFailureReason, type BackupService } from '../../platform/backup';
import { openStartupRecovery } from '../../platform/backup/recovery';
import { logFailure } from '../../platform/desktop/log';
import { detectOs, detectRuntime } from '../../platform/runtime';
import { writeMarkerFailed, writeRestoreResult } from '../settings/restoreMemo';

/**
 * I-06 (ADR 0007 avenant I-06 point 7) : « Restaurer la sauvegarde d'avant la mise à jour » depuis l'écran d'échec du démarrage. Chargé à
 * la demande (bundle de départ) au premier appui. La base est fermée (échec de migration) : mêmes commandes que P-04 / P-04-iOS
 * (`openStartupRecovery`), copie de sécurité de la base actuelle faite par Rust avant l'échange, puis relance (PC) ou rechargement
 * (iPhone). L'issue est mémorisée comme une restauration P-04 (message après le redémarrage, marqueur de synchro non écrit gardé).
 * Ne rejette jamais : un échec rend le texte de P-04 et le code, l'écran reste.
 */
export type UpdateRestoreOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly code: BackupFailureReason };

const REASON_KEYS = {
  corrupt: 'backup.errorCorrupt',
  'newer-schema': 'backup.errorNewer',
  'not-found': 'backup.errorNotFound',
  io: 'backup.errorIo',
  'rollback-failed': 'backup.errorRollback',
  'restore-pending': 'backup.errorPending',
  unavailable: 'backup.errorIo',
} as const;

/** Raison P-04 d'un échec de restauration (base fermée : `io` après la fermeture = redémarrer). */
export function updateRestoreFailureText(reason: BackupFailureReason, databaseClosed: boolean): string {
  if (reason === 'sync-busy') return tBackupRestore('errorSyncBusy');
  if (reason === 'busy') return tBackupRestore('errorBusy');
  if (reason === 'db-open') return tBackupRestore('errorDbOpen');
  if (databaseClosed && reason === 'io') return t('backup.errorClosed');
  return t(REASON_KEYS[reason]);
}

/** Service de la plateforme courante, null si aucune restauration n'est possible ici (navigateur de développement). */
export function startupRecoveryService(): BackupService | null {
  return openStartupRecovery(detectRuntime(), detectOs());
}

export async function restoreUpdateBackup(name: string, clock: Clock, service: BackupService | null = startupRecoveryService()): Promise<UpdateRestoreOutcome> {
  if (!service) return { ok: false, message: tUpdateRestore('restoreUnavailable'), code: 'unavailable' };
  try {
    const result = await service.restore({ name, stamp: backupStamp(clock) });
    const marker = result?.marker ?? 'not-configured';
    const markerCode = result?.markerCode ?? null;
    if (marker === 'failed') {
      logFailure('backup', `restore-marker-failed ${markerCode ?? 'unknown'}`);
      writeMarkerFailed({ backup: name, code: markerCode ?? 'unknown', at: new Date(clock.nowMs()).toISOString() });
    }
    if (!writeRestoreResult({ outcome: 'done', reason: null, databaseClosed: false, marker, markerCode })) logFailure('backup', 'restore-memo-unwritable');
    logFailure('backup', 'update-restore-done');
    await service.restart();
    return { ok: true };
  } catch (error) {
    const { reason, databaseClosed } = backupFailureOf(error);
    logFailure('backup-restore', `update-restore-failed ${reason}`);
    return { ok: false, message: updateRestoreFailureText(reason, databaseClosed), code: reason };
  }
}
