import { describe, expect, it } from 'vitest';
import { monthAggregate, monthHeatmap } from './routineReport';
import { d, doneSet, makeRoutine } from './routineTestKit';
import type { FirstWeekday } from './week';

describe('P-03 QA : carte de chaleur et agrégat selon le premier jour (critère 2)', () => {
  const daily = makeRoutine({ startDate: d('2026-01-01') });
  const today = d('2026-09-23');

  // 1er sept. 2026 = mardi ; 1er nov. 2026 = dimanche ; 1er mai 2027 = samedi.
  it.each<[FirstWeekday, number, number, number]>([
    ['monday', 1, 6, 5],
    ['sunday', 2, 0, 6],
    ['saturday', 3, 1, 0],
  ])('%s : cases vides de sept. 2026, nov. 2026 et mai 2027', (first, sept, nov, may) => {
    expect(monthHeatmap(daily, doneSet(), 2026, 9, today, [], first).leadingBlanks).toBe(sept);
    expect(monthHeatmap(daily, doneSet(), 2026, 11, today, [], first).leadingBlanks).toBe(nov);
    expect(monthHeatmap(daily, doneSet(), 2027, 5, today, [], first).leadingBlanks).toBe(may);
    expect(monthAggregate([daily], new Map(), 2026, 9, today, undefined, first).leadingBlanks).toBe(sept);
  });

  it('lundi par défaut quand le premier jour n’est pas fourni, et les états des cases ne changent pas', () => {
    const base = monthHeatmap(daily, doneSet('2026-09-07'), 2026, 9, today);
    const sunday = monthHeatmap(daily, doneSet('2026-09-07'), 2026, 9, today, [], 'sunday');
    expect(base.leadingBlanks).toBe(1);
    expect(sunday.cells).toEqual(base.cells);
  });
});
