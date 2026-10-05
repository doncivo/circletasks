import type { syncConflictsFr } from './fr.syncConflicts';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.conflicts` texts (Y-04), English. Same shape as `fr.syncConflicts.ts`. */
export const syncConflictsEn: Shape<typeof syncConflictsFr> = {};
