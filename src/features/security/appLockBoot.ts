import type { AppContainer } from '../app/container';
import { useAppLockStore } from './appLockStore';
import { applyLockToDocument } from './lockLayer';

/**
 * Démarrage du verrou (I-03) appelé par App.tsx avant le premier rendu de la coquille. Hors iPhone (authentification non prise en charge) :
 * déverrouillé tout de suite, sans charger le contrôleur (bundle de départ, PERF-02). Sur l'iPhone : contrôleur chargé à la demande ;
 * chargement impossible → verrouillé avec un message (échec fermé), coquille jamais montée.
 */
export async function bootAppLock(container: AppContainer): Promise<{ dispose(): void }> {
  if (!container.authenticator.supported) {
    useAppLockStore.setState({ phase: 'unlocked', enabled: false, shellReady: true });
    return { dispose: () => undefined };
  }
  try {
    const { startAppLockFor } = await import('./startAppLock');
    const controller = startAppLockFor(container);
    await controller.ready;
    return controller;
  } catch {
    // Échec fermé : le contenu de body est masqué par le module léger de la couche (importé directement, jamais à la demande).
    applyLockToDocument(document, true);
    useAppLockStore.setState({ phase: 'locked', enabled: true, shellReady: false, message: { kind: 'plugin', code: 'unavailable' } });
    return { dispose: () => undefined };
  }
}
