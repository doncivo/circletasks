import type { syncVersionFr } from './fr.syncVersion';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.version` texts (Y-07), English. Same shape as `fr.syncVersion.ts`. */
export const syncVersionEn: Shape<typeof syncVersionFr> = {};
