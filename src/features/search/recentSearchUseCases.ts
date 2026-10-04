import { pushRecentSearch, removeRecentSearch, restoreRecentSearches } from '../../domain/recentSearches';
import type { AppContainer } from '../app/container';
import { emitRecentSearchesChanged } from './recentSearchEvents';

/**
 * Recherches récentes (RC-04) : cas d'usage de réglages. La liste est le réglage local `search.recent` (jamais synchronisé ni partagé,
 * `SETTINGS_DEFINITIONS`) ; le store de la recherche n'écrit rien lui-même, il demande ces cas d'usage et garde la liste rendue.
 * Chaque cas d'usage lit puis écrit dans une transaction (aucune mise à jour perdue) et ne rejette jamais : en cas d'échec il rend
 * `null` (la liste affichée reste celle d'avant, la recherche elle-même n'est pas gênée).
 */
export interface RecentSearchUseCases {
  /** Liste mémorisée, la plus récente en premier ; `null` si la base n'a pas répondu. */
  load(): Promise<readonly string[] | null>;
  /** Enregistre une requête validée (Entrée, ou ouverture d'un résultat) : dix au plus, doublon remonté en tête (critères 3 et 4). */
  record(query: string): Promise<readonly string[] | null>;
  /** Croix d'une puce (critère 5). */
  remove(query: string): Promise<readonly string[] | null>;
  /** « Effacer » : vide la liste ; message « Annuler » de 5 s (pile d'annulation, Ctrl+Z aussi) qui la restitue (critère 5). */
  clear(): Promise<readonly string[] | null>;
}

export type RecentSearchDeps = Pick<AppContainer, 'data' | 'undo'>;

interface Written {
  readonly after: readonly string[];
  readonly before: readonly string[];
}

export function createRecentSearchUseCases(deps: RecentSearchDeps): RecentSearchUseCases {
  const KEY = 'search.recent' as const;

  /** Lit, transforme et écrit la liste dans une transaction (écrite seulement si elle change) ; `null` en cas d'échec. */
  async function update(change: (list: readonly string[]) => readonly string[]): Promise<Written | null> {
    try {
      const result = await deps.data.transaction(async (repos) => {
        const before = await repos.settings.get(KEY);
        const after = change(before);
        const changed = after.length !== before.length || after.some((entry, index) => entry !== before[index]);
        if (changed) await repos.settings.set(KEY, after);
        return { after, before, changed };
      });
      if (result.changed) emitRecentSearchesChanged(deps.data);
      return { after: result.after, before: result.before };
    } catch {
      return null;
    }
  }

  return {
    async load() {
      try {
        return await deps.data.repos.settings.get(KEY);
      } catch {
        return null;
      }
    },
    record: async (query) => (await update((list) => pushRecentSearch(list, query)))?.after ?? null,
    remove: async (query) => (await update((list) => removeRecentSearch(list, query)))?.after ?? null,
    async clear() {
      const written = await update(() => []);
      if (!written) return null;
      if (written.before.length > 0) {
        const { before } = written;
        deps.undo.push({
          kind: 'search',
          count: 1,
          async undo() {
            const restored = await update((current) => restoreRecentSearches(current, before));
            return restored ? 'undone' : 'stale';
          },
        });
      }
      return written.after;
    },
  };
}
