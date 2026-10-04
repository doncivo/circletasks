import type { SearchHit } from '../../domain/search';
import type { SpaceFilter } from '../../domain/types';

/**
 * Recherche plein texte (M14, RC-01). L'index FTS5 `search_index` est local, maintenu par déclencheurs SQL (migration 0011) et jamais
 * synchronisé. Les éléments supprimés logiquement, les événements externes et les fériés n'y figurent pas.
 */
export interface SearchQueryInput {
  /** Expression FTS5 déjà construite par le domaine (`buildMatchExpression`) : mots entre guillemets, dernier en préfixe. */
  readonly match: string;
  /** Filtre d'espace (appliqué dans la requête). */
  readonly space: SpaceFilter;
  /** Nombre maximal de lignes rendues (le domaine en demande une de plus que la limite pour savoir si la liste est tronquée). */
  readonly limit: number;
}

export interface SearchRepository {
  /** Éléments trouvés, du plus pertinent au moins pertinent (titre avant note), tous types mêlés. */
  query(input: SearchQueryInput): Promise<readonly SearchHit[]>;
  /** Reconstruit tout l'index depuis les tables (commande de maintenance, idempotente) ; à lancer dans une transaction du `DataAccess`. */
  rebuild(): Promise<void>;
  /** L'index est-il absent ou périmé ? (nombre d'éléments indexés différent du nombre d'éléments vivants) */
  isStale(): Promise<boolean>;
}
