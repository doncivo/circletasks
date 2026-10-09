import type { backupRestoreFr } from './fr.backupRestore';

export const backupRestoreEn: { readonly [K in keyof typeof backupRestoreFr]: string } = {
  folderIos: 'App folder (not visible in Files)',
  errorSyncBusy: 'A sync is in progress, try again. Nothing was changed.',
  errorBusy: 'Reminders are being updated, try again in a moment. Nothing was changed.',
  errorDbOpen: 'The database could not be closed for the restore. Nothing was changed: try again.',
  retry: 'Try again',
  seeSync: 'See sync',
  resumeSync: 'Resume sync',
  resumeSyncTitle: 'Resume sync?',
  resumeSyncText: 'Synced data may replace the restored version on this device.',
  recoveryConflict: 'Some files prevent your data from being put back. They can be set aside in the backups folder: nothing is deleted (kept for 30 days).',
  recoverySetAside: 'Set conflicting files aside',
  recoverySetAsideBusy: 'Setting files aside…',
  recoveryFreshBase: 'The previous database could not be put back: it is kept for 30 days in the backups folder, and a new database will be created. To get your data back, restore the “Before restore” copy from Settings > Automatic backup.',
  recoveryContinue: 'Continue',
  recoveryStillFailed: 'Recovery is still impossible: close and reopen CircleTasks. If the message comes back, copy the details.',
  recoveryNoDataDir: 'The app data folder cannot be found: close and reopen CircleTasks. Nothing was changed.',
  recoveryMarkerCancel: 'An interrupted restore could not be cancelled cleanly (the restore marker could not be written). Nothing was deleted: close and reopen CircleTasks to retry. Your data is untouched.',
  recoverySqlPlugin: 'The database module did not start: close and reopen CircleTasks. Your data is untouched.',
};
