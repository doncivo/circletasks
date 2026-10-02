import { describe, expect, it } from 'vitest';
import { moveTaskToDate } from './taskMove';
import { asLocalDate, type LocalDate } from './types';

const d = asLocalDate;
const task = { date: d('2026-09-23'), someday: false, sortOrder: 100 };

describe('moveTaskToDate (S-02 critères 1, 2, 10)', () => {
  it('change la date, lève « Un jour » et efface le badge « reportée »', () => {
    const result = moveTaskToDate(task, d('2026-09-24'), null);
    expect(result).toEqual({ ok: true, value: { date: '2026-09-24', someday: false, carriedOver: false, sortOrder: 100 } });
  });

  it('prend la fin de l’ordre manuel du jour d’arrivée', () => {
    const result = moveTaskToDate(task, d('2026-09-24'), 500);
    expect(result).toMatchObject({ ok: true, value: { sortOrder: 501 } });
  });

  it('garde son ordre s’il dépasse déjà celui du jour d’arrivée', () => {
    expect(moveTaskToDate({ ...task, sortOrder: 900 }, d('2026-09-24'), 500)).toMatchObject({ ok: true, value: { sortOrder: 900 } });
  });

  it('refuse le même jour (le réordonnancement passe par A-02) et une date invalide', () => {
    expect(moveTaskToDate(task, d('2026-09-23'), null)).toEqual({ ok: false, error: 'same-day' });
    expect(moveTaskToDate(task, '2026-02-31x' as LocalDate, null)).toEqual({ ok: false, error: 'invalid-date' });
  });

  it('planifie une tâche « Un jour » même si sa date est vide', () => {
    expect(moveTaskToDate({ date: null, someday: true, sortOrder: 1 }, d('2026-09-24'), null)).toMatchObject({ ok: true, value: { date: '2026-09-24', someday: false } });
  });
});
