import { describe, expect, it } from 'vitest';
import { CHECKLIST_TEXT_MAX, compareChecklists, isValidChecklistTitle, nextItemOrder, sortChecklistSummaries, sortItems, validateChecklistText } from './checklistRules';
import type { Checklist, ChecklistSummary } from './model';

const summary = (id: string, title: string): ChecklistSummary => ({ checklist: { id, title } as unknown as Checklist, checked: 0, total: 0 });

describe('validateChecklistText (C-01 critères 1 et 3)', () => {
  it('nettoie les espaces de bord et accepte 1 à 200 caractères', () => {
    expect(validateChecklistText('  Passeport  ')).toEqual({ ok: true, value: 'Passeport' });
    expect(validateChecklistText('a')).toEqual({ ok: true, value: 'a' });
    expect(validateChecklistText('x'.repeat(CHECKLIST_TEXT_MAX))).toMatchObject({ ok: true });
  });

  it('refuse le vide, le blanc et plus de 200 caractères', () => {
    expect(validateChecklistText('')).toEqual({ ok: false, error: 'empty' });
    expect(validateChecklistText('  \t ')).toEqual({ ok: false, error: 'empty' });
    expect(validateChecklistText('x'.repeat(CHECKLIST_TEXT_MAX + 1))).toEqual({ ok: false, error: 'tooLong' });
    expect(isValidChecklistTitle('  ')).toBe(false);
    expect(isValidChecklistTitle('Courses')).toBe(true);
  });
});

describe('tri des checklists (C-01 critère 4)', () => {
  it('trie par titre sans tenir compte des accents ni de la casse', () => {
    const sorted = sortChecklistSummaries([summary('1', 'Valise'), summary('2', 'été'), summary('3', 'Courses'), summary('4', 'Eau'), summary('5', 'ecole')]);
    expect(sorted.map((s) => s.checklist.title)).toEqual(['Courses', 'Eau', 'ecole', 'été', 'Valise']);
  });

  it('départage deux titres identiques par l’identifiant (tri stable)', () => {
    expect(compareChecklists({ id: 'a' as never, title: 'Liste' }, { id: 'b' as never, title: 'liste' })).toBeLessThan(0);
  });

  it('ordonne les nombres naturellement (Liste 2 avant Liste 10)', () => {
    expect(sortChecklistSummaries([summary('1', 'Liste 10'), summary('2', 'Liste 2')]).map((s) => s.checklist.title)).toEqual(['Liste 2', 'Liste 10']);
  });
});

describe('ordre des items', () => {
  const item = (id: string, sortOrder: number) => ({ id: id as never, sortOrder });

  it('sortItems : ordre manuel puis identifiant', () => {
    expect(sortItems([item('b', 2), item('a', 2), item('c', 1)]).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('nextItemOrder : en fin de liste, 1 pour une liste vide', () => {
    expect(nextItemOrder([])).toBe(1);
    expect(nextItemOrder([item('a', 1), item('b', 7.5)])).toBe(8.5);
  });
});
