import { logFailure } from '../../platform/desktop/log';
import type { AppContainer } from '../app/container';
import { getNotificationRunner } from './notificationRunner';
import { withExcursion } from '../security/excursion';

/**
 * Demande l'autorisation, sur un GESTE de l'utilisateur seulement (bouton « Autoriser » du bandeau ou de Réglages > Rappels), puis lance un
 * passage `permission` (N-01 critère 11). Jamais appelée au démarrage. Un refus ou une erreur est relu par le passage : l'état visible suit.
 */
export async function requestPermissionOnGesture(container: AppContainer): Promise<void> {
  try {
    // I-03 : fenêtre d'autorisation d'iOS = excursion (aucun reverrouillage à son retour).
    await withExcursion('permission', () => container.notifications.requestPermission());
  } catch {
    logFailure('notifications', 'request-permission-failed');
  }
  await getNotificationRunner(container).request('permission');
}
