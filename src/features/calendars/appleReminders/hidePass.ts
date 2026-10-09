import type { AppContainer } from '../../app/container';

/**
 * Passage des Rappels Apple au masquage de l'iPhone, attendu par le cycle de synchro (ADR 0008 §10.8 : lecture, écritures, PUIS cycle : ce que le
 * passage vient de changer est publié dans le même masquage). Le coordinateur dédouble les demandes `hide` (l'écouteur de visibilité de
 * `startReminders` et celui-ci partagent le même passage). Sans Rappels (PC, plugin absent) : rien à attendre, aucun chargement.
 */
export async function remindersHidePass(container: AppContainer): Promise<void> {
  if (!container.reminders.available) return;
  const { getRemindersRunner } = await import('./remindersRunner');
  await getRemindersRunner(container).request('hide');
}
