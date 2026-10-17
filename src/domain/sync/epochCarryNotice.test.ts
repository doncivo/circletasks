import { describe, expect, it } from 'vitest';
import type { Hlc } from '../types';
import { EPOCH_CARRY_NOTICE_MAX_ITEMS, addToEpochCarryNotice, carryLabel, carryParentVerdict, countByLink, parseEpochCarryNotice, type EpochCarryNoticeItem } from './epochCarryNotice';
import { SYNC_TABLES, syncTable } from './syncTables';

/** Y-FIX-04 (critères 12 et 15) : règle du parent remplacé tirée du catalogue, notice bornée et cumulée. */

const item = (n: number, table = 'task', column = 'project_id'): EpochCarryNoticeItem => ({ table, rowId: `row-${String(n)}`, column, parentId: 'p', space: 'pro', label: `T${String(n)}`, hlc: `h${String(n)}` as Hlc });

describe('carryParentVerdict (critère 15)', () => {
  it('chaque lien parent du catalogue est classé : facultatif → detach, obligatoire → hold ; parent présent → keep', () => {
    const links = SYNC_TABLES.flatMap((t) => t.parents.map((p) => ({ t, column: p.column })));
    expect(links.length).toBeGreaterThan(0);
    for (const { t, column } of links) {
      const nullable = t.columns.find((c) => c.name === column)?.nullable;
      expect(typeof nullable, `${t.name}.${column} : colonne absente du catalogue`).toBe('boolean');
      expect(carryParentVerdict(t, column, false), `${t.name}.${column}`).toBe(nullable ? 'detach' : 'hold');
      expect(carryParentVerdict(t, column, true), `${t.name}.${column}`).toBe('keep');
    }
  });

  it('cas attendus de la fiche, et une colonne qui n’est pas un lien parent', () => {
    const task = syncTable('task');
    const item_ = syncTable('checklist_item');
    const log = syncTable('routine_log');
    if (!task || !item_ || !log) throw new Error('catalogue');
    expect(carryParentVerdict(task, 'project_id', false)).toBe('detach');
    expect(carryParentVerdict(task, 'goal_id', false)).toBe('detach');
    expect(carryParentVerdict(task, 'recurrence_id', false)).toBe('detach');
    expect(carryParentVerdict(task, 'space_id', false)).toBe('hold');
    expect(carryParentVerdict(item_, 'checklist_id', false)).toBe('hold');
    expect(carryParentVerdict(log, 'routine_id', false)).toBe('hold');
    expect(carryParentVerdict(task, 'title', false)).toBeNull();
  });
});

describe('notice locale (critère 12)', () => {
  it('200 items gardés, le 201e compté dans overflow ; un même item jamais compté deux fois', () => {
    const two = Array.from({ length: EPOCH_CARRY_NOTICE_MAX_ITEMS }, (_, i) => item(i));
    const full = addToEpochCarryNotice(null, { epoch: 'e1', at: 'a', reattached: two, held: [] });
    expect(full.reattached).toHaveLength(200);
    expect(full.overflow).toBe(0);
    const over = addToEpochCarryNotice(full, { epoch: 'e2', at: 'b', reattached: [item(200), item(0)], held: [] });
    expect(over.reattached).toHaveLength(200);
    expect(over.overflow).toBe(1);
    expect(over.epoch).toBe('e2');
  });

  it('les reports successifs se cumulent ; listes indépendantes ; relecture contrôlée', () => {
    const first = addToEpochCarryNotice(null, { epoch: 'e1', at: 'a', reattached: [item(1)], held: [item(2, 'checklist_item', 'checklist_id')] });
    const second = addToEpochCarryNotice(first, { epoch: 'e2', at: 'b', reattached: [item(3)], held: [] });
    expect(second.reattached.map((i) => i.rowId)).toEqual(['row-1', 'row-3']);
    expect(second.held.map((i) => i.rowId)).toEqual(['row-2']);
    expect(parseEpochCarryNotice(JSON.stringify(second))).toEqual(second);
    expect(parseEpochCarryNotice('{"v":2}')).toBeNull();
    expect(parseEpochCarryNotice('pas du json')).toBeNull();
    expect(parseEpochCarryNotice(null)).toBeNull();
  });

  it('libellé local et comptes par lien', () => {
    expect(carryLabel(new Map([['title', 'Tâche']]))).toBe('Tâche');
    expect(carryLabel(new Map([['text', 'Élément']]))).toBe('Élément');
    expect(carryLabel(new Map([['date', '2026-10-05']]))).toBeNull();
    expect(countByLink([item(1), item(2), item(3, 'checklist_item', 'checklist_id')])).toEqual([
      { table: 'task', column: 'project_id', count: 2 },
      { table: 'checklist_item', column: 'checklist_id', count: 1 },
    ]);
  });
});
