import { describe, expect, it } from 'vitest';
import {
  buildMatchExpression,
  groupSearchResults,
  highlightSegments,
  matchExcerpt,
  normalizeSearchText,
  searchTokens,
  segmentsText,
  toSearchResult,
  validateSearchQuery,
  type SearchHit,
} from './search';
import type { SpaceId } from './types';

const hit = (overrides: Partial<SearchHit> & Pick<SearchHit, 'kind' | 'id' | 'title'>): SearchHit => ({
  note: '',
  date: null,
  time: null,
  status: null,
  spaceId: 's1' as SpaceId,
  projectId: null,
  someday: false,
  icon: null,
  items: [],
  itemsChecked: 0,
  repeat: null,
  ...overrides,
});

describe('normalisation et requête (RC-01)', () => {
  it('ignore casse, accents et espaces multiples', () => {
    expect(normalizeSearchText('  FactÜre   Énergie ')).toBe('facture energie');
    expect(searchTokens('Appeler l’électricien, vite !')).toEqual(['appeler', 'l', 'electricien', 'vite']);
  });

  it('exige deux caractères (critère 6)', () => {
    expect(validateSearchQuery('f')).toEqual({ ok: false, error: 'too-short' });
    expect(validateSearchQuery('  a ')).toEqual({ ok: false, error: 'too-short' });
    expect(validateSearchQuery('--')).toEqual({ ok: false, error: 'too-short' });
    expect(validateSearchQuery('fa')).toEqual({ ok: true, value: { text: 'fa', tokens: ['fa'] } });
    expect(validateSearchQuery(' Envoyer   la facture ')).toEqual({ ok: true, value: { text: 'Envoyer la facture', tokens: ['envoyer', 'la', 'facture'] } });
  });

  it('construit une expression FTS5 sûre avec préfixe sur le dernier mot seulement (critère 3)', () => {
    expect(buildMatchExpression(['fact'])).toBe('"fact"*');
    expect(buildMatchExpression(['envoyer', 'fact'])).toBe('"envoyer" "fact"*');
    // Aucun opérateur FTS5 ne survit : les mots n'ont que des lettres et des chiffres.
    expect(buildMatchExpression(searchTokens('NOT "x" OR (y) *'))).toBe('"not" "x" "or" "y"*');
  });
});

describe('surlignage et extraits (critère 5)', () => {
  it('surligne le mot entier, sans tenir compte des accents ni de la casse', () => {
    const segments = highlightSegments('Envoyer la Factüre d’août', ['facture']);
    expect(segments).toEqual([
      { text: 'Envoyer la ', match: false },
      { text: 'Factüre', match: true },
      { text: ' d’août', match: false },
    ]);
    expect(segmentsText(segments)).toBe('Envoyer la Factüre d’août');
  });

  it('un préfixe surligne le mot complet, seulement pour le dernier mot de la requête', () => {
    expect(highlightSegments('Factures fournisseurs', ['fact']).filter((s) => s.match).map((s) => s.text)).toEqual(['Factures']);
    expect(highlightSegments('Factures fournisseurs', ['fact', 'four']).filter((s) => s.match).map((s) => s.text)).toEqual(['fournisseurs']);
  });

  it('un texte sans correspondance reste en un seul segment', () => {
    expect(highlightSegments('Courses', ['facture'])).toEqual([{ text: 'Courses', match: false }]);
  });

  it('cite la ligne de la note où le mot se trouve ; null si le mot n’y est pas', () => {
    expect(segmentsText(matchExcerpt('à faire\ncontester la facture\nautre', ['facture']) ?? [])).toBe('contester la facture');
    expect(matchExcerpt('rien ici', ['facture'])).toBeNull();
  });

  it('coupe un long extrait autour du mot avec des points de suspension', () => {
    const long = `${'mot '.repeat(40)}facture${' mot'.repeat(40)}`;
    const excerpt = matchExcerpt(long, ['facture']) ?? [];
    const text = segmentsText(excerpt);
    expect(text.length).toBeLessThanOrEqual(75);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(excerpt.find((s) => s.match)?.text).toBe('facture');
  });

  it('toSearchResult cite la note d’une tâche et l’item d’une checklist', () => {
    const task = toSearchResult(hit({ kind: 'task', id: 't1', title: 'Appeler le fournisseur', note: 'contester la facture' }), ['facture']);
    expect(task.citation?.source).toBe('note');
    expect(segmentsText(task.citation?.segments ?? [])).toBe('contester la facture');
    const byTitle = toSearchResult(hit({ kind: 'task', id: 't2', title: 'Facture', note: 'autre chose' }), ['facture']);
    expect(byTitle.citation).toBeNull();
    const list = toSearchResult(hit({ kind: 'checklist', id: 'c1', title: 'Valise', items: ['Brosse', 'Crème solaire'] }), ['creme']);
    expect(list.citation?.source).toBe('item');
    expect(segmentsText(list.citation?.segments ?? [])).toBe('Crème solaire');
    expect(list.key).toBe('checklist:c1');
  });
});

describe('groupement (critère 5)', () => {
  it('groupe dans l’ordre Tâches, Checklists, Événements, Routines, Objectifs, garde la pertinence, omet les groupes vides', () => {
    const results = [
      hit({ kind: 'goal', id: 'g1', title: 'G' }),
      hit({ kind: 'task', id: 't1', title: 'A' }),
      hit({ kind: 'event', id: 'e1', title: 'E' }),
      hit({ kind: 'task', id: 't2', title: 'B' }),
    ].map((h) => toSearchResult(h, ['x']));
    const groups = groupSearchResults(results);
    expect(groups.map((g) => [g.kind, g.results.map((r) => r.hit.id)])).toEqual([
      ['task', ['t1', 't2']],
      ['event', ['e1']],
      ['goal', ['g1']],
    ]);
  });
});
