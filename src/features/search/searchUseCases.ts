import {
  SEARCH_LIMIT,
  buildMatchExpression,
  toSearchResult,
  validateSearchQuery,
  type SearchQueryError,
  type SearchResult,
} from '../../domain/search';
import type { Result, SpaceFilter } from '../../domain/types';
import type { AppContainer } from '../app/container';

/** Filtres d'une recherche (RC-01 : espace ; RC-02 en ajoute). */
export interface SearchFilters {
  readonly space: SpaceFilter;
}

/** Résultats d'une recherche, prêts à afficher. */
export interface SearchOutcome {
  /** Texte nettoyé de la requête (message « Aucun résultat pour « … » »). */
  readonly text: string;
  readonly tokens: readonly string[];
  /** Au plus `SEARCH_LIMIT` éléments, du plus pertinent au moins pertinent. */
  readonly results: readonly SearchResult[];
  /** Plus de `SEARCH_LIMIT` éléments correspondent : « Affinez la recherche ». */
  readonly truncated: boolean;
}

export type SearchError = SearchQueryError | 'failed';

export interface SearchUseCases {
  /** Valide la saisie puis interroge l'index avec les filtres. Ne rejette jamais. */
  run(rawQuery: string, filters: SearchFilters): Promise<Result<SearchOutcome, SearchError>>;
  /** Reconstruit l'index s'il est absent ou périmé (RC-01 critère 9) ; faux si rien à faire ou en cas d'échec. Ne rejette jamais. */
  ensureIndex(): Promise<boolean>;
}

export type SearchUseCaseDeps = Pick<AppContainer, 'data'>;

export function createSearchUseCases(deps: SearchUseCaseDeps): SearchUseCases {
  return {
    async run(rawQuery, filters) {
      const valid = validateSearchQuery(rawQuery);
      if (!valid.ok) return valid;
      try {
        const hits = await deps.data.repos.search.query({
          match: buildMatchExpression(valid.value.tokens),
          space: filters.space,
          // Une ligne de plus que la limite : sert à savoir si la liste est tronquée.
          limit: SEARCH_LIMIT + 1,
        });
        const { text, tokens } = valid.value;
        return {
          ok: true,
          value: {
            text,
            tokens,
            results: hits.slice(0, SEARCH_LIMIT).map((hit) => toSearchResult(hit, tokens)),
            truncated: hits.length > SEARCH_LIMIT,
          },
        };
      } catch {
        return { ok: false, error: 'failed' };
      }
    },

    async ensureIndex() {
      try {
        if (!(await deps.data.repos.search.isStale())) return false;
        await deps.data.transaction((repos) => repos.search.rebuild());
        return true;
      } catch {
        return false;
      }
    },
  };
}
