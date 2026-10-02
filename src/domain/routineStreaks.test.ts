import { describe, expect, it } from 'vitest';
import { addDays } from './localDate';
import { computeStreaks, streakUnit } from './routineStreaks';
import { d, doneSet, makeRoutine } from './routineTestKit';
import type { LocalDate } from './types';

/** Dates de `from` à `to` incluses. */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = d(from); date <= d(to); date = addDays(date, 1)) out.push(date);
  return out;
}

describe('computeStreaks (R-04) : quotidien', () => {
  const daily = makeRoutine({ startDate: d('2026-01-01') });

  it('10 derniers jours validés, aujourd’hui non fait : série 10 ; après validation d’aujourd’hui : 11 (critère 1)', () => {
    const done = doneSet(...range('2026-09-13', '2026-09-22'));
    expect(computeStreaks(daily, done, d('2026-09-23'))).toEqual({ current: 10, best: 10, unit: 'days' });
    done.add(d('2026-09-23'));
    expect(computeStreaks(daily, done, d('2026-09-23'))).toEqual({ current: 11, best: 11, unit: 'days' });
  });

  it('une occurrence prévue passée non validée remet la série à 0 (critère 3) ; la meilleure reste', () => {
    // 5 jours validés, hier (22) manqué.
    const done = doneSet(...range('2026-09-16', '2026-09-20'), '2026-09-21');
    expect(computeStreaks(daily, done, d('2026-09-23'))).toEqual({ current: 0, best: 6, unit: 'days' });
  });

  it('la meilleure série est la plus longue suite jamais atteinte, jamais inférieure à la série en cours (critère 4)', () => {
    const done = doneSet(...range('2026-08-01', '2026-08-11'), ...range('2026-09-20', '2026-09-22'));
    expect(computeStreaks(daily, done, d('2026-09-23'))).toEqual({ current: 3, best: 11, unit: 'days' });
    const longNow = doneSet(...range('2026-08-01', '2026-08-03'), ...range('2026-09-01', '2026-09-22'));
    const streaks = computeStreaks(daily, longNow, d('2026-09-23'));
    expect(streaks.best).toBeGreaterThanOrEqual(streaks.current);
    expect(streaks).toMatchObject({ current: 22, best: 22 });
  });

  it('aucune validation : 0 et 0', () => {
    expect(computeStreaks(daily, doneSet(), d('2026-09-23'))).toEqual({ current: 0, best: 0, unit: 'days' });
  });

  it('routine créée aujourd’hui et validée aujourd’hui : 1 ; pas encore validée : 0 sans casser', () => {
    const fresh = makeRoutine({ startDate: d('2026-09-23') });
    expect(computeStreaks(fresh, doneSet('2026-09-23'), d('2026-09-23'))).toMatchObject({ current: 1, best: 1 });
    expect(computeStreaks(fresh, doneSet(), d('2026-09-23'))).toMatchObject({ current: 0, best: 0 });
  });

  it('les validations avant la date de départ ou dans le futur ne comptent pas', () => {
    const late = makeRoutine({ startDate: d('2026-09-20') });
    expect(computeStreaks(late, doneSet('2026-09-10', '2026-09-11'), d('2026-09-23'))).toMatchObject({ current: 0, best: 0 });
    expect(computeStreaks(late, doneSet('2026-09-25'), d('2026-09-23'))).toMatchObject({ current: 0, best: 0 });
  });

  it('la première occurrence manquée avant la première validation ne gêne pas', () => {
    expect(computeStreaks(daily, doneSet('2026-09-22', '2026-09-23'), d('2026-09-23'))).toMatchObject({ current: 2, best: 2 });
  });
});

describe('computeStreaks (R-04) : jours choisis, N jours, N semaines', () => {
  it('Sport lun., mer., ven. : validé lun., mer., ven., lun. = 4 séances ; mar. et jeu. ne cassent pas (critère 2)', () => {
    const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2026-01-01') });
    const done = doneSet('2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21');
    // Mardi 22 : jour non prévu. Aujourd'hui = mar. 22.
    expect(computeStreaks(sport, done, d('2026-09-22'))).toEqual({ current: 4, best: 4, unit: 'sessions' });
    // Jeudi 24 : mer. 23 prévu et manqué -> 0.
    expect(computeStreaks(sport, done, d('2026-09-24'))).toMatchObject({ current: 0, best: 4 });
    // Le jour prévu d'aujourd'hui (mer. 23) non validé ne casse pas.
    expect(computeStreaks(sport, done, d('2026-09-23'))).toMatchObject({ current: 4, best: 4 });
  });

  it('tous les 3 jours : les jours intermédiaires ne cassent pas la série (R-07 critère 7)', () => {
    const every3 = makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2026-09-01') });
    const done = doneSet('2026-09-01', '2026-09-04', '2026-09-07', '2026-09-10');
    expect(computeStreaks(every3, done, d('2026-09-12'))).toEqual({ current: 4, best: 4, unit: 'sessions' });
    // 13 prévu et manqué le 14.
    expect(computeStreaks(every3, done, d('2026-09-14'))).toMatchObject({ current: 0, best: 4 });
  });

  it('toutes les 2 semaines lundi et jeudi : séances consécutives sur les jours prévus', () => {
    const rule = makeRoutine({ scheduleType: 'every_n_weeks', interval: 2, weekdays: [1, 4], startDate: d('2026-09-21') });
    const done = doneSet('2026-09-21', '2026-09-24', '2026-10-05');
    expect(computeStreaks(rule, done, d('2026-10-07'))).toEqual({ current: 3, best: 3, unit: 'sessions' });
    // jeu. 8 oct. prévu et manqué le 9.
    expect(computeStreaks(rule, done, d('2026-10-09'))).toMatchObject({ current: 0, best: 3 });
  });

  it('passage à l’heure d’été (29 mars) et d’hiver (25 oct.) : aucune occurrence perdue ni doublée', () => {
    const daily = makeRoutine({ startDate: d('2026-03-20') });
    expect(computeStreaks(daily, doneSet(...range('2026-03-26', '2026-04-02')), d('2026-04-02'))).toMatchObject({ current: 8, best: 8 });
    expect(computeStreaks(daily, doneSet(...range('2026-10-22', '2026-10-28')), d('2026-10-28'))).toMatchObject({ current: 7, best: 7 });
  });
});

describe('computeStreaks (R-04) : pause (critère 5)', () => {
  it('les jours de pause ne cassent pas la série', () => {
    const daily = makeRoutine({ startDate: d('2026-01-01') });
    const done = doneSet(...range('2026-09-10', '2026-09-14'), ...range('2026-09-20', '2026-09-22'));
    // Pause du 15 au 19 (5 jours) : sans elle, la série serait 3.
    expect(computeStreaks(daily, done, d('2026-09-23'))).toMatchObject({ current: 3, best: 5 });
    const pauses = [{ from: d('2026-09-15'), to: d('2026-09-19') }];
    expect(computeStreaks(daily, done, d('2026-09-23'), pauses)).toEqual({ current: 8, best: 8, unit: 'days' });
  });
});

describe('computeStreaks (R-04) : « X fois par semaine » en semaines consécutives (QB-02, critère 9)', () => {
  const three = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2026-01-01') });
  // Semaine courante : lun. 28 sept. -> dim. 4 oct. 2026 ; aujourd'hui = mer. 30 sept.
  const today = d('2026-09-30');
  const weeks = (...mondays: string[]): string[] =>
    mondays.flatMap((monday) => [monday, addDays(d(monday), 1), addDays(d(monday), 2)] as LocalDate[]);

  it('quota atteint les 4 semaines précédentes : 4 semaines ; la semaine en cours incomplète ne casse pas', () => {
    const done = doneSet(...weeks('2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'), '2026-09-28');
    expect(computeStreaks(three, done, today)).toEqual({ current: 4, best: 4, unit: 'weeks' });
  });

  it('la semaine en cours s’ajoute quand son quota est atteint : 5 semaines', () => {
    const done = doneSet(...weeks('2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'));
    expect(computeStreaks(three, done, today)).toEqual({ current: 5, best: 5, unit: 'weeks' });
  });

  it('une semaine passée à 2 validations sur 3 remet la série à 0 après cette semaine', () => {
    const done = doneSet(...weeks('2026-08-31', '2026-09-07'), '2026-09-14', '2026-09-15', ...weeks('2026-09-21'));
    // Semaines : ok, ok, 2/3 (rupture), ok -> série en cours 1 (la semaine du 21), la meilleure 2.
    expect(computeStreaks(three, done, today)).toEqual({ current: 1, best: 2, unit: 'weeks' });
    // Rien la semaine d'avant : 0, la meilleure reste.
    const broken = doneSet(...weeks('2026-08-31', '2026-09-07', '2026-09-14'), '2026-09-21');
    expect(computeStreaks(three, broken, today)).toEqual({ current: 0, best: 3, unit: 'weeks' });
  });

  it('semaine sans aucune validation entre deux semaines complètes : rupture', () => {
    const done = doneSet(...weeks('2026-09-07', '2026-09-21'));
    expect(computeStreaks(three, done, today)).toMatchObject({ current: 1, best: 1 });
  });

  it('X = 1 : une validation par semaine suffit ; jours après le quota sans effet', () => {
    const one = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 1, startDate: d('2026-01-01') });
    const done = doneSet('2026-09-09', '2026-09-17', '2026-09-23', '2026-09-24', '2026-09-30');
    expect(computeStreaks(one, done, today)).toEqual({ current: 4, best: 4, unit: 'weeks' });
  });

  it('aucune validation ou seulement dans le futur : 0', () => {
    expect(computeStreaks(three, doneSet(), today)).toMatchObject({ current: 0, best: 0 });
    expect(computeStreaks(three, doneSet('2026-10-12'), today)).toMatchObject({ current: 0, best: 0 });
  });

  it('une pause qui couvre une semaine entière ne la compte pas comme manquée', () => {
    const done = doneSet(...weeks('2026-09-07'), ...weeks('2026-09-21'));
    const pauses = [{ from: d('2026-09-14'), to: d('2026-09-20') }];
    expect(computeStreaks(three, done, today, pauses)).toMatchObject({ current: 2, best: 2 });
  });
});

describe('unité et performance', () => {
  it('unité : jours, semaines, séances (critère 6)', () => {
    expect(streakUnit({ scheduleType: 'daily' })).toBe('days');
    expect(streakUnit({ scheduleType: 'x_per_week' })).toBe('weeks');
    for (const type of ['weekdays', 'every_n_days', 'every_n_weeks'] as const) expect(streakUnit({ scheduleType: type })).toBe('sessions');
  });

  it('3 ans d’historique d’une routine : calcul en moins de 50 ms (critère 8)', () => {
    const daily = makeRoutine({ startDate: d('2023-09-01') });
    const done = doneSet(...range('2023-09-01', '2026-09-22').filter((_, i) => i % 11 !== 5));
    const start = performance.now();
    const streaks = computeStreaks(daily, done, d('2026-09-23'));
    const elapsed = performance.now() - start;
    expect(streaks.best).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
    const quota = makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2023-09-01') });
    const startQuota = performance.now();
    computeStreaks(quota, done, d('2026-09-23'));
    expect(performance.now() - startQuota).toBeLessThan(50);
  });

  it('une date de départ très ancienne ne coûte rien : le calcul part de la première validation', () => {
    const ancient = makeRoutine({ startDate: d('1990-01-01') });
    const start = performance.now();
    expect(computeStreaks(ancient, doneSet('2026-09-22', '2026-09-23'), d('2026-09-23'))).toMatchObject({ current: 2 });
    expect(performance.now() - start).toBeLessThan(50);
  });
});
