import type { syncForgetFr } from './fr.syncForget';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.forget` texts (Y-10), English. Same shape as `fr.syncForget.ts`. */
export const syncForgetEn: Shape<typeof syncForgetFr> = {};
