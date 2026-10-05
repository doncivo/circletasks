import type { syncFieldFr } from './fr.syncField';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.field` texts (Y-04), English. Same shape as `fr.syncField.ts`. */
export const syncFieldEn: Shape<typeof syncFieldFr> = {};
