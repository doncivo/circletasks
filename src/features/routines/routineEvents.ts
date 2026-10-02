import type { DataAccess } from '../../db/repositories';

/**
 * Notification « les routines ont changé » : émise après chaque écriture de routine ou de validation (valider, rouvrir, annuler,
 * modifier, mettre en pause, archiver, restaurer). Aujourd'hui, la Semaine et l'onglet Routines s'y abonnent pour se relire :
 * une annulation (T-13) écrit en base sans passer par l'écran qui affiche la routine.
 *
 * Clé : le `DataAccess` du conteneur (un par conteneur, donc isolé en test).
 */
const listeners = new WeakMap<DataAccess, Set<() => void>>();

/** S'abonne aux changements de routines ; renvoie la fonction de désabonnement. */
export function onRoutinesChanged(data: DataAccess, listener: () => void): () => void {
  const set = listeners.get(data) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(data, set);
  return () => {
    set.delete(listener);
  };
}

export function emitRoutinesChanged(data: DataAccess): void {
  for (const listener of [...(listeners.get(data) ?? [])]) listener();
}
