import type { syncPairingFr } from './fr.syncPairing';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.pairing` texts (Y-06), English. Same shape as `fr.syncPairing.ts`. */
export const syncPairingEn: Shape<typeof syncPairingFr> = {};
