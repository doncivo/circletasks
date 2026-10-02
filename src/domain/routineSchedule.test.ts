import { describe, expect, it } from 'vitest';
import {
  canToggleDay,
  daysBetween,
  daysOfWeek,
  doneDatesOf,
  groupDoneDates,
  isActive,
  isPausedOn,
  isPlannedOn,
  isQuotaRule,
  mondayOf,
  nextOccurrences,
  plannedDates,
  quotaReached,
  routinesForDay,
  weekCounter,
  weekRounds,
} from './routineSchedule';
import { d, doneSet, makeLog, makeRoutine } from './routineTestKit';
import type { LocalDate, RoutineId } from './types';

// Semaine de référence des maquettes : lun. 21 sept. 2026 -> dim. 27 sept.
const MONDAY = d('2026-09-21');

describe('dates', () => {
  it('daysBetween et mondayOf ignorent fuseau et heure d’été', () => {
    expect(daysBetween(d('2026-09-21'), d('2026-09-24'))).toBe(3);
    expect(daysBetween(d('2026-09-24'), d('2026-09-21'))).toBe(-3);
    expect(daysBetween(d('2026-03-28'), d('2026-03-30'))).toBe(2);
    expect(daysBetween(d('2026-10-24'), d('2026-10-26'))).toBe(2);
    expect(mondayOf(d('2026-09-27'))).toBe(MONDAY);
    expect(mondayOf(MONDAY)).toBe(MONDAY);
    expect(daysOfWeek(MONDAY)).toHaveLength(7);
    expect(daysOfWeek(MONDAY)[6]).toBe('2026-09-27');
  });
});

describe('isPlannedOn', () => {
  it('tous les jours : chaque jour depuis le départ, aucun avant (R-01 critère 9)', () => {
    const routine = makeRoutine({ scheduleType: 'daily', startDate: d('2026-09-23') });
    expect(isPlannedOn(routine, d('2026-09-22'))).toBe(false);
    expect(isPlannedOn(routine, d('2026-09-23'))).toBe(true);
    expect(isPlannedOn(routine, d('2030-01-01'))).toBe(true);
  });

  it('jours choisis : lun., mer., ven.', () => {
    const routine = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    const planned = plannedDates(routine, MONDAY, d('2026-09-27'));
    expect(planned).toEqual(['2026-09-21', '2026-09-23', '2026-09-25']);
  });

  it('une pause retire les jours de la période, bornes incluses', () => {
    const routine = makeRoutine({ scheduleType: 'daily' });
    const pauses = [{ from: d('2026-09-22'), to: d('2026-09-24') }];
    expect(isPausedOn(d('2026-09-22'), pauses)).toBe(true);
    expect(isPausedOn(d('2026-09-24'), pauses)).toBe(true);
    expect(isPausedOn(d('2026-09-25'), pauses)).toBe(false);
    expect(plannedDates(routine, MONDAY, d('2026-09-26'), pauses)).toEqual(['2026-09-21', '2026-09-25', '2026-09-26']);
  });

  it('tous les 3 jours à partir du lun. 21 sept. : 21, 24, 27, 30 sept., 3 oct. (R-07 critère 4)', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: MONDAY });
    expect(plannedDates(routine, MONDAY, d('2026-10-04'))).toEqual(['2026-09-21', '2026-09-24', '2026-09-27', '2026-09-30', '2026-10-03']);
    expect(isPlannedOn(routine, d('2026-09-20'))).toBe(false);
  });

  it('tous les N jours : N = 2 et N = 30, départ dans le passé accepté', () => {
    const every2 = makeRoutine({ scheduleType: 'every_n_days', interval: 2, startDate: d('2026-01-01') });
    expect(isPlannedOn(every2, d('2026-01-03'))).toBe(true);
    expect(isPlannedOn(every2, d('2026-01-04'))).toBe(false);
    const every30 = makeRoutine({ scheduleType: 'every_n_days', interval: 30, startDate: d('2026-09-01') });
    expect(plannedDates(every30, d('2026-09-01'), d('2026-11-30'))).toEqual(['2026-09-01', '2026-10-01', '2026-10-31', '2026-11-30']);
  });

  it('toutes les 2 semaines, lundi seul : 21 sept., 5 oct., 19 oct. (R-07 critère 5)', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [1], startDate: MONDAY });
    expect(plannedDates(routine, MONDAY, d('2026-10-31'))).toEqual(['2026-09-21', '2026-10-05', '2026-10-19']);
  });

  it('toutes les 2 semaines, lundi et jeudi : 21 et 24 sept., 5 et 8 oct.', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [1, 4], startDate: MONDAY });
    expect(plannedDates(routine, MONDAY, d('2026-10-11'))).toEqual(['2026-09-21', '2026-09-24', '2026-10-05', '2026-10-08']);
  });

  it('toutes les N semaines : un jour coché avant le départ dans la semaine de départ n’est pas prévu', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [1, 4], startDate: d('2026-09-23') });
    expect(plannedDates(routine, d('2026-09-21'), d('2026-10-11'))).toEqual(['2026-09-24', '2026-10-05', '2026-10-08']);
  });

  it('toutes les 8 semaines traverse un changement d’année', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_weeks', interval: 8, weekdays: [3], startDate: d('2026-12-02') });
    expect(plannedDates(routine, d('2026-12-02'), d('2027-03-01'))).toEqual(['2026-12-02', '2027-01-27']);
  });

  it('« X fois par semaine » : tout jour depuis le départ est possible', () => {
    const routine = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-09-23') });
    expect(isPlannedOn(routine, d('2026-09-22'))).toBe(false);
    expect(isPlannedOn(routine, d('2026-09-24'))).toBe(true);
    expect(isQuotaRule(routine)).toBe(true);
    expect(isQuotaRule(makeRoutine())).toBe(false);
  });

  it('règle incohérente (interval absent, type inconnu) : jamais prévue', () => {
    expect(isPlannedOn(makeRoutine({ scheduleType: 'every_n_days', interval: null }), d('2026-09-21'))).toBe(false);
    expect(isPlannedOn(makeRoutine({ scheduleType: 'every_n_weeks', interval: null, weekdays: [1] }), d('2026-09-21'))).toBe(false);
    expect(isPlannedOn(makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [] }), d('2026-09-21'))).toBe(false);
    expect(isPlannedOn(makeRoutine({ scheduleType: 'autre' as never }), d('2026-09-21'))).toBe(false);
  });

  it('passage à l’heure d’été (29 mars) et d’hiver (25 oct.) sans décalage', () => {
    const every3 = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2026-03-26') });
    expect(plannedDates(every3, d('2026-03-26'), d('2026-04-04'))).toEqual(['2026-03-26', '2026-03-29', '2026-04-01', '2026-04-04']);
    const every3Autumn = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2026-10-22') });
    expect(plannedDates(every3Autumn, d('2026-10-22'), d('2026-11-01'))).toEqual(['2026-10-22', '2026-10-25', '2026-10-28', '2026-10-31']);
    const weekly = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [7], startDate: d('2026-03-15') });
    expect(plannedDates(weekly, d('2026-03-15'), d('2026-04-12'))).toEqual(['2026-03-15', '2026-03-29', '2026-04-12']);
    const weeklyAutumn = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [7], startDate: d('2026-10-11') });
    expect(plannedDates(weeklyAutumn, d('2026-10-11'), d('2026-11-08'))).toEqual(['2026-10-11', '2026-10-25', '2026-11-08']);
  });
});

describe('nextOccurrences (R-07 critère 3)', () => {
  it('4 prochaines fois de « tous les 3 jours » depuis le lun. 21 sept., vues du 23 sept.', () => {
    const routine = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: MONDAY });
    expect(nextOccurrences(routine, d('2026-09-23'), 4)).toEqual(['2026-09-24', '2026-09-27', '2026-09-30', '2026-10-03']);
  });

  it('part du départ si `from` est antérieur ; compte 0 ; plage vide si aucune occurrence', () => {
    const routine = makeRoutine({ scheduleType: 'daily', startDate: d('2026-10-01') });
    expect(nextOccurrences(routine, d('2026-09-01'), 2)).toEqual(['2026-10-01', '2026-10-02']);
    expect(nextOccurrences(routine, d('2026-10-01'), 0)).toEqual([]);
    const impossible = makeRoutine({ scheduleType: 'weekdays', weekdays: [] });
    expect(nextOccurrences(impossible, d('2026-10-01'), 2)).toEqual([]);
  });

  it('exclut les jours de pause', () => {
    const routine = makeRoutine({ scheduleType: 'daily' });
    expect(nextOccurrences(routine, d('2026-09-21'), 2, [{ from: d('2026-09-21'), to: d('2026-09-22') }])).toEqual(['2026-09-23', '2026-09-24']);
  });
});

describe('validations et compteur de la semaine (R-01 critères 7 et 8)', () => {
  it('doneDatesOf ignore les validations supprimées et filtre par routine', () => {
    const a = makeRoutine();
    const b = makeRoutine();
    const logs = [makeLog(a, '2026-09-21'), makeLog(a, '2026-09-22', { deletedAt: '2026-09-22T09:00:00.000Z' as never }), makeLog(b, '2026-09-23')];
    expect([...doneDatesOf(logs, a.id)]).toEqual(['2026-09-21']);
    expect(doneDatesOf(logs).size).toBe(2);
    const grouped = groupDoneDates(logs);
    expect(grouped.get(a.id)?.size).toBe(1);
    expect(grouped.get(b.id)?.has(d('2026-09-23'))).toBe(true);
  });

  it('tous les jours : 3/7 ; jours choisis : dénominateur = nombre de jours ; N jours : occurrences de la semaine', () => {
    expect(weekCounter(makeRoutine(), doneSet('2026-09-21', '2026-09-22', '2026-09-23'), MONDAY)).toEqual({ done: 3, planned: 7 });
    const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    expect(weekCounter(sport, doneSet('2026-09-21'), MONDAY)).toEqual({ done: 1, planned: 3 });
    const every3 = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: MONDAY });
    expect(weekCounter(every3, doneSet('2026-09-24'), MONDAY)).toEqual({ done: 1, planned: 3 });
  });

  it('une validation sur un jour non prévu n’est pas comptée', () => {
    const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    expect(weekCounter(sport, doneSet('2026-09-22'), MONDAY)).toEqual({ done: 0, planned: 3 });
  });

  it('semaine de création : seuls les jours depuis le départ comptent ; semaine d’avant : 0 prévu', () => {
    const routine = makeRoutine({ startDate: d('2026-09-25') });
    expect(weekCounter(routine, doneSet(), MONDAY)).toEqual({ done: 0, planned: 3 });
    expect(weekCounter(routine, doneSet(), d('2026-09-14'))).toEqual({ done: 0, planned: 0 });
  });

  it('« X fois par semaine » : dénominateur X (même la semaine de départ), validations plafonnées au quota', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3 });
    expect(weekCounter(three, doneSet('2026-09-21', '2026-09-22'), MONDAY)).toEqual({ done: 2, planned: 3 });
    expect(weekCounter(three, doneSet('2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'), MONDAY)).toEqual({ done: 3, planned: 3 });
    const late = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-09-26') });
    expect(weekCounter(late, doneSet(), MONDAY)).toEqual({ done: 0, planned: 3 });
    expect(weekCounter(late, doneSet(), d('2026-09-14'))).toEqual({ done: 0, planned: 0 });
    const noQuota = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: null });
    expect(weekCounter(noQuota, doneSet(), MONDAY).planned).toBe(0);
  });

  it('quotaReached', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3 });
    expect(quotaReached(three, doneSet('2026-09-21', '2026-09-22'), d('2026-09-24'))).toBe(false);
    expect(quotaReached(three, doneSet('2026-09-21', '2026-09-22', '2026-09-23'), d('2026-09-24'))).toBe(true);
  });
});

describe('canToggleDay et ronds (R-03 critères 10 à 12, QB-03)', () => {
  const today = d('2026-09-23'); // mercredi
  const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });

  it('aujourd’hui et jours passés prévus : oui ; jours futurs : non (même prévus)', () => {
    expect(canToggleDay(sport, doneSet(), d('2026-09-21'), today)).toBe(true); // lundi prévu non validé : rattrapage
    expect(canToggleDay(sport, doneSet(), d('2026-09-23'), today)).toBe(true);
    expect(canToggleDay(sport, doneSet(), d('2026-09-25'), today)).toBe(false);
  });

  it('jour non prévu : non, sauf s’il est déjà validé (on peut le rouvrir)', () => {
    expect(canToggleDay(sport, doneSet(), d('2026-09-22'), today)).toBe(false);
    expect(canToggleDay(sport, doneSet('2026-09-22'), d('2026-09-22'), today)).toBe(true);
  });

  it('routine en pause, archivée ou supprimée : aucun jour actif', () => {
    expect(canToggleDay({ ...sport, paused: true }, doneSet('2026-09-21'), d('2026-09-21'), today)).toBe(false);
    expect(canToggleDay({ ...sport, archived: true }, doneSet(), d('2026-09-21'), today)).toBe(false);
    expect(canToggleDay({ ...sport, deletedAt: '2026-09-22T00:00:00.000Z' as never }, doneSet(), d('2026-09-21'), today)).toBe(false);
  });

  it('« X fois par semaine » : pas de 4e validation, mais on peut rouvrir un jour validé (critère 12)', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3 });
    const done = doneSet('2026-09-21', '2026-09-22', '2026-09-23');
    expect(canToggleDay(three, doneSet('2026-09-21', '2026-09-22'), today, today)).toBe(true);
    expect(canToggleDay(three, done, d('2026-09-21'), today)).toBe(true);
    const fourDays = d('2026-09-24');
    expect(canToggleDay(three, done, fourDays, d('2026-09-27'))).toBe(false);
  });

  it('weekRounds : états des sept ronds', () => {
    const rounds = weekRounds(sport, doneSet('2026-09-21'), MONDAY, today);
    expect(rounds.map((round) => round.planned)).toEqual([true, false, true, false, true, false, false]);
    expect(rounds[0]).toMatchObject({ done: true, future: false, toggleable: true, weekday: 1 });
    expect(rounds[2]).toMatchObject({ done: false, toggleable: true });
    expect(rounds[4]).toMatchObject({ planned: true, future: true, toggleable: false });
    expect(rounds[1]?.toggleable).toBe(false);
  });
});

describe('routinesForDay (R-01 critère 11, R-03, R-05, QB-01)', () => {
  const wednesday = d('2026-09-23');
  const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], title: 'Sport' });
  const water = makeRoutine({ title: 'Eau' });

  it('liste les routines prévues le jour avec leur état ; une routine non prévue n’apparaît pas (critère 7)', () => {
    const done = groupDoneDates([makeLog(water, '2026-09-23')]);
    const entries = routinesForDay([sport, water], done, wednesday);
    expect(entries.map((entry) => [entry.routine.title, entry.done])).toEqual([['Sport', false], ['Eau', true]]);
    expect(routinesForDay([sport], done, d('2026-09-22'))).toEqual([]);
  });

  it('exclut pause, archive, suppression', () => {
    expect(isActive(sport)).toBe(true);
    const hidden = [
      makeRoutine({ paused: true }),
      makeRoutine({ archived: true }),
      makeRoutine({ deletedAt: '2026-09-01T00:00:00.000Z' as never }),
    ];
    expect(hidden.every((routine) => !isActive(routine))).toBe(true);
    expect(routinesForDay(hidden, new Map<RoutineId, Set<LocalDate>>(), wednesday)).toEqual([]);
  });

  it('3 fois par semaine, validée lundi et mardi : visible mercredi, absente jeudi-dimanche après le 3e, de retour lundi (critère 13)', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, title: '3 fois' });
    const twice = new Map<typeof three.id, Set<LocalDate>>([[three.id, doneSet('2026-09-21', '2026-09-22')]]);
    expect(routinesForDay([three], twice, wednesday)).toEqual([{ routine: three, done: false }]);

    const thrice = new Map<typeof three.id, Set<LocalDate>>([[three.id, doneSet('2026-09-21', '2026-09-22', '2026-09-23')]]);
    // Le jour du quota : validée, affichée parmi les terminés.
    expect(routinesForDay([three], thrice, wednesday)).toEqual([{ routine: three, done: true }]);
    // Jeudi à dimanche : plus affichée.
    for (const day of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) expect(routinesForDay([three], thrice, d(day))).toEqual([]);
    // Lundi suivant : de retour, non cochée.
    expect(routinesForDay([three], thrice, d('2026-09-28'))).toEqual([{ routine: three, done: false }]);
  });

  it('une routine pas encore commencée n’apparaît pas', () => {
    const future = makeRoutine({ startDate: d('2026-10-01') });
    expect(routinesForDay([future], new Map<RoutineId, Set<LocalDate>>(), wednesday)).toEqual([]);
  });
});
