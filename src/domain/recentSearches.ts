import { normalizeSearchText, validateSearchQuery } from './search';

/**
 * Recherches récentes (RC-04) : les dix dernières requêtes validées, la plus récente en premier. Règles pures ; la liste est un
 * réglage local de l'appareil (`search.recent`), jamais synchronisé.
 */
export const RECENT_SEARCH_LIMIT = 10;

/** Deux requêtes sont la même recherche si elles ne diffèrent que par la casse, les accents ou les espaces (« Factüre » = « facture »). */
export const sameSearch = (a: string, b: string): boolean => normalizeSearchText(a) === normalizeSearchText(b);

/**
 * Enregistre une requête validée (critères 3 et 4) : refusée si elle a moins de 2 caractères ; une requête déjà présente (casse et
 * accents ignorés) remonte en tête sans doublon, avec la graphie de la dernière saisie ; au-delà de dix, la plus ancienne sort.
 * Rend une nouvelle liste (la liste reçue n'est jamais modifiée).
 */
export function pushRecentSearch(list: readonly string[], query: string): string[] {
  const valid = validateSearchQuery(query);
  if (!valid.ok) return [...list];
  return [valid.value.text, ...list.filter((entry) => !sameSearch(entry, valid.value.text))].slice(0, RECENT_SEARCH_LIMIT);
}

/** Retire une requête (croix d'une puce, critère 5), casse et accents ignorés. */
export function removeRecentSearch(list: readonly string[], query: string): string[] {
  return list.filter((entry) => !sameSearch(entry, query));
}

/**
 * Restitue une liste effacée (annulation de « Effacer », critère 5) sans écraser ce qui a été recherché depuis : les entrées actuelles
 * restent en tête, les anciennes suivent (doublons écartés), dix au plus.
 */
export function restoreRecentSearches(current: readonly string[], previous: readonly string[]): string[] {
  const merged = [...current];
  for (const entry of previous) if (!merged.some((existing) => sameSearch(existing, entry))) merged.push(entry);
  return merged.slice(0, RECENT_SEARCH_LIMIT);
}
