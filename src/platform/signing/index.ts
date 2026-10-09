import type { SigningPlatform, SigningRead } from './types';

export * from './types';

/** Implémentation vide (PC, navigateur) : non prise en charge, aucune lecture, aucune alerte. */
export function createUnsupportedSigning(): SigningPlatform {
  const unavailable: SigningRead = { ok: false, code: 'unavailable' };
  return {
    source: { supported: false, read: () => Promise.resolve(unavailable) },
    alert: { schedule: () => Promise.resolve(), cancel: () => Promise.resolve(), isPending: () => Promise.resolve(false) },
  };
}
export { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from './fake';
