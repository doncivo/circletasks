import type { OsFamily, Runtime } from '../runtime';
import { createMemorySyncPlatform } from './memory';
import { createTauriSync } from './tauriSync';
import type { SyncPlatform } from './types';

export * from './types';
export { MemorySyncFolder, createMemorySyncPlatform, type MemorySyncOptions, type MemorySyncPlatform, type MemorySyncTesting, type StateFileCopy } from './memory';
export { createTauriSync, loadTauriSyncInvoker, toSyncError, type SyncInvoker, type TauriSyncOptions } from './tauriSync';

/**
 * Plateforme de synchronisation courante (ADR 0011, section 11 ; Y-01 critère 18) : app installée -> commandes Rust (`tauriSync`,
 * indisponible sur iPhone jusqu'à l'ordre 5) ; navigateur de développement, Vitest et Playwright -> implémentation mémoire. En
 * développement, un test de bout en bout peut poser `globalThis.__ctSync` (faux) avant le chargement de la page.
 */
export function openSyncPlatform(runtime: Runtime, os: OsFamily): SyncPlatform {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctSync?: SyncPlatform }).__ctSync;
    if (override) return override;
  }
  if (runtime === 'web') return createMemorySyncPlatform();
  return createTauriSync({ available: os === 'windows' });
}
