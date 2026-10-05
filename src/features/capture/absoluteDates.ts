import { useEffect, useSyncExternalStore } from 'react';
import { hasAbsoluteDateParser, registerAbsoluteDateParser } from '../../domain/naturalDate';

/**
 * Chargement à la demande de l'analyseur des dates écrites (chrono-node, PERF-02). La bibliothèque n'est pas dans le bloc de départ :
 * elle est chargée en arrière-plan après le premier rendu (`preloadAbsoluteDates`) ou dès qu'un champ de saisie naturelle s'affiche
 * (`useAbsoluteDates`). Une saisie faite avant la fin du chargement est d'abord lue par la grammaire locale (demain, jours de semaine,
 * heures), puis relue à la fin : les champs dépendent de `useAbsoluteDates`, qui change d'état à ce moment. Jamais d'erreur levée :
 * un échec de chargement laisse la grammaire locale seule.
 */
let promise: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Charge (une seule fois) l'analyseur des dates écrites. La promesse se résout toujours. */
export function loadAbsoluteDates(): Promise<void> {
  if (hasAbsoluteDateParser()) return Promise.resolve();
  promise ??= import('../../domain/chronoAbsolute').then(
    (module) => {
      registerAbsoluteDateParser(module.chronoAbsoluteParser);
      notify();
    },
    () => {
      promise = null; // nouvel essai possible à la prochaine demande
    },
  );
  return promise;
}

/** Lance le chargement au premier moment d'inactivité du navigateur. Rend l'arrêt de l'attente. */
export function preloadAbsoluteDates(): () => void {
  const hasIdle = typeof window.requestIdleCallback === 'function';
  const handle = hasIdle ? window.requestIdleCallback(() => void loadAbsoluteDates(), { timeout: 1500 }) : window.setTimeout(() => void loadAbsoluteDates(), 100);
  return () => (hasIdle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getVersion = (): number => version;

/**
 * À appeler par tout champ qui analyse du texte libre : lance le chargement et rend un nombre qui change quand l'analyseur arrive
 * (à mettre dans les dépendances des analyses mémoïsées pour relire la saisie déjà tapée).
 */
export function useAbsoluteDates(): number {
  useEffect(() => {
    void loadAbsoluteDates();
  }, []);
  return useSyncExternalStore(subscribe, getVersion);
}
