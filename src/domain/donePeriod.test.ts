import { describe, expect, it } from 'vitest';
import { asLocalDate as d, type IsoDateTime } from './types';
import type { Task } from './model';
import {
  donePeriodInstants,
  donePeriodOf,
  groupDoneByDay,
  isInDonePeriod,
  localDateOfInstant,
  localMidnightIso,
  localTimeOfInstant,
  shiftDonePeriod,
} from './donePeriod';

/** Instant UTC d'une heure locale de l'appareil. */
const iso = (local: string) => new Date(local).toISOString() as IsoDateTime;

function task(id: string, doneAt: string | null, extra: Partial<Task> = {}): Task {
  return { id, status: doneAt ? 'done' : 'todo', doneAt: doneAt ? iso(doneAt) : null, deletedAt: null, ...extra } as unknown as Task;
}

describe('périodes de tâches terminées (T-07)', () => {
  it('jour : une seule date', () => {
    expect(donePeriodOf('day', d('2026-09-23'))).toEqual({ kind: 'day', from: '2026-09-23', to: '2026-09-23' });
  });

  it('semaine : du lundi au dimanche, quel que soit le jour d’ancrage', () => {
    for (const day of ['2026-09-21', '2026-09-23', '2026-09-27']) {
      expect(donePeriodOf('week', d(day))).toEqual({ kind: 'week', from: '2026-09-21', to: '2026-09-27' });
    }
    expect(donePeriodOf('week', d('2026-09-28')).from).toBe('2026-09-28');
  });

  it('mois civil, février bissextile compris', () => {
    expect(donePeriodOf('month', d('2026-09-23'))).toEqual({ kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    expect(donePeriodOf('month', d('2028-02-10')).to).toBe('2028-02-29');
    expect(donePeriodOf('month', d('2026-02-10')).to).toBe('2026-02-28');
  });

  it('précédent / suivant : un jour, une semaine, un mois (passage d’année)', () => {
    expect(shiftDonePeriod(donePeriodOf('day', d('2026-10-01')), -1).from).toBe('2026-09-30');
    expect(shiftDonePeriod(donePeriodOf('week', d('2026-09-23')), 1)).toMatchObject({ from: '2026-09-28', to: '2026-10-04' });
    expect(shiftDonePeriod(donePeriodOf('week', d('2026-09-23')), -1)).toMatchObject({ from: '2026-09-14', to: '2026-09-20' });
    expect(shiftDonePeriod(donePeriodOf('month', d('2026-01-15')), -1)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(shiftDonePeriod(donePeriodOf('month', d('2026-12-15')), 1)).toMatchObject({ from: '2027-01-01', to: '2027-01-31' });
    expect(shiftDonePeriod(donePeriodOf('month', d('2026-03-31')), -1)).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('instants : minuit local de début, minuit local du lendemain de la fin (exclu)', () => {
    const range = donePeriodInstants(donePeriodOf('week', d('2026-09-23')));
    expect(range.from).toBe(localMidnightIso(d('2026-09-21')));
    expect(range.to).toBe(localMidnightIso(d('2026-09-28')));
  });

  it('conversion d’un instant en date et heure locales', () => {
    const at = iso('2026-09-23T18:04:00');
    expect(localDateOfInstant(at)).toBe('2026-09-23');
    expect(localTimeOfInstant(at)).toBe('18:04');
    expect(localTimeOfInstant(iso('2026-09-23T07:05:00'))).toBe('07:05');
    expect(localDateOfInstant(iso('2026-09-23T00:00:00'))).toBe('2026-09-23');
    expect(localDateOfInstant(iso('2026-09-23T23:59:59'))).toBe('2026-09-23');
  });

  it('isInDonePeriod : bornes incluses, exclut à faire et supprimées', () => {
    const week = donePeriodOf('week', d('2026-09-23'));
    expect(isInDonePeriod(task('a', '2026-09-21T00:00:00'), week)).toBe(true);
    expect(isInDonePeriod(task('b', '2026-09-27T23:59:00'), week)).toBe(true);
    expect(isInDonePeriod(task('c', '2026-09-28T00:00:00'), week)).toBe(false);
    expect(isInDonePeriod(task('d', null), week)).toBe(false);
    expect(isInDonePeriod(task('e', '2026-09-22T10:00:00', { deletedAt: '2026-09-23T00:00:00.000Z' as IsoDateTime }), week)).toBe(false);
  });

  it('groupDoneByDay : jours du plus récent au plus ancien, heures décroissantes', () => {
    const groups = groupDoneByDay([task('a', '2026-09-22T09:00:00'), task('b', '2026-09-23T08:00:00'), task('c', '2026-09-23T18:04:00')]);
    expect(groups.map((g) => g.date)).toEqual(['2026-09-23', '2026-09-22']);
    expect(groups[0]?.tasks.map((x) => x.id)).toEqual(['c', 'b']);
    expect(groupDoneByDay([])).toEqual([]);
  });

  it('groupDoneByDay : 23:59 et 00:00 tombent dans deux jours distincts', () => {
    const groups = groupDoneByDay([task('a', '2026-09-23T23:59:00'), task('b', '2026-09-24T00:00:00')]);
    expect(groups.map((g) => [g.date, g.tasks.map((x) => x.id)])).toEqual([['2026-09-24', ['b']], ['2026-09-23', ['a']]]);
  });

  it('semaine à cheval sur deux mois : incluse pour les deux mois, exclue du mois hors période', () => {
    const week = donePeriodOf('week', d('2026-09-30'));
    expect(week).toEqual({ kind: 'week', from: '2026-09-28', to: '2026-10-04' });
    expect(isInDonePeriod(task('a', '2026-09-30T12:00:00'), week)).toBe(true);
    expect(isInDonePeriod(task('b', '2026-10-01T00:00:00'), week)).toBe(true);
    expect(isInDonePeriod(task('b', '2026-10-01T00:00:00'), donePeriodOf('month', d('2026-09-30')))).toBe(false);
  });
});
