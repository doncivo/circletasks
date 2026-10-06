import type { syncForgetFr } from './fr.syncForget';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.forget` texts (Y-10), English. Same shape as `fr.syncForget.ts`. */
export const syncForgetEn: Shape<typeof syncForgetFr> = {
  action: 'Forget this device',
  actionLabel: 'Forget {device}',
  dialogTitle: 'Forget {device}?',
  dialogBody:
    '{device} will no longer be read beyond a point shared by all your devices, and its files will be deleted from iCloud (recoverable for 30 days in iCloud “Recently Deleted”). Forgetting cannot be undone: the device will have to be paired again. {device} keeps its copy of the data and its key: only “Reset sync” cuts its access to future data.',
  continue: 'Continue',
  pending: 'Forgetting {device}…',
  cancelled: 'Forgetting cancelled',
  done: '{device} is forgotten',
  deletionWaiting: 'Forgotten · file deletion waiting for {device}',
  deletionWaitingUnknown: 'Forgotten · file deletion pending',
  deletionRunning: 'Forgotten · deleting files',
  deletionStrays: 'Forgotten · unrecognized files remain in iCloud',
  section: 'FORGOTTEN DEVICE',
  failedDeclare: 'Forgetting {device} failed: {reason}',
  failedDelete: 'Deleting the files of {device} failed: {reason}',
  failedRejoin: 'Pairing this device again failed: {reason}',
  failedAt: 'Last attempt: {time}',
  retry: 'Retry',
  retryDeclareLabel: 'Retry forgetting {device}',
  retrySyncLabel: 'Retry now',
  reasons: {
    notForeground: 'CircleTasks was not in the foreground',
    rateLimited: 'too many requests, try again in 10 minutes',
    cloudPending: 'a file is still waiting for iCloud',
    folderUnreachable: 'sync folder not found',
    vaultUnavailable: 'system vault unavailable',
    keyMissing: 'sync key missing',
    stateMismatch: 'the devices are not up to date yet',
    notConfigured: 'sync not set up',
    other: 'unexpected error',
  },
  selfForgotten: 'This device was forgotten: pair it again',
  selfForgottenDetail: 'Another device forgot it. Your data stays on this device: it will be merged and published under a new identifier.',
  rejoin: 'Pair again',
  rejoinLabel: 'Pair this device again',
  rejoinTitle: 'Pair this device again?',
  rejoinBody:
    'The folder is unlinked (the key is kept), this device gets a new identifier, then the app restarts; then choose the CircleTasks folder again. Nothing is erased: your data is merged then published.',
  rejoinRunning: 'Pairing…',
  banner: 'This device was forgotten: pair it again',
  bannerPending: '{device} forgotten: deletion of its files waiting for {waiting}',
  bannerPendingUnknown: '{device} forgotten: deletion of its files pending',
  bannerRunning: '{device} forgotten: deleting its files',
  bannerStrays: '{device} forgotten: unrecognized files remain in iCloud',
};
