import type { SearchHit } from '../../domain/search';
import type { SearchQueryFilters } from '../../domain/searchFilters';

/**
 * Recherche plein texte (M14, RC-01 et RC-02). L'index FTS5 `search_index` est local, maintenu par déclencheurs SQL (migration 0011)
 * et jamais synchronisé. Les éléments supprimés logiquement, les événements externes et les fériés n'y figurent pas.
 */
export interface SearchQueryInput extends SearchQueryFilters {
  /** Expression FTS5 déjà construite par le domaine (`buildMatchExpression`) : mots entre guillemets, dernier en préfixe. */
  readonly match: string;
  /** Nombre maximal de lignes rendues (le domaine en demande une de plus que la limite pour savoir si la liste est tronquée). */
  readonly limit: number;
}

export interface SearchRepository {
  /**
   * Éléments trouvés, du plus pertinent au moins pertinent (titre avant note), tous types mêlés. Tous les filtres (espace, projet,
   * types, statuts, périodes) sont appliqués dans la requête : une branche par type cherché (`kinds`).
   */
  query(input: SearchQueryInput): Promise<readonly SearchHit[]>;
  /** Reconstruit tout l'index depuis les tables (commande de maintenance, idempotente) ; à lancer dans une transaction du `DataAccess`. */
  rebuild(): Promise<void>;
  /** L'index est-il absent ou périmé ? (nombre d'éléments indexés différent du nombre d'éléments vivants) */
  isStale(): Promise<boolean>;
}
