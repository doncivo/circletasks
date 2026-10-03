import type { DataAccess } from '../../db/repositories';

/**
 * Notification « les checklists ont changé » : émise après chaque écriture de checklist ou d'item (création, cochage, texte, ordre,
 * suppression, date, annulation). Aujourd'hui, la Semaine et l'onglet Checklists s'y abonnent pour se relire (C-03 critère 4) :
 * une annulation (T-13) écrit en base sans passer par l'écran qui affiche la checklist.
 *
 * Clé : le `DataAccess` du conteneur (un par conteneur, donc isolé en test), comme `routineEvents`.
 */
const listeners = new WeakMap<DataAccess, Set<() => void>>();

/** S'abonne aux changements de checklists ; renvoie la fonction de désabonnement. */
export function onChecklistsChanged(data: DataAccess, listener: () => void): () => void {
  const set = listeners.get(data) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(data, set);
  return () => {
    set.delete(listener);
  };
}

export function emitChecklistsChanged(data: DataAccess): void {
  for (const listener of [...(listeners.get(data) ?? [])]) listener();
}
