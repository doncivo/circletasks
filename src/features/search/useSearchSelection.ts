import { useCallback, useMemo, useState } from 'react';
import { groupSearchResults, type SearchGroup, type SearchResult } from '../../domain/search';

export type SelectionMove = 'next' | 'previous' | 'first' | 'last';

export interface SearchSelection {
  /** Résultats groupés par type (calculés une seule fois, partagés avec l'affichage). */
  readonly groups: readonly SearchGroup[];
  /** Résultats dans l'ordre d'affichage (groupe après groupe). */
  readonly ordered: readonly SearchResult[];
  /** Ligne sélectionnée : celle choisie si elle existe encore, sinon la première ; null sans résultat. */
  readonly selected: SearchResult | null;
  select(key: string): void;
  /** Déplace la sélection (sans boucler : aux extrémités elle reste) et rend la nouvelle ligne sélectionnée. */
  move(move: SelectionMove): SearchResult | null;
}

/**
 * Sélection d'une ligne parmi les résultats groupés (RC-03 critère 1) : ↑ / ↓ passent de ligne en ligne à travers les groupes,
 * Début et Fin vont à la première et à la dernière. L'état est local à la recherche ; il suit les résultats (une ligne disparue
 * laisse la première sélectionnée).
 */
export function useSearchSelection(results: readonly SearchResult[]): SearchSelection {
  const groups = useMemo(() => groupSearchResults(results), [results]);
  const ordered = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = ordered.find((result) => result.key === chosen) ?? ordered[0] ?? null;

  const move = useCallback(
    (direction: SelectionMove): SearchResult | null => {
      if (ordered.length === 0) return null;
      const index = selected ? ordered.indexOf(selected) : 0;
      const nextIndex = direction === 'first' ? 0 : direction === 'last' ? ordered.length - 1 : Math.min(Math.max(index + (direction === 'next' ? 1 : -1), 0), ordered.length - 1);
      const next = ordered[nextIndex] ?? null;
      if (next) setChosen(next.key);
      return next;
    },
    [ordered, selected],
  );

  return { groups, ordered, selected, select: setChosen, move };
}
