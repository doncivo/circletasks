import type { AppContainer } from '../app/container';
import { clearMarkerFailedMemo } from '../settings/restoreMemoPeek';
import { markerFailures, schedulers } from './syncRestoreState';

/**
 * P-04-iOS (mise au calme avant une restauration, ADR 0009 avenant lot F B4) : plus aucun cycle lancé, cycle en cours attendu `timeoutMs`
 * au plus. Faux si le cycle n'a pas fini (le planificateur est alors relancé par `resumeSyncAfterRestore` de l'appelant).
 */
export async function pauseSyncForRestore(container: AppContainer, timeoutMs: number): Promise<boolean> {
  schedulers.get(container)?.pause();
  const running = container.sync?.running() ?? null;
  if (!running) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([running.then(() => true, () => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))]);
  if (timer !== undefined) clearTimeout(timer);
  return finished;
}

/** Reprise après une restauration refusée avant la fermeture de la base (ou après « Reprendre la synchronisation »). */
export function resumeSyncAfterRestore(container: AppContainer): void {
  if (markerFailures.has(container)) return;
  schedulers.get(container)?.resume();
}

/** Marqueur de restauration non écrit : code, ou null. */
export function restoreMarkerFailure(container: AppContainer): string | null {
  return markerFailures.get(container)?.code ?? null;
}

/**
 * « Reprendre la synchronisation » (P-04-iOS critère 12, choix explicite et confirmé dans Réglages › Synchronisation) : le mémo est
 * effacé, le bandeau retiré, les cycles reprennent (les données synchronisées pourront remplacer la version restaurée).
 */
/** Marqueur réécrit (revue I2) : même effet que la reprise, la synchro repart et la fenêtre de choix habituelle suit le marqueur. */
export function markerResolved(container: AppContainer): void {
  resumeSyncDespiteMarker(container);
}

export function resumeSyncDespiteMarker(container: AppContainer): void {
  const failure = markerFailures.get(container);
  clearMarkerFailedMemo();
  markerFailures.delete(container);
  failure?.refresh();
  schedulers.get(container)?.resume();
}

