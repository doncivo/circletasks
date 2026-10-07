import type { RemoteChanges } from '../../platform/sync/types';
import type { AppContainer } from '../app/container';

/**
 * Y-TECH-02 (seconde revue, point 1) : relance des rechargements d'écran en échec, posée par l'intégration (`startSync.ts`) et appelée
 * par « Synchroniser maintenant » (`syncStore.ts`) sans dépendance circulaire entre les deux.
 */
const retries = new WeakMap<AppContainer, () => Promise<void>>();

export function setReloadRetry(container: AppContainer, retry: (() => Promise<void>) | null): void {
  if (retry) retries.set(container, retry);
  else retries.delete(container);
}

/** Relance les rechargements en échec (aucun : rien). Ne rejette jamais. */
export function retryFailedReloads(container: AppContainer): Promise<void> {
  return retries.get(container)?.() ?? Promise.resolve();
}

/** Union de deux lots reçus (tables et identifiants). */
export function mergeChanges(a: RemoteChanges | null, b: RemoteChanges): RemoteChanges {
  if (!a) return b;
  const ids = new Map<string, Set<string>>();
  for (const source of [a, b]) for (const [table, set] of source.ids) ids.set(table, new Set([...(ids.get(table) ?? []), ...set]));
  return { tables: new Set([...a.tables, ...b.tables]), ids };
}
