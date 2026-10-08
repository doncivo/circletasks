import type { syncFolderFr, syncKeyFr } from './fr.syncFolder';

type Shape<T> = { readonly [K in keyof T]: string };

/** Settings › Sync texts (Y-01, Y-08), English. Same shape as `fr.syncFolder.ts`. */
export const syncFolderEn: Shape<typeof syncFolderFr> = {
  sectionTitle: 'SYNC',
  rowLabel: 'Sync folder',
  icloudLabel: 'iCloud Drive / {name}',
  notConfigured: 'Not set up',
  choose: 'Choose folder',
  chooseLabel: 'Choose folder for synchronization',
  choosing: 'Choosing folder…',
  chosen: 'Folder chosen',
  notIcloud: 'This folder is not in iCloud Drive: your devices will not share it',
  forget: 'Forget',
  forgetLabel: 'Forget the sync folder',
  forgetTitle: 'Forget the sync folder?',
  forgetDescription:
    'This device will stop syncing; its data stays on the device. Uninstalling the app does not erase the sync key: choose “Forget folder and key” before uninstalling.',
  forgetFolder: 'Forget folder',
  forgetFolderAndKey: 'Forget folder and key',
  errorUnsafe: 'This folder cannot be used for sync',
  errorUnreachable: 'The sync folder cannot be found',
  errorUnreachableIos: 'iCloud Drive folder unreachable: choose the iCloud Drive / CircleTasks folder again',
  errorTooLarge: 'The sync folder is too large',
  errorProviderStopped: 'Open iCloud for Windows',
  errorVault: 'The Windows credential vault is unavailable',
  errorDenied: 'Action cancelled',
  errorRateLimited: 'Too many attempts: try again in a few minutes',
  errorGeneric: 'Sync ran into an error',
};

export const syncKeyEn: Shape<typeof syncKeyFr> = {
  needsPairing: 'This folder already contains encrypted data: pair this device',
  mismatch: 'This folder was encrypted with another key: pair this device',
};
