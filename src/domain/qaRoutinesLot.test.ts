import { describe, expect, it } from 'vitest';
import { plannedDates } from './routineSchedule';
import { computeStreaks } from './routineStreaks';
import { d, doneSet, makeRoutine } from './routineTestKit';

describe('QA lot R : tous les N jours à cheval sur fin de mois et changement d’heure (R-07 critères 4, 7, 9)', () => {
  it('R-07 tous les 3 jours depuis le 28 févr. : 28 févr., 3, 6, 9 mars, puis 27 mars, 30 mars (DST 29 mars) sans décalage', () => {
    const r = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2026-02-28') });
    expect(plannedDates(r, d('2026-02-28'), d('2026-03-09'))).toEqual(['2026-02-28', '2026-03-03', '2026-03-06', '2026-03-09']);
    expect(plannedDates(r, d('2026-03-24'), d('2026-04-02'))).toEqual(['2026-03-24', '2026-03-27', '2026-03-30', '2026-04-02']);
  });

  it('R-07 tous les 30 jours depuis le 31 janv. : 2 mars puis 1er avril (pas de dérive de fin de mois)', () => {
    const r = makeRoutine({ scheduleType: 'every_n_days', interval: 30, startDate: d('2026-01-31') });
    expect(plannedDates(r, d('2026-01-31'), d('2026-04-15'))).toEqual(['2026-01-31', '2026-03-02', '2026-04-01']);
  });

  it('R-07/R-04 série tous les 3 jours à travers le 31 oct. -> 1er nov. et le 25 oct. (heure d’hiver) : 4 séances, jours intermédiaires sans effet', () => {
    const r = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2026-10-22') });
    const done = doneSet('2026-10-22', '2026-10-25', '2026-10-28', '2026-10-31');
    expect(computeStreaks(r, done, d('2026-11-01'))).toEqual({ current: 4, best: 4, unit: 'sessions' });
    expect(computeStreaks(r, done, d('2026-11-03'))).toMatchObject({ current: 4 });
    expect(computeStreaks(r, done, d('2026-11-04'))).toMatchObject({ current: 0, best: 4 });
  });

  it('R-07 toutes les 3 semaines mardi + jeudi depuis une date de départ (QB-04)', () => {
    const r = makeRoutine({ scheduleType: 'every_n_weeks', interval: 3, weekdays: [2, 4], startDate: d('2026-09-22') });
    expect(plannedDates(r, d('2026-09-21'), d('2026-11-06'))).toEqual(['2026-09-22', '2026-09-24', '2026-10-13', '2026-10-15', '2026-11-03', '2026-11-05']);
  });
});

describe('QA lot R : pause et série (R-04 critère 5)', () => {
  it('R-04 critère 5 : domaine, la pause fournie à computeStreaks ne casse pas la série', () => {
    const r = makeRoutine({ startDate: d('2026-09-01') });
    const done = doneSet('2026-09-20', '2026-09-21', '2026-09-27', '2026-09-28');
    const pauses = [{ from: d('2026-09-22'), to: d('2026-09-26') }];
    expect(computeStreaks(r, done, d('2026-09-29'), pauses).current).toBe(4);
  });
});
