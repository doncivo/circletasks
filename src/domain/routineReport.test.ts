import { describe, expect, it } from 'vitest';
import { addDays } from './localDate';
import { completionRate, formatPercent, monthAggregate, monthHeatmap, monthRate, rateBetween } from './routineReport';
import { OPEN_PAUSE_END, pausesByRoutine } from './routineSchedule';
import { d, doneSet, makeRoutine } from './routineTestKit';
import type { LocalDate, RoutineId } from './types';

function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = d(from); date <= d(to); date = addDays(date, 1)) out.push(date);
  return out;
}

describe('completionRate (R-06 critères 1 et 2)', () => {
  // Sport lun., mer., ven. ; aujourd'hui = dim. 27 sept. 2026.
  const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2026-01-01') });
  const today = d('2026-09-27');

  it('2 validations sur 3 jours prévus sur 7 jours : 67 %', () => {
    // 7 jours : lun. 21 -> dim. 27 ; prévus lun. 21, mer. 23, ven. 25.
    const rate = completionRate(sport, doneSet('2026-09-21', '2026-09-25'), today, 7);
    expect(rate).toEqual({ planned: 3, done: 2, percent: 67 });
    expect(formatPercent(rate)).toBe('67 %');
  });

  it('l’occurrence du jour n’entre au dénominateur que si elle est validée', () => {
    // Aujourd'hui = ven. 25 : prévu. Non validé : 2 prévus (lun., mer.), validé : 3.
    const friday = d('2026-09-25');
    expect(completionRate(sport, doneSet('2026-09-21', '2026-09-23'), friday, 7)).toEqual({ planned: 2, done: 2, percent: 100 });
    expect(completionRate(sport, doneSet('2026-09-21', '2026-09-23', '2026-09-25'), friday, 7)).toMatchObject({ planned: 3, done: 3, percent: 100 });
    expect(completionRate(sport, doneSet('2026-09-21', '2026-09-25'), friday, 7)).toMatchObject({ planned: 3, done: 2, percent: 67 });
  });

  it('jours avant la date de départ exclus : routine créée il y a 10 jours', () => {
    const daily = makeRoutine({ startDate: d('2026-09-17') }); // créée il y a 10 jours (aujourd'hui 27 sept.)
    const done = doneSet(...range('2026-09-17', '2026-09-26'));
    // 30 et 90 jours ne comptent que 11 jours (17 -> 27) ; aujourd'hui non validé ne compte pas : 10 jours prévus.
    expect(completionRate(daily, done, today, 30)).toEqual({ planned: 10, done: 10, percent: 100 });
    expect(completionRate(daily, done, today, 90)).toEqual({ planned: 10, done: 10, percent: 100 });
    expect(completionRate(daily, doneSet(...range('2026-09-17', '2026-09-21')), today, 30)).toMatchObject({ planned: 10, done: 5, percent: 50 });
  });

  it('aucun jour prévu : « — » (pourcentage nul)', () => {
    const future = makeRoutine({ startDate: d('2026-10-05') });
    const rate = completionRate(future, doneSet(), today, 7);
    expect(rate).toEqual({ planned: 0, done: 0, percent: null });
    expect(formatPercent(rate)).toBe('—');
    expect(completionRate(makeRoutine({ startDate: today }), doneSet(), today, 7).percent).toBeNull(); // créée aujourd'hui, pas encore validée
  });

  it('arrondi à l’entier (1/3 = 33 %, 2/3 = 67 %, 1/8 = 13 %)', () => {
    const daily = makeRoutine({ startDate: d('2026-01-01') });
    expect(completionRate(daily, doneSet('2026-09-21'), d('2026-09-23'), 4).percent).toBe(33);
    expect(completionRate(daily, doneSet('2026-09-21', '2026-09-22'), d('2026-09-23'), 4).percent).toBe(67);
    expect(completionRate(daily, doneSet('2026-09-20'), d('2026-09-27'), 9).percent).toBe(13);
  });

  it('jours de pause et jours non prévus exclus', () => {
    const daily = makeRoutine({ startDate: d('2026-01-01') });
    const pauses = [{ from: d('2026-09-22'), to: d('2026-09-24') }];
    // 7 jours : 21 -> 27 ; pause 22-24 : 4 jours prévus (21, 25, 26 + 27 non validé exclu) = 3.
    expect(completionRate(daily, doneSet('2026-09-21', '2026-09-25'), today, 7, pauses)).toEqual({ planned: 3, done: 2, percent: 67 });
    // Un jour non prévu validé n'est pas compté.
    expect(completionRate(sport, doneSet('2026-09-22', '2026-09-21'), today, 7)).toMatchObject({ done: 1 });
  });

  it('« X fois par semaine » : quota par semaine, validations plafonnées', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-01-01') });
    // Semaine du 21 au 27 : 3 validations sur un quota de 3 = 100 %.
    expect(completionRate(three, doneSet('2026-09-21', '2026-09-22', '2026-09-23'), today, 7)).toEqual({ planned: 3, done: 3, percent: 100 });
    // 2 sur 3.
    expect(completionRate(three, doneSet('2026-09-21', '2026-09-22'), today, 7)).toMatchObject({ planned: 3, done: 2, percent: 67 });
    // 5 validations : plafonnées au quota.
    expect(completionRate(three, doneSet(...range('2026-09-21', '2026-09-25')), today, 7)).toMatchObject({ done: 3, percent: 100 });
    // 14 jours = deux semaines.
    expect(completionRate(three, doneSet('2026-09-14', '2026-09-15', '2026-09-16', '2026-09-21'), today, 14)).toMatchObject({ planned: 6, done: 4 });
    // Fenêtre plus courte que le quota : plafonné aux jours disponibles (créée aujourd'hui, 1 jour).
    const fresh = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: today });
    expect(completionRate(fresh, doneSet('2026-09-27'), today, 7)).toEqual({ planned: 1, done: 1, percent: 100 });
    expect(completionRate(fresh, doneSet(), today, 7).percent).toBeNull();
    // X sans valeur : 0 prévu.
    expect(completionRate(makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: null }), doneSet(), today, 7).percent).toBeNull();
  });

  it('rateBetween : bornes inversées ou futures', () => {
    expect(rateBetween(sport, doneSet(), d('2026-09-30'), d('2026-09-27'), today)).toMatchObject({ percent: null });
    expect(rateBetween(sport, doneSet(), d('2026-10-01'), d('2026-10-31'), today)).toMatchObject({ percent: null }); // mois futur
  });

  it('taux du mois : jusqu’à aujourd’hui', () => {
    const daily = makeRoutine({ startDate: d('2026-09-01') });
    // Du 1er au 26 sept. : 26 jours, 20 validés.
    const done = doneSet(...range('2026-09-01', '2026-09-20'));
    expect(monthRate(daily, done, 2026, 9, today)).toEqual({ planned: 26, done: 20, percent: 77 });
    expect(monthRate(daily, done, 2026, 8, today).percent).toBeNull(); // avant le départ
    expect(monthRate(daily, done, 2026, 10, today).percent).toBeNull(); // futur
  });

  it('90 jours sur 3 ans d’historique : en moins de 50 ms (critère 8)', () => {
    const daily = makeRoutine({ startDate: d('2023-09-01') });
    const done = doneSet(...range('2023-09-01', '2026-09-26').filter((_, i) => i % 3 !== 0));
    const start = performance.now();
    for (const days of [7, 30, 90]) completionRate(daily, done, today, days);
    const quota = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2023-09-01') });
    for (const days of [7, 30, 90]) completionRate(quota, done, today, days);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('monthHeatmap (R-06 critère 3)', () => {
  const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2026-01-01') });
  const today = d('2026-09-23'); // mercredi

  it('septembre 2026 : 30 cases, 1er septembre = mardi (1 case vide avant)', () => {
    const map = monthHeatmap(sport, doneSet(), 2026, 9, today);
    expect(map.cells).toHaveLength(30);
    expect(map.leadingBlanks).toBe(1);
    expect(map.cells[0]).toMatchObject({ date: '2026-09-01', day: 1 });
  });

  it('validé, prévu non fait, prévu à venir, non prévu, aujourd’hui', () => {
    const map = monthHeatmap(sport, doneSet('2026-09-07', '2026-09-21'), 2026, 9, today);
    const state = (day: number) => map.cells[day - 1]?.state;
    expect(state(7)).toBe('done'); // lundi validé
    expect(state(9)).toBe('missed'); // mercredi prévu non fait
    expect(state(8)).toBe('none'); // mardi non prévu
    expect(state(23)).toBe('upcoming'); // aujourd'hui, prévu, non validé
    expect(map.cells[22]?.isToday).toBe(true);
    expect(state(25)).toBe('upcoming'); // vendredi à venir
    expect(state(24)).toBe('none'); // jeudi non prévu
    expect(map.cells.filter((cell) => cell.isToday)).toHaveLength(1);
  });

  it('aujourd’hui validé est « validé » avec le repère d’aujourd’hui', () => {
    const map = monthHeatmap(sport, doneSet('2026-09-23'), 2026, 9, today);
    expect(map.cells[22]).toMatchObject({ state: 'done', isToday: true });
  });

  it('jours avant le départ : non prévus ; pause : non prévus ; validation sur un jour non prévu : validé', () => {
    const late = makeRoutine({ startDate: d('2026-09-15') });
    const map = monthHeatmap(late, doneSet('2026-09-10'), 2026, 9, today);
    expect(map.cells[13]?.state).toBe('none'); // 14 sept. avant le départ
    expect(map.cells[9]?.state).toBe('done'); // 10 sept. : validé malgré tout
    expect(map.cells[14]?.state).toBe('missed'); // 15 sept.
    const paused = monthHeatmap(makeRoutine({ startDate: d('2026-01-01') }), doneSet(), 2026, 9, today, [{ from: d('2026-09-10'), to: d('2026-09-12') }]);
    expect(paused.cells[9]?.state).toBe('none');
    expect(paused.cells[12]?.state).toBe('missed');
  });

  it('« X fois par semaine » : seuls les jours validés sont marqués', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-01-01') });
    const map = monthHeatmap(three, doneSet('2026-09-08'), 2026, 9, today);
    expect(map.cells.filter((cell) => cell.state === 'done')).toHaveLength(1);
    expect(map.cells.some((cell) => cell.state === 'missed' || cell.state === 'upcoming')).toBe(false);
  });

  it('mois de 28, 29, 31 jours et 1er jour dimanche (6 cases vides)', () => {
    const daily = makeRoutine({ startDate: d('2020-01-01') });
    expect(monthHeatmap(daily, doneSet(), 2026, 2, today).cells).toHaveLength(28);
    expect(monthHeatmap(daily, doneSet(), 2028, 2, d('2028-03-01')).cells).toHaveLength(29);
    expect(monthHeatmap(daily, doneSet(), 2026, 10, today).cells).toHaveLength(31);
    // 1er novembre 2026 : dimanche.
    expect(monthHeatmap(daily, doneSet(), 2026, 11, today).leadingBlanks).toBe(6);
    // Mois courant du changement d'heure : toujours 31 jours en octobre, 31 en mars.
    expect(monthHeatmap(daily, doneSet(), 2026, 3, today).cells).toHaveLength(31);
  });

  it('mois futur : prévu à venir ; mois passé sans validation : prévu non fait', () => {
    const daily = makeRoutine({ startDate: d('2026-01-01') });
    expect(monthHeatmap(daily, doneSet(), 2026, 10, today).cells.every((cell) => cell.state === 'upcoming')).toBe(true);
    expect(monthHeatmap(daily, doneSet(), 2026, 8, today).cells.every((cell) => cell.state === 'missed')).toBe(true);
  });
});

describe('pausesByRoutine', () => {
  it('regroupe les périodes par routine, pause ouverte sans fin, supprimées ignorées', () => {
    const r = makeRoutine();
    const base = { routineId: r.id, createdAt: 'z', updatedAt: 'z', deviceId: 'd', hlc: 'h' };
    const map = pausesByRoutine([
      { ...base, id: 'p1', fromDate: d('2026-09-01'), toDate: d('2026-09-05'), deletedAt: null } as never,
      { ...base, id: 'p2', fromDate: d('2026-09-20'), toDate: null, deletedAt: null } as never,
      { ...base, id: 'p3', fromDate: d('2026-08-01'), toDate: d('2026-08-02'), deletedAt: 'x' } as never,
    ]);
    expect(map.get(r.id)).toEqual([{ from: '2026-09-01', to: '2026-09-05' }, { from: '2026-09-20', to: OPEN_PAUSE_END }]);
  });
});

describe('monthAggregate (Rapport.html, ROUTINES — JOURS COMPLÉTÉS)', () => {
  const today = d('2026-09-23');
  const lit = makeRoutine({ title: 'Faire mon lit', startDate: d('2026-01-01') });
  const sport = makeRoutine({ title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2026-01-01') });

  const doneBy = (...entries: [{ id: unknown }, string[]][]) => new Map(entries.map(([routine, dates]) => [routine.id as RoutineId, doneSet(...dates)]));

  it('tout validé, partiel, manqué, à venir, rien de prévu', () => {
    const doneByRoutine = doneBy([lit, ['2026-09-07', '2026-09-09']], [sport, ['2026-09-07']]);
    const map = monthAggregate([lit, sport], doneByRoutine, 2026, 9, today);
    const cell = (day: number) => map.cells[day - 1];
    expect(cell(7)).toMatchObject({ state: 'all', planned: 2, done: 2 }); // lundi : lit + sport validés
    expect(cell(9)).toMatchObject({ state: 'partial', planned: 2, done: 1 }); // mercredi : lit seul
    expect(cell(8)).toMatchObject({ state: 'missed', planned: 1, done: 0 }); // mardi : lit manqué, sport non prévu
    expect(cell(25)).toMatchObject({ state: 'upcoming' });
    expect(cell(23)).toMatchObject({ isToday: true, state: 'upcoming' });
    expect(map.leadingBlanks).toBe(1);
    expect(map.cells).toHaveLength(30);
  });

  it('aucune routine : aucun jour prévu', () => {
    const map = monthAggregate([], new Map<RoutineId, Set<LocalDate>>(), 2026, 9, today);
    expect(map.cells.every((cell) => cell.state === 'none')).toBe(true);
  });

  it('routine archivée : seules ses validations comptent (R-05 critère 6) ; routine en pause : jours de pause exclus', () => {
    const archived = makeRoutine({ title: 'Ancienne', archived: true, startDate: d('2026-01-01') });
    const paused = makeRoutine({ title: 'En pause', paused: true, startDate: d('2026-01-01') });
    const doneByRoutine = doneBy([archived, ['2026-09-02']], [paused, ['2026-09-02', '2026-09-03']]);
    const pauses = new Map<RoutineId, { from: LocalDate; to: LocalDate }[]>([[paused.id as RoutineId, [{ from: d('2026-09-04'), to: d('9999-12-31') }]]]);
    const map = monthAggregate([archived, paused], doneByRoutine, 2026, 9, today, pauses);
    expect(map.cells[0]).toMatchObject({ state: 'missed', planned: 1, done: 0 }); // 1er sept. : prévu avant la pause
    expect(map.cells[1]).toMatchObject({ state: 'all', planned: 2, done: 2 });
    expect(map.cells[2]).toMatchObject({ state: 'all', planned: 1, done: 1 });
    expect(map.cells[3]?.state).toBe('none'); // pause : aucun jour prévu
  });

  it('« X fois par semaine » : un jour validé compte comme prévu et fait ; supprimée ignorée', () => {
    const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-01-01') });
    const gone = makeRoutine({ deletedAt: '2026-09-01T00:00:00.000Z' as never });
    const doneByRoutine = doneBy([three, ['2026-09-08']], [gone, ['2026-09-08']]);
    const map = monthAggregate([three, gone], doneByRoutine, 2026, 9, today);
    expect(map.cells[7]).toMatchObject({ state: 'all', planned: 1, done: 1 });
    expect(map.cells[8]?.state).toBe('none');
  });

  it('mois à cheval sur un changement d’heure : 31 jours', () => {
    expect(monthAggregate([lit], new Map<RoutineId, Set<LocalDate>>(), 2026, 10, today).cells).toHaveLength(31);
  });
});
