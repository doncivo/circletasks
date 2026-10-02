import { useEffect, type MutableRefObject } from 'react';

/** Référence partagée de la fiche : annule la saisie en place en cours (et rend true), ou null s'il n'y en a pas. */
export type InlineCancelRef = MutableRefObject<(() => boolean) | null>;

/**
 * Enregistre `cancel` dans la référence de la fiche tant que `active` : Échap annule d'abord la saisie en place (titre, date, heure,
 * espace) au lieu de fermer la fiche (A-08 critère 8). La fonction est retirée dès que la saisie se termine.
 */
export function useInlineCancel(ref: InlineCancelRef, active: boolean, cancel: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    const run = (): boolean => {
      cancel();
      return true;
    };
    ref.current = run;
    return () => {
      if (ref.current === run) ref.current = null;
    };
    // `cancel` ne change que par des setters d'état stables : l'enregistrement ne dépend que de l'activité.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active]);
}
