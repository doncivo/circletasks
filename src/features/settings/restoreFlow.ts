import { BackupError, backupFailureOf, type BackupFailureReason, type BackupService, type BackupVersion, type RestoreResult } from '../../platform/backup';
import { logFailure } from '../../platform/desktop/log';
import type { AppContainer } from '../app/container';
import { writeMarkerFailed, writeRestoreResult } from './restoreMemo';
import { quiesceForRestore, type QuiesceHandle } from './restoreQuiesce';

export type RestoreFlowOutcome =
  | { readonly kind: 'failed'; readonly reason: BackupFailureReason; readonly databaseClosed: boolean }
  | { readonly kind: 'done'; readonly markerFailure: string | null };

/**
 * Restauration (P-04, P-04-iOS critère 6), chargée à la demande (bundle de départ) : vérification (base ouverte) -> mise au calme -> voile
 * (phase `running` posée par l'appelant) -> point de contrôle -> fermeture -> échange -> mémo de l'issue. Base encore ouverte en cas
 * d'échec : la synchro et les rappels reprennent ; base fermée : l'issue est mémorisée pour être dite APRÈS le redémarrage (critère 7).
 * Marqueur de la synchro non écrit : mémo gardé jusqu'à résolution (critère 12). Ne rejette jamais.
 */
export async function performRestore(container: AppContainer, service: BackupService, version: BackupVersion, stamp: string): Promise<RestoreFlowOutcome> {
  let quiet: QuiesceHandle | null = null;
  let result: RestoreResult | undefined;
  try {
    result = await service.restore(
      { name: version.name, stamp },
      {
        prepare: async () => {
          const outcome = await quiesceForRestore(container);
          if (outcome === 'sync-busy' || outcome === 'busy') throw new BackupError(outcome);
          quiet = outcome;
        },
      },
    );
  } catch (error) {
    logFailure('backup-restore', error);
    const { reason, databaseClosed } = backupFailureOf(error);
    if (!databaseClosed) (quiet as QuiesceHandle | null)?.release();
    else writeRestoreResult({ outcome: 'failed', reason, databaseClosed: true, marker: null, markerCode: null });
    return { kind: 'failed', reason, databaseClosed };
  }
  const marker = result?.marker ?? 'not-configured';
  const markerCode = result?.markerCode ?? null;
  if (marker === 'failed') {
    logFailure('backup', `restore-marker-failed ${markerCode ?? 'unknown'}`);
    writeMarkerFailed({ backup: version.name, code: markerCode ?? 'unknown', at: new Date(container.clock.nowMs()).toISOString() });
  }
  if (!writeRestoreResult({ outcome: 'done', reason: null, databaseClosed: false, marker, markerCode })) logFailure('backup', 'restore-memo-unwritable');
  return { kind: 'done', markerFailure: marker === 'failed' ? (markerCode ?? 'unknown') : null };
}
