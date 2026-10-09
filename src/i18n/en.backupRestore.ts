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
};
