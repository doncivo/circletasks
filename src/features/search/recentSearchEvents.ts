import type { DataAccess } from '../../db/repositories';

/**
 * Notification « les recherches récentes ont changé » : émise après chaque écriture de la liste (enregistrer, retirer, effacer,
 * annuler « Effacer »). La recherche ouverte s'y abonne : l'annulation (message « Annuler », Ctrl+Z) écrit en base sans passer par elle.
 * Clé : le `DataAccess` du conteneur (un par conteneur, donc isolé en test).
 */
const listeners = new WeakMap<DataAccess, Set<() => void>>();

/** S'abonne aux changements de la liste ; renvoie la fonction de désabonnement. */
export function onRecentSearchesChanged(data: DataAccess, listener: () => void): () => void {
  const set = listeners.get(data) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(data, set);
  return () => {
    set.delete(listener);
  };
}

export function emitRecentSearchesChanged(data: DataAccess): void {
  for (const listener of [...(listeners.get(data) ?? [])]) listener();
}
