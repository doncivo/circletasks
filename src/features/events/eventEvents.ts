import type { DataAccess } from '../../db/repositories';

/**
 * Notification « les événements ont changé » : émise après chaque écriture d'événement (création, modification, suppression,
 * annulation). L'onglet Événements, Aujourd'hui et la Semaine s'y abonnent pour se relire : une annulation (T-13) écrit en base
 * sans passer par l'écran qui affiche l'événement. Clé : le `DataAccess` du conteneur (un par conteneur, isolé en test).
 */
const listeners = new WeakMap<DataAccess, Set<() => void>>();

/** S'abonne aux changements d'événements ; renvoie la fonction de désabonnement. */
export function onEventsChanged(data: DataAccess, listener: () => void): () => void {
  const set = listeners.get(data) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(data, set);
  return () => {
    set.delete(listener);
  };
}

export function emitEventsChanged(data: DataAccess): void {
  for (const listener of [...(listeners.get(data) ?? [])]) listener();
}
