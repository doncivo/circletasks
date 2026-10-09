import type { appUpdateRestoreFr } from './fr.appUpdateRestore';

/** Pre-update restore (I-06): English texts, same keys as fr.appUpdateRestore.ts. */
export const appUpdateRestoreEn: { readonly [K in keyof typeof appUpdateRestoreFr]: string } = {
  restore: 'Restore the pre-update backup',
  restoreConfirmTitle: 'Restore the pre-update backup?',
  restoreConfirmBody: 'Your data returns to its state before the update. This version will retry the update on the next start; if the error comes back, install the fixed version.',
  restoreConfirm: 'Restore',
  restoring: 'Restoring…',
  restoreUnavailable: 'Restoring is not available here: copy the details and install the fixed version.',
  restartManually: 'Data restored. Restart CircleTasks: close the app, then open it again.',
  restoreFailed: 'The restore did not complete. {reason}',
};
