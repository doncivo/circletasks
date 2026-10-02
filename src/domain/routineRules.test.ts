import { describe, expect, it } from 'vitest';
import type { RoutineFields } from './model';
import {
  clampInterval,
  intervalBounds,
  normalizeWeekdays,
  ROUTINE_TITLE_MAX_LENGTH,
  validateRoutine,
} from './routineRules';
import { d, makeRoutine, time } from './routineTestKit';
import type { Weekday } from './types';

function fields(overrides: Partial<RoutineFields> = {}): RoutineFields {
  const { id: _id, createdAt: _c, updatedAt: _u, deletedAt: _d, deviceId: _v, hlc: _h, ...base } = makeRoutine();
  return { ...base, ...overrides };
}

describe('validateRoutine (R-01, R-02, R-07)', () => {
  it('nettoie le titre et accepte une routine quotidienne', () => {
    const result = validateRoutine(fields({ title: '  Boire de l’eau  ' }));
    expect(result).toMatchObject({ ok: true, value: { title: 'Boire de l’eau', scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null } });
  });

  it('refuse un titre vide ou fait d’espaces, accepte 1 et 200 caractères, refuse 201', () => {
    expect(validateRoutine(fields({ title: '' }))).toEqual({ ok: false, error: 'empty-title' });
    expect(validateRoutine(fields({ title: '   ' }))).toEqual({ ok: false, error: 'empty-title' });
    expect(validateRoutine(fields({ title: 'a' })).ok).toBe(true);
    expect(validateRoutine(fields({ title: 'a'.repeat(ROUTINE_TITLE_MAX_LENGTH) })).ok).toBe(true);
    expect(validateRoutine(fields({ title: 'a'.repeat(ROUTINE_TITLE_MAX_LENGTH + 1) }))).toEqual({ ok: false, error: 'title-too-long' });
  });

  it('« Jours choisis » exige au moins un jour, trié et sans doublon', () => {
    expect(validateRoutine(fields({ scheduleType: 'weekdays', weekdays: [] }))).toEqual({ ok: false, error: 'weekdays-required' });
    const ok = validateRoutine(fields({ scheduleType: 'weekdays', weekdays: [5, 1, 3, 1] }));
    expect(ok).toMatchObject({ ok: true, value: { weekdays: [1, 3, 5] } });
  });

  it('« X fois par semaine » : X de 1 à 7, aucun jour retenu', () => {
    expect(validateRoutine(fields({ scheduleType: 'x_per_week', timesPerWeek: 0 }))).toEqual({ ok: false, error: 'times-per-week-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'x_per_week', timesPerWeek: 8 }))).toEqual({ ok: false, error: 'times-per-week-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'x_per_week', timesPerWeek: null }))).toEqual({ ok: false, error: 'times-per-week-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'x_per_week', timesPerWeek: 2.5 }))).toEqual({ ok: false, error: 'times-per-week-invalid' });
    const ok = validateRoutine(fields({ scheduleType: 'x_per_week', timesPerWeek: 3, weekdays: [1, 2] as Weekday[] }));
    expect(ok).toMatchObject({ ok: true, value: { timesPerWeek: 3, weekdays: [] } });
  });

  it('tous les N jours : N de 2 à 30 ; toutes les N semaines : N de 2 à 8 et jours obligatoires (QB-04)', () => {
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: 1 }))).toEqual({ ok: false, error: 'interval-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: 31 }))).toEqual({ ok: false, error: 'interval-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: null }))).toEqual({ ok: false, error: 'interval-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: 2 })).ok).toBe(true);
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: 30 })).ok).toBe(true);
    expect(validateRoutine(fields({ scheduleType: 'every_n_weeks', interval: 9, weekdays: [1] }))).toEqual({ ok: false, error: 'interval-invalid' });
    expect(validateRoutine(fields({ scheduleType: 'every_n_weeks', interval: 8, weekdays: [1] })).ok).toBe(true);
    expect(validateRoutine(fields({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [] }))).toEqual({ ok: false, error: 'weekdays-required' });
    expect(validateRoutine(fields({ scheduleType: 'every_n_days', interval: 3, weekdays: [1] as Weekday[] }))).toMatchObject({ ok: true, value: { weekdays: [], interval: 3 } });
  });

  it('refuse un type, une icône, une date et une heure invalides', () => {
    expect(validateRoutine(fields({ scheduleType: 'monthly' as never }))).toEqual({ ok: false, error: 'schedule-type-invalid' });
    expect(validateRoutine(fields({ icon: { kind: 'lucide', name: 'inconnue' } }))).toEqual({ ok: false, error: 'icon-invalid' });
    expect(validateRoutine(fields({ icon: { kind: 'emoji', value: '💧' } })).ok).toBe(true);
    expect(validateRoutine(fields({ startDate: '2026-02-30' as never }))).toEqual({ ok: false, error: 'start-date-invalid' });
    expect(validateRoutine(fields({ time: '24:00' as never }))).toEqual({ ok: false, error: 'time-invalid' });
    expect(validateRoutine(fields({ time: time('07:30'), startDate: d('2026-09-23') })).ok).toBe(true);
  });
});

describe('bornes de N et jours', () => {
  it('intervalBounds', () => {
    expect(intervalBounds('every_n_days')).toEqual({ min: 2, max: 30 });
    expect(intervalBounds('every_n_weeks')).toEqual({ min: 2, max: 8 });
    expect(intervalBounds('daily')).toBeNull();
  });

  it('clampInterval ramène N dans la plage (passage jours -> semaines : 8 au plus)', () => {
    expect(clampInterval('every_n_weeks', 12)).toBe(8);
    expect(clampInterval('every_n_weeks', 5)).toBe(5);
    expect(clampInterval('every_n_days', 1)).toBe(2);
    expect(clampInterval('every_n_days', 45)).toBe(30);
  });

  it('normalizeWeekdays écarte les valeurs hors 1 à 7', () => {
    expect(normalizeWeekdays([7, 0, 3, 8, 3])).toEqual([3, 7]);
  });
});
