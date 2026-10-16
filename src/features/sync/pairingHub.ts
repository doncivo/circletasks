import type { JoinFailureFact } from '../../domain/syncBanners';
import type { AppContainer } from '../app/container';
import { JOIN_META } from '../../sync';

/**
 * Partie de l'état d'association chargée au départ (abonnés, accès à `sync_meta`, arrivée en échec du bandeau A-09) : importée par
 * `startSync.ts` et `keyPresence.ts`. Le reste (`pairingStatus.ts` : ouverture de la fenêtre `pairing`, relance pendant l'affichage, arrivée)
 * n'est chargé qu'avec les écrans de synchro ou par `desktop.ts` à la demande (Y-IOS-02-FIX-02 : taille du bundle de départ). Un seul jeu
 * d'abonnés par conteneur, partagé par les deux modules.
 */

export interface JoinView {
  readonly done: number;
  readonly total: number;
  readonly failure: string | null;
}

/** Lecture ou écriture de `sync_meta` en échec (aucun échec silencieux) : vrai jusqu'au prochain accès réussi. */
export function storageResult(container: AppContainer, failed: boolean): void {
  const hub = hubOf(container);
  if (hub.storageFailed === failed) return;
  hub.storageFailed = failed;
  notify(container);
}

export function pairingStorageFailed(container: AppContainer): boolean {
  return hubOf(container).storageFailed;
}

/** Lecture de `sync_meta` : valeur analysée et `readable` faux si la base n'a pas répondu (signalé par `storageResult`). */
export async function readMetaResult(container: AppContainer, key: string): Promise<{ readonly value: unknown; readonly readable: boolean }> {
  let raw: string | null;
  try {
    raw = await container.data.repos.sync.getMeta(key);
  } catch {
    storageResult(container, true);
    return { value: null, readable: false };
  }
  storageResult(container, false);
  if (raw === null) return { value: null, readable: true };
  try {
    return { value: JSON.parse(raw) as unknown, readable: true };
  } catch {
    // Valeur illisible (écrite par une version plus ancienne ?) : traitée comme absente, jamais comme une panne de la base.
    return { value: null, readable: true };
  }
}

export function parseJoinView(value: unknown): JoinView | null {
  if (typeof value !== 'object' || value === null) return null;
  const { done, total, failure } = value as Record<string, unknown>;
  if (typeof done !== 'number' || typeof total !== 'number') return null;
  return { done, total, failure: typeof failure === 'string' ? failure : null };
}

/**
 * Arrivée en échec pour le bandeau A-09 (critère 9 f) : même lecture et même analyse que `JoinProgress` (une seule source, revue 6) ;
 * `readable` faux si la base n'a pas répondu (l'appelant garde alors l'état précédent et signale la lecture en échec).
 */
export async function readJoinFailure(container: AppContainer): Promise<{ readonly failure: JoinFailureFact | null; readonly readable: boolean }> {
  const { value, readable } = await readMetaResult(container, JOIN_META);
  const view = parseJoinView(value);
  return { failure: view?.failure ? { done: view.done, total: view.total, failure: view.failure } : null, readable };
}

export interface PairingHub {
  readonly listeners: Set<(event: PairingEvent) => void>;
  stopWatch: (() => void) | null;
  storageFailed: boolean;
}

const hubs = new WeakMap<AppContainer, PairingHub>();

export function hubOf(container: AppContainer): PairingHub {
  let hub = hubs.get(container);
  if (!hub) {
    hub = { listeners: new Set(), stopWatch: null, storageFailed: false };
    hubs.set(container, hub);
  }
  return hub;
}

/** `changed` : échec gardé ou effacé ; `paired` : appareil associé (`sync-paired`) ; `paired-sync-failed` : associé, mais le cycle qui suit a échoué. */
export type PairingEvent = 'changed' | 'paired' | 'paired-sync-failed';

/** Changement de l'état d'association ; renvoie le désabonnement. */
export function onPairingChange(container: AppContainer, listener: (event: PairingEvent) => void): () => void {
  const hub = hubOf(container);
  hub.listeners.add(listener);
  return () => hub.listeners.delete(listener);
}

export function notify(container: AppContainer, event: PairingEvent = 'changed'): void {
  for (const listener of hubOf(container).listeners) listener(event);
}
