import { createStore } from 'zustand';
import type { SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createSearchUseCases, type SearchFilters, type SearchOutcome } from './searchUseCases';

/**
 * - `idle` : champ vide ; `too-short` : moins de 2 caractères ;
 * - `ready` : résultats (éventuellement vides) ; `error` : échec de la requête.
 */
export type SearchStatus = 'idle' | 'too-short' | 'ready' | 'error';

/**
 * État de la recherche (M14) : saisie, filtres propres à la recherche (jamais mémorisés), résultats. Une instance par conteneur.
 * Le filtre d'espace global (`useAppStore.spaceFilter`) n'est PAS copié ici en permanence : il n'initialise `filters.space` qu'à
 * l'ouverture (`open`), puis la recherche peut le changer sans toucher au filtre global (RC-02 critère 7).
 */
export interface SearchState {
  readonly query: string;
  readonly filters: SearchFilters;
  readonly status: SearchStatus;
  /** Résultats de la dernière requête terminée ; conservés pendant la suivante (pas de scintillement). */
  readonly outcome: SearchOutcome | null;
  readonly errorKey: PlainMessageKey | null;
  /** Ouvre une recherche neuve : champ vide, espace du filtre global, index vérifié (reconstruit s'il est périmé). Ne rejette jamais. */
  open(space: SpaceFilter): Promise<void>;
  /** Remet l'état à zéro (fermeture). */
  reset(): void;
  /** Nouvelle saisie : lance la requête (la réponse d'une requête dépassée est ignorée). Ne rejette jamais. */
  setQuery(text: string): Promise<void>;
  /** Change les filtres de la recherche et relance la requête. Ne rejette jamais. */
  setFilters(patch: Partial<SearchFilters>): Promise<void>;
}

const INITIAL = { query: '', status: 'idle', outcome: null, errorKey: null } as const;

export const searchStore = defineFeatureStore<SearchState>((container: AppContainer) => {
  const useCases = createSearchUseCases(container);
  /** Numéro de la dernière requête lancée : une réponse plus ancienne est ignorée. */
  let sequence = 0;

  return createStore<SearchState>()((set, get) => {
    async function run(): Promise<void> {
      sequence += 1;
      const mine = sequence;
      const { query, filters } = get();
      if (query.trim() === '') {
        set({ status: 'idle', outcome: null, errorKey: null });
        return;
      }
      const result = await useCases.run(query, filters);
      if (mine !== sequence) return;
      if (result.ok) set({ status: 'ready', outcome: result.value, errorKey: null });
      else if (result.error === 'too-short') set({ status: 'too-short', outcome: null, errorKey: null });
      else set({ status: 'error', errorKey: 'search.error' });
    }

    return {
      ...INITIAL,
      filters: { space: 'all' },
      async open(space) {
        sequence += 1;
        set({ ...INITIAL, filters: { space } });
        await useCases.ensureIndex();
      },
      reset: () => {
        sequence += 1;
        set({ ...INITIAL, filters: { space: 'all' } });
      },
      setQuery: async (text) => {
        set({ query: text });
        await run();
      },
      setFilters: async (patch) => {
        set((s) => ({ filters: { ...s.filters, ...patch } }));
        await run();
      },
    };
  });
});
