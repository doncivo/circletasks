import { describe, expect, it } from 'vitest';
import { carryOverUndoneTasks, isCarryOverCandidate, msUntilNextLocalMidnight, type CarryOverCandidate } from './taskCarryOver';
import { asLocalDate, asLocalTime, type IsoDateTime, type LocalDate, type LocalTime } from './types';

const d = asLocalDate;

interface FakeTask extends CarryOverCandidate {
  readonly id: string;
  readonly time: LocalTime | null;
  readonly recurrenceId: string | null;
  readonly carriedOver: boolean;
}

function task(id: string, date: string | null, over: Partial<FakeTask> = {}): FakeTask {
  return {
    id,
    date: date === null ? null : d(date),
    time: null,
    status: 'todo',
    someday: false,
    deletedAt: null,
    recurrenceId: null,
    carriedOver: false,
    ...over,
  };
}

const ids = (tasks: readonly { id: string }[]): string[] => tasks.map((t) => t.id);

describe('carryOverUndoneTasks (T-06)', () => {
  const today = d('2026-09-24');

  it('retient les tâches à faire datées avant aujourd’hui (critère 1)', () => {
    expect(ids(carryOverUndoneTasks([task('a', '2026-09-23')], today))).toEqual(['a']);
  });

  it('rattrape plusieurs jours sautés, fin de mois et d’année comprises (critère 2)', () => {
    const tasks = [task('a', '2026-09-20'), task('b', '2026-09-21'), task('c', '2026-09-22')];
    expect(ids(carryOverUndoneTasks(tasks, d('2026-09-23')))).toEqual(['a', 'b', 'c']);
    expect(ids(carryOverUndoneTasks([task('z', '2026-12-30')], d('2027-01-02')))).toEqual(['z']);
  });

  it('conserve l’heure flottante : la tâche est rendue telle quelle, seule la date change côté appelant', () => {
    const [carried] = carryOverUndoneTasks([task('a', '2026-09-23', { time: asLocalTime('09:30') })], today);
    expect(carried?.time).toBe('09:30');
  });

  it('exclut terminées, sans date, Un jour, supprimées, du jour et futures (critère 6)', () => {
    const tasks = [
      task('done', '2026-09-23', { status: 'done' }),
      task('nodate', null),
      task('someday', null, { someday: true }),
      task('deleted', '2026-09-23', { deletedAt: '2026-09-23T10:00:00.000Z' as IsoDateTime }),
      task('today', '2026-09-24'),
      task('future', '2026-09-30'),
    ];
    expect(carryOverUndoneTasks(tasks, today)).toEqual([]);
  });

  it('est idempotente : une tâche déjà reportée à aujourd’hui n’est plus candidate (critère 1, 9)', () => {
    const first = carryOverUndoneTasks([task('a', '2026-09-23')], today);
    const moved = first.map((t) => ({ ...t, date: today as LocalDate, carriedOver: true }));
    expect(carryOverUndoneTasks(moved, today)).toEqual([]);
  });

  it('reporte une occurrence récurrente non faite comme toute tâche (Q2, critère 7)', () => {
    const rent = task('loyer', '2026-09-23', { recurrenceId: 'rec-1' });
    expect(ids(carryOverUndoneTasks([rent], today))).toEqual(['loyer']);
  });

  it('point d’extension T-09 : skip exclut des tâches du report', () => {
    const tasks = [task('loyer', '2026-09-23', { recurrenceId: 'rec-1' }), task('b', '2026-09-23')];
    expect(ids(carryOverUndoneTasks(tasks, today, { skip: (t) => t.recurrenceId !== null }))).toEqual(['b']);
  });

  it('isCarryOverCandidate compare les dates civiles, jamais l’heure', () => {
    expect(isCarryOverCandidate(task('a', '2026-09-23', { time: asLocalTime('23:59') }), today)).toBe(true);
    expect(isCarryOverCandidate(task('a', '2026-09-24', { time: asLocalTime('00:00') }), today)).toBe(false);
  });
});

describe('msUntilNextLocalMidnight (T-06, critère 9)', () => {
  it('donne le délai jusqu’au prochain 00:00 local', () => {
    const at = new Date(2026, 8, 23, 23, 0, 0).getTime();
    expect(msUntilNextLocalMidnight(at)).toBe(3_600_000);
  });

  it('vaut un jour entier juste après minuit, pas zéro (un seul déclenchement par jour)', () => {
    const at = new Date(2026, 8, 24, 0, 0, 0).getTime();
    const delay = msUntilNextLocalMidnight(at);
    expect(delay).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(delay).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it('traverse un changement d’heure : le minuit visé reste le prochain 00:00 local', () => {
    // Le jour du passage à l'heure d'été / d'hiver dure 23 h ou 25 h selon le fuseau ; dans un
    // fuseau sans changement d'heure la durée est de 24 h : on vérifie le lendemain civil.
    for (const [m, day] of [[2, 28], [9, 24]] as const) {
      const at = new Date(2026, m, day, 12, 0, 0).getTime();
      const target = new Date(at + msUntilNextLocalMidnight(at));
      expect([target.getHours(), target.getMinutes(), target.getDate()]).toEqual([0, 0, day + 1]);
    }
  });

  it('fin d’année', () => {
    const at = new Date(2026, 11, 31, 18, 0, 0).getTime();
    const target = new Date(at + msUntilNextLocalMidnight(at));
    expect([target.getFullYear(), target.getMonth(), target.getDate()]).toEqual([2027, 0, 1]);
  });
});
