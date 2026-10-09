import { RemindersError, type RemindersPlatform } from './types';

/**
 * Rappels Apple indisponibles (PC et navigateur de développement, ADR 0008 §10.4) : aucun appel de plugin, aucune permission. Sous
 * Windows les Rappels n'arrivent que par la synchro d'iCloud Drive (K-07). Toute méthode rejette `store-unavailable` ; `status` rend
 * `denied` sans rien appeler, pour que l'écran puisse l'afficher sans cas particulier.
 */
export function createUnavailableReminders(): RemindersPlatform {
  const unavailable = (): Promise<never> => Promise.reject(new RemindersError('store-unavailable'));
  return {
    available: false,
    status: () => Promise.resolve('denied'),
    requestAccess: unavailable,
    lists: unavailable,
    fetch: unavailable,
    upsert: unavailable,
    setCompleted: unavailable,
    delete: unavailable,
    onChanged: () => Promise.resolve(() => undefined),
  };
}
