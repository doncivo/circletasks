import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from './itemFilter';
import {
  buildMonthReport,
  canShowNextMonth,
  canShowPreviousMonth,
  completionPercent,
  countedRange,
  isoMondayOf,
  routinesMonthRate,
  shiftMonth,
  weeklyCompletion,
  weeksOfMonth,
  type MonthRef,
  type RoutinesMonthInput,
} from './monthReport';
import { d, doneSet, makeRoutine } from './routineTestKit';
import type { DateInterval } from './routineSchedule';
import type { IsoDateTime, LocalDate, ProjectId, RoutineId } from './types';

const SEPTEMBER: MonthRef = { year: 2026, month: 9 };
const NO_ROUTINES: RoutinesMonthInput = { routines: [], doneByRoutine: new Map<RoutineId, ReadonlySet<LocalDate>>(), pausesOf: new Map<RoutineId, readonly DateInterval[]>() };

describe('bornes de mois (H-01 critère 2)', () => {
  it('décale de mois en mois, à cheval sur les années', () => {
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(SEPTEMBER, 0)).toEqual(SEPTEMBER);
  });

  it('pas au-delà du mois courant ni avant le mois de la plus ancienne donnée', () => {
    const today = d('2026-09-23');
    expect(canShowNextMonth(SEPTEMBER, today)).toBe(false);
    expect(canShowNextMonth({ year: 2026, month: 8 }, today)).toBe(true);
    expect(canShowPreviousMonth({ year: 2026, month: 8 }, d('2026-08-31'))).toBe(false);
    expect(canShowPreviousMonth({ year: 2026, month: 9 }, d('2026-08-31'))).toBe(true);
    expect(canShowPreviousMonth(SEPTEMBER, null)).toBe(false);
  });

  it('jours comptés : jusqu’à aujourd’hui pour le mois courant, tout le mois sinon', () => {
    expect(countedRange(SEPTEMBER, d('2026-09-23'))).toEqual({ from: '2026-09-01', to: '2026-09-23' });
    expect(countedRange({ year: 2026, month: 8 }, d('2026-09-23'))).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(countedRange({ year: 2026, month: 10 }, d('2026-09-23'))).toBeNull();
  });
});

describe('completionPercent', () => {
  it('arrondi à l’entier, « — » (null) sans tâche', () => {
    expect(completionPercent(48, 61)).toBe(79);
    expect(completionPercent(5, 7)).toBe(71);
    expect(completionPercent(0, 0)).toBeNull();
    expect(completionPercent(0, 4)).toBe(0);
  });
});

describe('weeksOfMonth (H-02 critères 1 et 4)', () => {
  it('septembre 2026 consulté le 23 : S36 à S39, S39 courante', () => {
    const slots = weeksOfMonth(SEPTEMBER, d('2026-09-23'));
    expect(slots.map((slot) => slot.number)).toEqual([36, 37, 38, 39]);
    expect(slots.map((slot) => slot.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']);
    expect(slots.map((slot) => slot.isCurrent)).toEqual([false, false, false, true]);
  });

  it('mois passé : toutes les semaines qui touchent le mois (5 pour septembre)', () => {
    const slots = weeksOfMonth(SEPTEMBER, d('2026-10-04'));
    expect(slots.map((slot) => slot.number)).toEqual([36, 37, 38, 39, 40]);
    expect(slots.at(-1)?.weekEnd).toBe('2026-10-04');
  });

  it('un mois à six semaines (août 2026 commence un samedi)', () => {
    const slots = weeksOfMonth({ year: 2026, month: 8 }, d('2026-09-23'));
    expect(slots.map((slot) => slot.number)).toEqual([31, 32, 33, 34, 35, 36]);
    expect(slots[0]?.weekStart).toBe('2026-07-27');
  });

  it('un mois à quatre semaines (février 2027 : lundi 1er, 28 jours)', () => {
    expect(weeksOfMonth({ year: 2027, month: 2 }, d('2027-03-10')).map((slot) => slot.number)).toEqual([5, 6, 7, 8]);
  });

  it('numérotation ISO en fin d’année (1er janvier 2027 : S53 de 2026)', () => {
    expect(weeksOfMonth({ year: 2027, month: 1 }, d('2027-02-01'))[0]?.number).toBe(53);
  });

  it('isoMondayOf : toujours le lundi, un dimanche appartient à la semaine qui finit', () => {
    expect(isoMondayOf(d('2026-09-27'))).toBe('2026-09-21');
    expect(isoMondayOf(d('2026-09-21'))).toBe('2026-09-21');
    expect(isoMondayOf(d('2026-09-01'))).toBe('2026-08-31');
  });
});

describe('weeklyCompletion (H-02 critères 2 et 3)', () => {
  const slots = weeksOfMonth(SEPTEMBER, d('2026-09-23'));

  it('taux par semaine arrondis, semaine sans tâche à null', () => {
    const bars = weeklyCompletion(slots, [
      { weekStart: d('2026-08-31'), done: 5, total: 7 },
      { weekStart: d('2026-09-07'), done: 21, total: 25 },
      { weekStart: d('2026-09-21'), done: 0, total: 3 },
    ]);
    expect(bars.map((bar) => bar.percent)).toEqual([71, 84, null, 0]);
    expect(bars[2]).toMatchObject({ done: 0, total: 0 });
  });
});

describe('buildMonthReport (H-01 critères 3 à 7)', () => {
  const today = d('2026-09-23');
  const base = {
    month: SEPTEMBER,
    today,
    filter: ALL_ITEMS,
    firstWeekday: 'monday' as const,
    weekCounts: [
      { weekStart: d('2026-08-31'), done: 10, total: 14 },
      { weekStart: d('2026-09-07'), done: 21, total: 25 },
      { weekStart: d('2026-09-14'), done: 12, total: 15 },
      { weekStart: d('2026-09-21'), done: 5, total: 7 },
    ],
    routines: NO_ROUTINES,
    focus: { seconds: 14 * 3600 + 20 * 60, sessions: 12 },
    goals: { achieved: 2, total: 3 },
  };

  it('48 tâches faites sur 61 : la somme des barres égale la tuile, 79 %', () => {
    const report = buildMonthReport(base);
    expect(report.tasks).toEqual({ done: 48, total: 61, percent: 79 });
    expect(report.weeks.reduce((sum, bar) => sum + bar.total, 0)).toBe(report.tasks.total);
    expect(report.focus.seconds).toBe(51_600);
    expect(report.goals).toEqual({ achieved: 2, total: 3 });
    expect(report.isEmpty).toBe(false);
  });

  it('sans objectif : tuile « — » (null) ; routines sans occurrence prévue : pourcentage null', () => {
    const report = buildMonthReport({ ...base, goals: { achieved: 0, total: 0 } });
    expect(report.goals).toBeNull();
    expect(report.routines).toEqual({ planned: 0, done: 0, percent: null });
  });

  it('sous un filtre de projet, routines et objectifs disparaissent (« — »), tâches et Focus restent', () => {
    const report = buildMonthReport({ ...base, filter: { space: 'all', project: 'p1' as ProjectId } });
    expect(report.routines).toBeNull();
    expect(report.goals).toBeNull();
    expect(report.heatmap).toBeNull();
    expect(report.routineRates).toEqual([]);
    expect(report.tasks.total).toBe(61);
  });

  it('mois sans donnée : vide', () => {
    const report = buildMonthReport({ ...base, weekCounts: [], focus: { seconds: 0, sessions: 0 }, goals: { achieved: 0, total: 0 } });
    expect(report.isEmpty).toBe(true);
    expect(report.tasks).toEqual({ done: 0, total: 0, percent: null });
  });

  it('un mois avec seulement du Focus n’est pas vide', () => {
    expect(buildMonthReport({ ...base, weekCounts: [], goals: { achieved: 0, total: 0 } }).isEmpty).toBe(false);
  });
});

describe('routinesMonthRate (H-01 critère 4)', () => {
  const today = d('2026-09-23');

  it('toutes routines ensemble : prévues validées / prévues, jours futurs et jour non validé exclus', () => {
    const lit = makeRoutine({ scheduleType: 'daily', startDate: d('2026-01-01') });
    const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2026-01-01') });
    // Lit : 1er au 22 sept. prévus (22 jours), 20 validés (5 et 6 manqués) ; aujourd'hui (23) non validé : exclu.
    const litDays: LocalDate[] = [];
    for (let day = 1; day <= 22; day += 1) if (day !== 5 && day !== 6) litDays.push(d(`2026-09-${String(day).padStart(2, '0')}`));
    // Sport : lun., mer., ven. du 1er au 22 : 2, 4, 7, 9, 11, 14, 16, 18, 21 = 9 jours ; 3 validés.
    const input: RoutinesMonthInput = {
      routines: [lit, sport],
      doneByRoutine: new Map([
        [lit.id, doneSet(...litDays)],
        [sport.id, doneSet('2026-09-02', '2026-09-04', '2026-09-07')],
      ]),
      pausesOf: new Map<RoutineId, readonly DateInterval[]>(),
    };
    expect(routinesMonthRate(input, SEPTEMBER, today)).toEqual({ planned: 22 + 9, done: 20 + 3, percent: 74 });
  });

  it('une routine archivée compte par ses validations du mois ; une supprimée est ignorée', () => {
    const archived = makeRoutine({ archived: true, startDate: d('2026-01-01') });
    const deleted = makeRoutine({ deletedAt: '2026-09-02T08:00:00.000Z' as IsoDateTime });
    const input: RoutinesMonthInput = {
      routines: [archived, deleted],
      doneByRoutine: new Map([
        [archived.id, doneSet('2026-08-30', '2026-09-02', '2026-09-03')],
        [deleted.id, doneSet('2026-09-02')],
      ]),
      pausesOf: new Map<RoutineId, readonly DateInterval[]>(),
    };
    expect(routinesMonthRate(input, SEPTEMBER, today)).toEqual({ planned: 2, done: 2, percent: 100 });
  });

  it('une pause exclut ses jours du dénominateur', () => {
    const lit = makeRoutine({ scheduleType: 'daily', startDate: d('2026-01-01') });
    const input: RoutinesMonthInput = {
      routines: [lit],
      doneByRoutine: new Map([[lit.id, doneSet('2026-09-01')]]),
      pausesOf: new Map([[lit.id, [{ from: d('2026-09-02'), to: d('2026-09-22') }]]]),
    };
    expect(routinesMonthRate(input, SEPTEMBER, today)).toEqual({ planned: 1, done: 1, percent: 100 });
  });
});
