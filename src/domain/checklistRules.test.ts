import { describe, expect, it } from 'vitest';
import { CHECKLIST_TEXT_MAX, checkedItemIds, checklistProgress, compareChecklists, moveItem, duplicateAndReset, isValidChecklistTitle, nextItemOrder, sortChecklistSummaries, sortItems, validateChecklistText } from './checklistRules';
import { createUuidGenerator } from './id';
import type { Checklist, ChecklistItem, ChecklistSummary } from './model';

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

describe('checklistProgress (C-02 critères 1 et 6)', () => {
  it('« 3 / 6 » : 50 %', () => {
    const items = [true, true, true, false, false, false].map((checked) => ({ checked }));
    expect(checklistProgress(items)).toEqual({ checked: 3, total: 6, ratio: 0.5 });
  });

  it('sans item : 0 / 0 et rapport nul ; tout coché : rapport plein', () => {
    expect(checklistProgress([])).toEqual({ checked: 0, total: 0, ratio: 0 });
    expect(checklistProgress([{ checked: true }, { checked: true }])).toEqual({ checked: 2, total: 2, ratio: 1 });
  });
});

describe('duplicateAndReset (C-04 critères 1, 2 et 7)', () => {
  const ids = createUuidGenerator();
  const COPY_SUFFIX = ' (copie)';
  const source = { title: 'Valise voyage', spaceId: 'perso' as never, icon: { kind: 'lucide', name: 'briefcase' } as const };
  const item = (id: string, text: string, sortOrder: number, checked: boolean) => ({ id, text, sortOrder, checked, checklistId: 'orig' }) as unknown as ChecklistItem;

  it('copie « <titre> (copie) », mêmes items dans le même ordre, tous décochés, sans date, même espace et icône, non modèle', () => {
    const copy = duplicateAndReset(source, [item('b', 'Chargeur', 2, true), item('a', 'Passeport', 1, false), item('c', 'Billets', 3, true)], ids, COPY_SUFFIX);
    expect(copy.checklist).toMatchObject({ title: `Valise voyage${COPY_SUFFIX}`, spaceId: 'perso', icon: source.icon, date: null, isTemplate: false });
    expect(copy.items.map((i) => [i.text, i.checked, i.sortOrder])).toEqual([
      ['Passeport', false, 1],
      ['Chargeur', false, 2],
      ['Billets', false, 3],
    ]);
    expect(copy.items.every((i) => i.checklistId === copy.checklist.id)).toBe(true);
  });

  it('de nouveaux identifiants : aucun ne reprend celui de l’original ; deux copies diffèrent', () => {
    const originals = [item('a', 'A', 1, false), item('b', 'B', 2, false)];
    const first = duplicateAndReset(source, originals, ids, COPY_SUFFIX);
    const second = duplicateAndReset(source, originals, ids, COPY_SUFFIX);
    const all = [first.checklist.id, ...first.items.map((i) => i.id), second.checklist.id, ...second.items.map((i) => i.id)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('a');
  });

  it('une liste vide donne une copie vide ; un titre de 200 caractères reste dans la limite', () => {
    expect(duplicateAndReset(source, [], ids, COPY_SUFFIX).items).toEqual([]);
    const long = duplicateAndReset({ ...source, title: 'x'.repeat(CHECKLIST_TEXT_MAX) }, [], ids, COPY_SUFFIX);
    expect(long.checklist.title).toHaveLength(CHECKLIST_TEXT_MAX);
    expect(long.checklist.title.endsWith(COPY_SUFFIX)).toBe(true);
  });
});

describe('checkedItemIds (C-05 critères 1 et 4)', () => {
  it('liste les items cochés dans l’ordre donné', () => {
    expect(checkedItemIds([{ id: 'a' as never, checked: true }, { id: 'b' as never, checked: false }, { id: 'c' as never, checked: true }])).toEqual(['a', 'c']);
    expect(checkedItemIds([{ id: 'a' as never, checked: false }])).toEqual([]);
  });
});

describe('moveItem (C-05 critère 6)', () => {
  const items = [1, 2, 3, 4].map((n) => ({ id: `i${String(n)}` as never, sortOrder: n }));

  it('renumérote de 1 à N et n’écrit que les items dont l’ordre change', () => {
    expect(moveItem(items, 'i4' as never, 1)).toEqual([
      { id: 'i4', sortOrder: 2 },
      { id: 'i2', sortOrder: 3 },
      { id: 'i3', sortOrder: 4 },
    ]);
    expect(moveItem(items, 'i1' as never, 1)).toEqual([
      { id: 'i2', sortOrder: 1 },
      { id: 'i1', sortOrder: 2 },
    ]);
  });

  it('ne fait rien si la position ne change pas, hors liste ou pour un item inconnu', () => {
    expect(moveItem(items, 'i2' as never, 1)).toEqual([]);
    expect(moveItem(items, 'zz' as never, 1)).toEqual([]);
  });

  it('borne la destination à la liste', () => {
    expect(moveItem(items, 'i1' as never, 99).map((move) => move.id)).toEqual(['i2', 'i3', 'i4', 'i1']);
    expect(moveItem(items, 'i4' as never, -5).map((move) => move.id)).toEqual(['i4', 'i1', 'i2', 'i3']);
  });

  it('remet une liste à ordres fractionnaires ou irréguliers en suite 1..N', () => {
    const irregular = [{ id: 'a' as never, sortOrder: 1.5 }, { id: 'b' as never, sortOrder: 7 }, { id: 'c' as never, sortOrder: 9 }];
    expect(moveItem(irregular, 'c' as never, 0)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'a', sortOrder: 2 },
      { id: 'b', sortOrder: 3 },
    ]);
  });
});
