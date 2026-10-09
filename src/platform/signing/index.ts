import type { OsFamily, Runtime } from '../runtime';
import { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from './fake';
import type { SigningAlert, SigningPlatform, SigningRead, SigningSource } from './types';

export * from './types';
export { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from './fake';

/** Implémentation vide (PC, navigateur) : non prise en charge, aucune lecture, aucune alerte. */
export function createUnsupportedSigning(): SigningPlatform {
  const unavailable: SigningRead = { ok: false, code: 'unavailable' };
  return {
    source: { supported: false, read: () => Promise.resolve(unavailable) },
    alert: { schedule: () => Promise.resolve(), cancel: () => Promise.resolve(), isPending: () => Promise.resolve(false) },
  };
}

/**
 * Résolveur (ADR 0013 §3.2) : les adaptateurs réels pour (`tauri`, `ios`) seulement, chargés à la demande ; vide ailleurs. En développement
 * seulement : `globalThis.__ctSigning` (`{ source, alert }` injectés) ou `globalThis.__ctSigningFake = true` (les faux, exposés ensuite en
 * `globalThis.__ctSigning`).
 */
export function openSigning(runtime: Runtime, os: OsFamily): SigningPlatform {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctSigning?: SigningPlatform | { source: FakeSigningSource; alert: FakeSigningAlert }; __ctSigningFake?: boolean };
    if (!scope.__ctSigning && scope.__ctSigningFake === true) scope.__ctSigning = { source: createFakeSigningSource(), alert: createFakeSigningAlert() };
    if (scope.__ctSigning) return scope.__ctSigning;
  }
  if (runtime === 'tauri' && os === 'ios') {
    let loaded: Promise<SigningSource> | null = null;
    const real = (): Promise<SigningSource> => {
      loaded ??= import('./tauriSigning').then((module) => module.createTauriSigningSource());
      loaded.catch(() => {
        loaded = null;
      });
      return loaded;
    };
    const source: SigningSource = { supported: true, read: () => real().then((adapter) => adapter.read(), () => ({ ok: false, code: 'unavailable' }) as const) };
    let alertLoaded: Promise<SigningAlert> | null = null;
    const alertReal = (): Promise<SigningAlert> => {
      alertLoaded ??= Promise.all([import('./tauriSigningAlert'), import('../notifications/tauriNotifications')]).then(([alert, notifications]) => alert.createTauriSigningAlert(notifications.createIosNotificationBridge()));
      alertLoaded.catch(() => {
        alertLoaded = null;
      });
      return alertLoaded;
    };
    const alert: SigningAlert = {
      schedule: (request) => alertReal().then((adapter) => adapter.schedule(request)),
      cancel: () => alertReal().then((adapter) => adapter.cancel()),
      isPending: () => alertReal().then((adapter) => adapter.isPending()),
    };
    return { source, alert };
  }
  return createUnsupportedSigning();
}
