import type { syncResetFr } from './fr.syncReset';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.reset` texts (Y-11), English. Same shape as `fr.syncReset.ts`. */
export const syncResetEn: Shape<typeof syncResetFr> = {};
