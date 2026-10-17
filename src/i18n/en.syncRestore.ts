import type { syncRestoreFr } from './fr.syncRestore';

/** Restore choice window (same keys as `fr.syncRestore.ts`). */
export const syncRestoreEn: Record<keyof typeof syncRestoreFr, string> = {
  title: 'Restore: what about sync?',
  body: 'The changes this device had already received will be replaced on all your devices',
  applyEverywhere: 'Apply this version to all my devices',
  keepSynced: 'Keep the synced data',
  bodyOnlyApply:
    'The changes this device had already received will be replaced on all your devices. A deletion more recent than this backup has already been permanently erased from your devices: only the first option is possible.',
  later: 'Later',
  resetInProgress: 'A synchronization reset is in progress: this version can only be applied everywhere once it is finished.',
  resetFinish: 'A synchronization reset is in progress and a deletion more recent than this backup has already been permanently erased: finish it on the device that is resetting.',
  failed: 'The choice could not be applied ({reason}). Nothing was changed: you can try again.',
  failedReset: 'The choice was not applied: a synchronization reset is in progress. Nothing was changed.',
  scanFailed: 'The sync folder could not be checked: “Apply this version on all my devices” will be offered once it can be reached.',
  provisional: 'The restore could not be confirmed yet, so “Apply this version on all my devices” is not offered. CircleTasks checks again at the next start: close and reopen it.',
  provisionalNoOption: 'The restore could not be confirmed yet. CircleTasks checks again at the next start: close and reopen it.',
  scanFailedNoOption: 'The sync folder could not be checked: try again once it can be reached.',
  backupWarning: 'This device is paired: you will be asked at the next sync',
};
