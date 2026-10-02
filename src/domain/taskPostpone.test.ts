import { describe, expect, it } from 'vitest';
import { nextDayFrom, nextWeekFrom, postponeTask, resolvePostponeDate } from './taskPostpone';
import { addDays } from './localDate';
import { asLocalDate, asLocalTime } from './types';

const d = asLocalDate;

describe('nextDayFrom (T-05, Q4)', () => {
  it('ajoute un jour, fin de mois et fin d’année comprises', () => {
    expect(nextDayFrom(d('2026-09-23'))).toBe('2026-09-24');
    expect(nextDayFrom(d('2026-09-30'))).toBe('2026-10-01');
    expect(nextDayFrom(d('2026-12-31'))).toBe('2027-01-01');
    expect(nextDayFrom(d('2028-02-28'))).toBe('2028-02-29');
    expect(nextDayFrom(d('2026-02-28'))).toBe('2026-03-01');
  });
  it('traverse les changements d’heure sans décalage', () => {
    expect(addDays(d('2026-03-28'), 1)).toBe('2026-03-29');
    expect(addDays(d('2026-03-29'), 1)).toBe('2026-03-30');
    expect(addDays(d('2026-10-24'), 2)).toBe('2026-10-26');
  });
});

describe('nextWeekFrom (T-05, Q4)', () => {
  it('donne le lundi de la semaine suivante pour chaque jour de la semaine', () => {
    // 2026-09-21 est un lundi.
    expect(nextWeekFrom(d('2026-09-21'))).toBe('2026-09-28');
    expect(nextWeekFrom(d('2026-09-23'))).toBe('2026-09-28'); // mercredi
    expect(nextWeekFrom(d('2026-09-26'))).toBe('2026-09-28'); // samedi
    expect(nextWeekFrom(d('2026-09-27'))).toBe('2026-09-28'); // dimanche
  });
  it('franchit fin de mois et fin d’année', () => {
    expect(nextWeekFrom(d('2026-12-30'))).toBe('2027-01-04');
    expect(nextWeekFrom(d('2026-10-01'))).toBe('2026-10-05');
  });
});

describe('postponeTask (T-05)', () => {
  const today = d('2026-09-23');
  const friday = { date: d('2026-09-25'), time: asLocalTime('10:00'), someday: false, status: 'todo' } as const;

  it('« Demain » part d’aujourd’hui, jamais de la date de la tâche, et garde l’heure', () => {
    expect(postponeTask(friday, today, 'tomorrow')).toEqual({
      ok: true,
      value: { date: '2026-09-24', time: '10:00', someday: false },
    });
  });
  it('« Semaine prochaine » donne le lundi suivant, heure conservée', () => {
    expect(postponeTask(friday, today, 'next-week')).toEqual({
      ok: true,
      value: { date: '2026-09-28', time: '10:00', someday: false },
    });
  });
  it('applique la date choisie ; une tâche sans heure reste sans heure', () => {
    expect(postponeTask({ ...friday, time: null }, today, { date: d('2026-11-02') })).toEqual({
      ok: true,
      value: { date: '2026-11-02', time: null, someday: false },
    });
  });
  it('planifie une tâche « Un jour » (levée du drapeau)', () => {
    const someday = { date: null, time: null, someday: true, status: 'todo' } as const;
    expect(postponeTask(someday, today, 'tomorrow')).toEqual({
      ok: true,
      value: { date: '2026-09-24', time: null, someday: false },
    });
  });
  it('refuse une tâche terminée (critère 9) et une date inexistante', () => {
    expect(postponeTask({ ...friday, status: 'done' }, today, 'tomorrow')).toEqual({ ok: false, error: 'already-done' });
    expect(resolvePostponeDate(today, { date: '2026-02-30' as never })).toEqual({ ok: false, error: 'invalid-date' });
  });
});
