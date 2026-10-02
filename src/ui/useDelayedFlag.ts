import { useEffect, useState } from 'react';

/**
 * Drapeau retardé (A-09 critère 1) : devient vrai seulement si `active` reste vrai pendant `delayMs`, et retombe à faux
 * aussitôt que `active` l'est. Un chargement plus court que le délai n'affiche donc aucun squelette (pas de scintillement).
 *
 * @example
 * const showSkeleton = useDelayedFlag(status === 'loading', 150);
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  // Retombée à faux dès l'arrêt de l'activité (état dérivé pendant le rendu, pas d'effet).
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setElapsed(false);
  }
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(id);
  }, [active, delayMs]);
  return active && elapsed;
}
