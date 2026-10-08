import type { AppContainer } from '../app/container';
import { useAppLockStore } from './appLockStore';

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
    useAppLockStore.setState({ phase: 'locked', enabled: true, shellReady: false, message: { kind: 'plugin', code: 'unavailable' } });
    document.documentElement.dataset['appLock'] = 'locked';
    return { dispose: () => undefined };
  }
}
