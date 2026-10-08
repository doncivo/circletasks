import type { AppContainer } from '../app/container';

/**
 * Réveil du plugin d'actions (N-03, avenant N3.5) : module volontairement minuscule, chargé statiquement par l'intégration (le cas
 * d'usage des actions, lui, n'est chargé qu'à la demande, sur l'iPhone : bundle de départ).
 */
export interface Wake {
  readonly handler: () => void;
  stop: (() => void) | null;
}

export const wakes = new WeakMap<AppContainer, Wake>();

/** Demande un passage `action` quand le plugin écrit une ligne (course entre `didReceive` et le `drain` de la reprise). */
export function setActionWakeHandler(container: AppContainer, handler: () => void): () => void {
  const wake: Wake = { handler, stop: null };
  wakes.set(container, wake);
  return () => {
    wake.stop?.();
    wake.stop = null;
    if (wakes.get(container) === wake) wakes.delete(container);
  };
}
