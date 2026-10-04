import { useEffect, useState } from 'react';
import type { Clock } from '../../domain/clock';

/**
 * Instant courant, relu à chaque seconde et dès le retour au premier plan (`visibilitychange`, `focus`). Ce n'est PAS un compteur :
 * la valeur n'est jamais incrémentée, elle est relue dans l'horloge ; un tic manqué (veille, arrière-plan) n'a donc aucun effet sur
 * l'affichage, recalculé depuis les horodatages au tic suivant.
 */
export function useNow(clock: Clock, intervalMs = 1000): number {
  const [now, setNow] = useState(() => clock.nowMs());
  useEffect(() => {
    const refresh = (): void => setNow(clock.nowMs());
    const timer = setInterval(refresh, intervalMs);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [clock, intervalMs]);
  return now;
}
