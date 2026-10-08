import type { OsFamily, Runtime } from '../runtime';
import { createFakeAuthenticator, type FakeAuthenticator } from './fake';
import { guardAuthenticator, type RawAuthenticator } from './guard';
import { authFailure, UNAVAILABLE_STATUS, type AppAuthenticator } from './types';

export * from './types';
export { createFakeAuthenticator, FACE_ID_STATUS, type FakeAuthCall, type FakeAuthenticator } from './fake';
export { guardAuthenticator, type RawAuthenticator } from './guard';

/** Implémentation vide (PC, navigateur) : non prise en charge, toute authentification rend `unavailable`. */
export function createUnavailableAuthenticator(): AppAuthenticator {
  return {
    supported: false,
    status: () => Promise.resolve(UNAVAILABLE_STATUS),
    authenticate: () => Promise.resolve(authFailure('unavailable')),
  };
}

/**
 * Résolveur (ADR 0013 §0) : l'adaptateur réel pour (`tauri`, `ios`) seulement, chargé à la demande ; vide partout ailleurs.
 *
 * En développement seulement (`import.meta.env.DEV`, absent d'un build) : `globalThis.__ctBiometric` (implémentation brute injectée) ou
 * `globalThis.__ctBiometricFake = true` (le faux testé, exposé ensuite en `globalThis.__ctBiometric` pour que le test le pilote).
 */
export function openAuthenticator(runtime: Runtime, os: OsFamily, deps: { readonly log: (code: string) => void }): AppAuthenticator {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctBiometric?: RawAuthenticator | FakeAuthenticator; __ctBiometricFake?: boolean };
    if (!scope.__ctBiometric && scope.__ctBiometricFake === true) scope.__ctBiometric = createFakeAuthenticator();
    if (scope.__ctBiometric) return guardAuthenticator(scope.__ctBiometric, deps.log);
  }
  if (runtime === 'tauri' && os === 'ios') {
    let loaded: Promise<RawAuthenticator> | null = null;
    const real = (): Promise<RawAuthenticator> => {
      loaded ??= import('./tauriBiometric').then((module) => module.createTauriAuthenticator()).catch((error: unknown) => {
        loaded = null;
        throw error;
      });
      return loaded;
    };
    // Chargement impossible : `unavailable` (visible sur l'écran de verrou), jamais un déverrouillage.
    return guardAuthenticator(
      {
        supported: true,
        status: () => real().then((raw) => raw.status(), () => UNAVAILABLE_STATUS),
        authenticate: (reason, cancelLabel) => real().then((raw) => raw.authenticate(reason, cancelLabel), () => authFailure('unavailable')),
      },
      deps.log,
    );
  }
  return createUnavailableAuthenticator();
}
