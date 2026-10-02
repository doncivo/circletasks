import { describe, expect, it } from 'vitest';
import { addDays } from './localDate';
import { completionRate, monthHeatmap } from './routineReport';
import { computeStreaks } from './routineStreaks';
import { d, doneSet, makeRoutine } from './routineTestKit';

/** R-04 critère 8 et R-06 critère 8 : séries et taux sur 3 ans d'historique d'une routine en moins de 50 ms (`npm run test:perf`). */
function threeYears(): string[] {
  const out: string[] = [];
  for (let date = d('2023-09-24'); date <= d('2026-09-22'); date = addDays(date, 1)) out.push(date);
  return out;
}

describe('performance des statistiques de routine (3 ans d’historique)', () => {
  const today = d('2026-09-23');
  const done = doneSet(...threeYears().filter((_, i) => i % 7 !== 3));
  const pauses = [{ from: d('2025-01-10'), to: d('2025-01-24') }, { from: d('2026-08-01'), to: d('2026-08-09') }];
  const routines = [
    makeRoutine({ startDate: d('2023-09-24') }),
    makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: d('2023-09-24') }),
    makeRoutine({ scheduleType: 'every_n_days', interval: 3, startDate: d('2023-09-24') }),
    makeRoutine({ scheduleType: 'x_per_week', timesPerWeek: 3, startDate: d('2023-09-24') }),
  ];

  it.each(routines.map((routine) => [routine.scheduleType, routine] as const))('%s : séries en moins de 50 ms', (_name, routine) => {
    const start = performance.now();
    computeStreaks(routine, done, today, pauses);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it.each(routines.map((routine) => [routine.scheduleType, routine] as const))('%s : taux 7, 30, 90 jours et carte de chaleur en moins de 50 ms', (_name, routine) => {
    const start = performance.now();
    for (const days of [7, 30, 90]) completionRate(routine, done, today, days, pauses);
    monthHeatmap(routine, done, 2026, 9, today, pauses);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
