import type { DataAccess } from '../../db/repositories';

/**
 * Notification « les objectifs ont changé » : émise après chaque écriture d'objectif (création, titre, épinglage, atteint, reconduction,
 * suppression, annulation, rattachement d'une tâche). Aujourd'hui, la Semaine et l'écran Objectif s'y abonnent pour se relire :
 * une annulation (T-13) écrit en base sans passer par l'écran qui affiche l'objectif.
 *
 * Clé : le `DataAccess` du conteneur (un par conteneur, donc isolé en test), comme `routineEvents`.
 */
const listeners = new WeakMap<DataAccess, Set<() => void>>();

/** S'abonne aux changements d'objectifs ; renvoie la fonction de désabonnement. */
export function onGoalsChanged(data: DataAccess, listener: () => void): () => void {
  const set = listeners.get(data) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(data, set);
  return () => {
    set.delete(listener);
  };
}

export function emitGoalsChanged(data: DataAccess): void {
  for (const listener of [...(listeners.get(data) ?? [])]) listener();
}
