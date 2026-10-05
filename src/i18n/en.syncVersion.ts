import type { syncVersionFr } from './fr.syncVersion';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.version` texts (Y-07), English. Same shape as `fr.syncVersion.ts`. */
export const syncVersionEn: Shape<typeof syncVersionFr> = {
  banner: 'Update the app: one of your devices uses a newer version',
  section: 'VERSION',
  newer: '{device} uses a newer version of the app',
  newerWithVersion: '{device} uses a newer version of the app ({version})',
  readSuspended: 'Reading its data is paused: update the app',
};
