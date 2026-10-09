import { pluginDate } from '../../domain/notificationInstant';
import type { IosNotificationBridge } from '../notifications/tauriNotifications';
import { NotificationSchedulerError } from '../notifications/types';
import type { SigningAlert } from './types';

/**
 * Alerte d'expiration sur l'iPhone (I-02, ADR 0013 §3.4) : même plugin que les rappels, par le pont de `tauriNotifications.ts`, mais
 * identifiant numérique RÉSERVÉ 2 (1 = fin de Focus) : ni `replace` ni `cancelAll` du plan n'y touchent, `reservedCount()` le compte dans
 * les 64. Sans catégorie ni action, texte neutre. Un rejet est typé (`NotificationSchedulerError`).
 */

/** Identifiant numérique de l'alerte d'expiration (plage réservée [1 ; 65 535]). */
export const SIGNING_ALERT_NUMERIC_ID = 2;

export function createTauriSigningAlert(bridge: IosNotificationBridge): SigningAlert {
  const typed = (error: unknown, fallback: 'schedule-failed' | 'verify-failed'): NotificationSchedulerError => (error instanceof NotificationSchedulerError ? error : new NotificationSchedulerError(fallback));
  return {
    async schedule(request) {
      try {
        await bridge.show({
          id: SIGNING_ALERT_NUMERIC_ID,
          title: request.title,
          body: request.body,
          sound: 'default',
          extra: { sid: 'signing' },
          // Constat 7 de l'ADR 0012 : la date est une heure murale du fuseau courant.
          schedule: { at: { date: pluginDate(request.instant, request.zone), repeating: false, allowWhileIdle: false } },
        });
      } catch (error) {
        throw typed(error, 'schedule-failed');
      }
    },
    async cancel() {
      try {
        await bridge.cancel([SIGNING_ALERT_NUMERIC_ID]);
      } catch (error) {
        throw typed(error, 'schedule-failed');
      }
    },
    async isPending() {
      try {
        return (await bridge.pending()).some((item) => item.id === SIGNING_ALERT_NUMERIC_ID);
      } catch (error) {
        throw typed(error, 'verify-failed');
      }
    },
  };
}
