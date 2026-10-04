import { createStore } from 'zustand';
import { todayLocal } from '../../domain/clock';
import { initialSearchFilters, NO_SEARCH_FILTERS, withSpace, type SearchFilters } from '../../domain/searchFilters';
import type { SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { useAppStore } from '../app/appStore';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { onRecentSearchesChanged } from './recentSearchEvents';
import { createRecentSearchUseCases } from './recentSearchUseCases';
import { createSearchUseCases, type SearchOutcome } from './searchUseCases';

/**
 * - `idle` : champ vide ; `too-short` : moins de 2 caractères ;
 * - `ready` : résultats (éventuellement vides) ; `error` : échec de la requête.
 */
export type SearchStatus = 'idle' | 'too-short' | 'ready' | 'error';

/**
 * État de la recherche (M14) : saisie, filtres propres à la recherche (jamais mémorisés), résultats, recherches récentes. Une instance
 * par conteneur. Le filtre d'espace global (`useAppStore.spaceFilter`) n'est PAS copié ici en permanence : il n'initialise
 * `filters.space` qu'à l'ouverture (`open`), puis la recherche peut le changer sans toucher au filtre global (RC-02 critère 7).
 * Les recherches récentes sont écrites par les cas d'usage de réglages (`recentSearchUseCases`), jamais par le store (RC-04 critère 8) :
 * `recent` n'en est que la copie affichée, relue à chaque changement.
 */
export interface SearchState {
  readonly query: string;
  readonly filters: SearchFilters;
  readonly status: SearchStatus;
  /** Résultats de la dernière requête terminée ; conservés pendant la suivante (pas de scintillement). */
  readonly outcome: SearchOutcome | null;
  readonly errorKey: PlainMessageKey | null;
  /** Dix dernières recherches validées, la plus récente en premier (RC-04). */
  readonly recent: readonly string[];
  /** Ouvre une recherche neuve : champ vide, espace du filtre global, index vérifié (reconstruit s'il est périmé), récentes lues. Ne rejette jamais. */
  open(space: SpaceFilter): Promise<void>;
  /** Remet l'état à zéro (fermeture). */
  reset(): void;
  /** Nouvelle saisie : lance la requête (la réponse d'une requête dépassée est ignorée). Ne rejette jamais. */
  setQuery(text: string): Promise<void>;
  /** Change des filtres de la recherche et relance la requête ; un nouvel espace remet « Projet : tous ». Ne rejette jamais. */
  setFilters(patch: Partial<SearchFilters>): Promise<void>;
  /** « Réinitialiser » : aucun filtre (espace « Tout » compris) ; relance la requête. Ne rejette jamais. */
  resetFilters(): Promise<void>;
  /** Entrée ou ouverture d'un résultat : mémorise la saisie courante si elle est valide (RC-04 critère 3). Ne rejette jamais. */
  recordQuery(): Promise<void>;
  /** Croix d'une puce récente (RC-04 critère 5). Ne rejette jamais. */
  removeRecent(query: string): Promise<void>;
  /** « Effacer » : vide la liste, message « Annuler » de 5 s (RC-04 critère 5). Ne rejette jamais. */
  clearRecent(): Promise<void>;
}

const INITIAL = { query: '', status: 'idle', outcome: null, errorKey: null } as const;

export const searchStore = defineFeatureStore<SearchState>((container: AppContainer) => {
  const useCases = createSearchUseCases(container);
  const recentUseCases = createRecentSearchUseCases(container);
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
      // Jour courant de l'app (suit minuit, T-06) ; horloge du conteneur avant le premier contrôle.
      const today = useAppStore.getState().day ?? todayLocal(container.clock);
      const result = await useCases.run(query, filters, today);
      if (mine !== sequence) return;
      if (result.ok) set({ status: 'ready', outcome: result.value, errorKey: null });
      else if (result.error === 'too-short') set({ status: 'too-short', outcome: null, errorKey: null });
      else set({ status: 'error', errorKey: 'search.error' });
    }

    async function loadRecent(): Promise<void> {
      const list = await recentUseCases.load();
      if (list) set({ recent: list });
    }

    // L'annulation de « Effacer » (message ou Ctrl+Z) écrit sans passer par la recherche : la liste affichée se relit.
    onRecentSearchesChanged(container.data, () => void loadRecent());

    return {
      ...INITIAL,
      filters: NO_SEARCH_FILTERS,
      recent: [],
      async open(space) {
        sequence += 1;
        set({ ...INITIAL, filters: initialSearchFilters(space) });
        await Promise.all([useCases.ensureIndex(), loadRecent()]);
      },
      reset: () => {
        sequence += 1;
        set({ ...INITIAL, filters: NO_SEARCH_FILTERS });
      },
      setQuery: async (text) => {
        set({ query: text });
        await run();
      },
      setFilters: async (patch) => {
        set((s) => {
          const base = patch.space !== undefined ? withSpace(s.filters, patch.space) : s.filters;
          return { filters: { ...base, ...patch } };
        });
        await run();
      },
      resetFilters: async () => {
        set({ filters: NO_SEARCH_FILTERS });
        await run();
      },
      recordQuery: async () => {
        const list = await recentUseCases.record(get().query);
        if (list) set({ recent: list });
      },
      removeRecent: async (query) => {
        const list = await recentUseCases.remove(query);
        if (list) set({ recent: list });
      },
      clearRecent: async () => {
        const list = await recentUseCases.clear();
        if (list) set({ recent: list });
      },
    };
  });
});
