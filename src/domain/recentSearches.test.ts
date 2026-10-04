import { describe, expect, it } from 'vitest';
import { RECENT_SEARCH_LIMIT, pushRecentSearch, removeRecentSearch, restoreRecentSearches, sameSearch } from './recentSearches';

describe('recherches récentes (RC-04)', () => {
  it('la plus récente passe en tête (critère 1)', () => {
    expect(pushRecentSearch(['sport'], 'notaire')).toEqual(['notaire', 'sport']);
    expect(pushRecentSearch([], 'passeport')).toEqual(['passeport']);
  });

  it('refuse une requête de moins de 2 caractères ou sans mot (critère 3)', () => {
    expect(pushRecentSearch(['sport'], 'a')).toEqual(['sport']);
    expect(pushRecentSearch(['sport'], '  ')).toEqual(['sport']);
    expect(pushRecentSearch(['sport'], '--')).toEqual(['sport']);
  });

  it('nettoie les espaces de la requête enregistrée', () => {
    expect(pushRecentSearch([], '  Envoyer   la facture ')).toEqual(['Envoyer la facture']);
  });

  it('une requête déjà présente remonte en tête sans doublon, casse et accents ignorés (critère 4)', () => {
    expect(pushRecentSearch(['notaire', 'sport', 'clôture'], 'CLOTURE')).toEqual(['CLOTURE', 'notaire', 'sport']);
    expect(pushRecentSearch(['Facture', 'sport'], 'factüre')).toEqual(['factüre', 'sport']);
    expect(sameSearch('Éléphant', 'elephant')).toBe(true);
  });

  it('garde dix entrées au plus : la plus ancienne sort (critère 4)', () => {
    let list: string[] = [];
    for (let i = 1; i <= 12; i += 1) list = pushRecentSearch(list, `recherche ${String(i)}`);
    expect(list).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(list[0]).toBe('recherche 12');
    expect(list.at(-1)).toBe('recherche 3');
    expect(list).not.toContain('recherche 2');
  });

  it('ne modifie jamais la liste reçue', () => {
    const list = Object.freeze(['sport']);
    expect(pushRecentSearch(list, 'notaire')).toEqual(['notaire', 'sport']);
    expect(removeRecentSearch(list, 'sport')).toEqual([]);
    expect(list).toEqual(['sport']);
  });

  it('retire une requête, casse et accents ignorés (critère 5)', () => {
    expect(removeRecentSearch(['notaire', 'Sport', 'passeport'], 'sport')).toEqual(['notaire', 'passeport']);
    expect(removeRecentSearch(['notaire'], 'absent')).toEqual(['notaire']);
  });

  it('annuler « Effacer » restitue la liste sans écraser les recherches faites depuis', () => {
    expect(restoreRecentSearches([], ['notaire', 'sport'])).toEqual(['notaire', 'sport']);
    expect(restoreRecentSearches(['loyer', 'Sport'], ['notaire', 'sport'])).toEqual(['loyer', 'Sport', 'notaire']);
    const previous = Array.from({ length: 10 }, (_, i) => `ancienne ${String(i)}`);
    expect(restoreRecentSearches(['nouvelle'], previous)).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(restoreRecentSearches(['nouvelle'], previous)[0]).toBe('nouvelle');
  });
});
