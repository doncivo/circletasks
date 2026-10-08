import type { OsFamily, Runtime } from '../runtime';
import { createFakeHaptics, type FakeHaptics } from './fake';
import type { Haptics } from './types';

export * from './types';
export { createFakeHaptics, type FakeHaptics, type FakeHapticsCall } from './fake';

/** Implémentation vide (PC, navigateur) : ne fait rien, ne lève rien. */
export function createNoopHaptics(): Haptics {
  return { impact: () => undefined, notification: () => undefined, selection: () => undefined };
}

/**
 * Résolveur (ADR 0013 §1.2) : l'adaptateur réel pour (`tauri`, `ios`) seulement, chargé à la demande (les appels faits avant le chargement
 * sont perdus : cosmétique) ; vide partout ailleurs. En développement seulement : `globalThis.__ctHaptics` (injecté) ou
 * `globalThis.__ctHapticsFake = true` (le faux, exposé ensuite en `globalThis.__ctHaptics`).
 */
export function openHaptics(runtime: Runtime, os: OsFamily, deps: { readonly log: (code: string) => void }): Haptics {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctHaptics?: Haptics | FakeHaptics; __ctHapticsFake?: boolean };
    if (!scope.__ctHaptics && scope.__ctHapticsFake === true) scope.__ctHaptics = createFakeHaptics();
    if (scope.__ctHaptics) return scope.__ctHaptics;
  }
  if (runtime === 'tauri' && os === 'ios') {
    let real: Haptics | null = null;
    let loading = false;
    const load = (): void => {
      if (real || loading) return;
      loading = true;
      import('./tauriHaptics').then(
        (module) => {
          real = module.createTauriHaptics(deps.log);
        },
        () => {
          loading = false;
          deps.log('haptics-failed:load');
        },
      );
    };
    load();
    return {
      impact: (style) => (real ? real.impact(style) : load()),
      notification: (kind) => (real ? real.notification(kind) : load()),
      selection: () => (real ? real.selection() : load()),
    };
  }
  return createNoopHaptics();
}
