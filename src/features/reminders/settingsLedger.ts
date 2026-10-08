import type { SettingsRepository } from '../../db/repositories';
import { parseNotificationLedger } from '../../domain/notificationLedger';
import type { NotificationLedger } from '../../platform/notifications';

/**
 * Registre local des notifications (N-01) dans le réglage LOCAL `notifications.ledger` : jamais dans les journaux de synchro, aucun titre.
 * Une valeur illisible (JSON invalide, version inconnue, champ faux) est lue `unreadable` : l'adaptateur replanifie alors tout une fois.
 */
export function createSettingsLedger(settings: Pick<SettingsRepository, 'get' | 'set'>): NotificationLedger {
  return {
    load: async () => {
      try {
        return parseNotificationLedger(await settings.get('notifications.ledger'));
      } catch {
        return { state: 'unreadable' };
      }
    },
    save: (ledger) => settings.set('notifications.ledger', ledger),
  };
}
