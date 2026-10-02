import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import { defaultSetting } from './model';
import { activeRecapTimes, buildRecap, validateRecapSettings, type RecapSettings } from './recap';
import { d, makeLog, makeRoutine, time } from './routineTestKit';
import { asEntityId, asLocalDate, asLocalTime, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const DAY = asLocalDate('2026-09-23');

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, spaceId: PRO, title: id, date: DAY, time: null, status: 'todo', sortOrder: 0, someday: false, deletedAt: null, ...over } as unknown as Task;
}

const settings = (morning: [boolean, string], evening: [boolean, string]): RecapSettings => ({
  morning: { enabled: morning[0], time: asLocalTime(morning[1]) },
  evening: { enabled: evening[0], time: asLocalTime(evening[1]) },
});

describe('réglages des récapitulatifs (N-04)', () => {
  it('valeurs par défaut : matin 07:30 et soir 21:00 actifs (QB-09, critère 9)', () => {
    const defaults = { morning: defaultSetting('reminders.morningRecap'), evening: defaultSetting('reminders.eveningRecap') };
    expect(defaults.morning).toEqual({ enabled: true, time: '07:30' });
    expect(defaults.evening).toEqual({ enabled: true, time: '21:00' });
    expect(activeRecapTimes(defaults)).toEqual(['07:30', '21:00']);
  });

  it('heures actives seulement, matin d’abord (critère 1)', () => {
    expect(activeRecapTimes(settings([true, '07:00'], [false, '21:00']))).toEqual(['07:00']);
    expect(activeRecapTimes(settings([false, '07:00'], [true, '21:00']))).toEqual(['21:00']);
    expect(activeRecapTimes(settings([false, '07:00'], [false, '21:00']))).toEqual([]);
  });

  it('refuse un soir qui ne suit pas strictement le matin (critère 4)', () => {
    expect(validateRecapSettings(settings([true, '07:30'], [true, '21:00'])).ok).toBe(true);
    expect(validateRecapSettings(settings([true, '07:30'], [true, '07:31'])).ok).toBe(true);
    expect(validateRecapSettings(settings([true, '21:00'], [true, '21:00']))).toEqual({ ok: false, error: 'evening-before-morning' });
    expect(validateRecapSettings(settings([true, '22:00'], [true, '21:00']))).toEqual({ ok: false, error: 'evening-before-morning' });
    // Heure invalide (jamais produite par l'écran, qui passe par parseTimeInput).
    expect(validateRecapSettings({ morning: { enabled: true, time: '7h30' as never }, evening: { enabled: true, time: asLocalTime('21:00') } })).toEqual({
      ok: false,
      error: 'invalid-time',
    });
  });
});

describe('contenu des récapitulatifs (N-04)', () => {
  // 3 tâches (dont 1 faite), 2 routines prévues : 5 éléments.
  const tasks = [task('t1', { time: time('09:00') }), task('t2', { status: 'done' }), task('t3', { spaceId: PERSO })];
  const lit = makeRoutine({ title: 'Faire mon lit', time: time('07:30'), spaceId: PERSO });
  const eau = makeRoutine({ title: 'Boire de l’eau', time: time('08:30') });
  const routines = [lit, eau];

  it('matin : les 5 éléments du jour, faits compris, tous espaces, routines incluses (critère 5)', () => {
    const recap = buildRecap('morning', DAY, tasks, routines, []);
    expect(recap.count).toBe(5);
    expect(recap.lines.map((line) => line.title)).toEqual(['Faire mon lit', 'Boire de l’eau', 't1', 't2', 't3']);
    expect(recap.lines.filter((line) => line.kind === 'routine')).toHaveLength(2);
    expect(recap.lines.find((line) => line.title === 't2')?.done).toBe(true);
  });

  it('soir : seulement les éléments non faits ; une routine validée en est exclue (critère 6)', () => {
    const logs = [makeLog(lit, '2026-09-23')];
    const recap = buildRecap('evening', DAY, tasks, routines, logs);
    expect(recap.count).toBe(3);
    expect(recap.lines.map((line) => line.title)).toEqual(['Boire de l’eau', 't1', 't3']);
    expect(recap.lines.every((line) => !line.done)).toBe(true);
  });

  it('soir : 3 tâches + 2 routines dont 1 tâche faite : 4 éléments non faits (critère 6)', () => {
    expect(buildRecap('evening', DAY, tasks, routines, []).count).toBe(4);
  });

  it('soir : tout est fait, aucune ligne (critère 6)', () => {
    const logs = [makeLog(lit, '2026-09-23'), makeLog(eau, '2026-09-23')];
    const recap = buildRecap('evening', DAY, [task('t2', { status: 'done' })], routines, logs);
    expect(recap.count).toBe(0);
    expect(recap.lines).toEqual([]);
  });

  it('ignore les tâches d’un autre jour, « Un jour », supprimées, et les routines en pause ou archivées', () => {
    const recap = buildRecap(
      'morning',
      DAY,
      [
        task('autre', { date: d('2026-09-24') }),
        task('un-jour', { date: null, someday: true }),
        task('supprimee', { deletedAt: '2026-09-23T08:00:00.000Z' as never }),
        task('ok'),
        task('ok'),
      ],
      [makeRoutine({ title: 'pause', paused: true }), makeRoutine({ title: 'archivee', archived: true }), makeRoutine({ title: 'jamais le mardi', scheduleType: 'weekdays', weekdays: [2] })],
      [],
    );
    expect(recap.lines.map((line) => line.title)).toEqual(['ok']);
  });

  it('ordre : à l’heure d’abord, par heure ; sans heure ensuite', () => {
    const recap = buildRecap('morning', DAY, [task('tard', { time: time('18:00') }), task('sans'), task('tot', { time: time('08:00') })], [], []);
    expect(recap.lines.map((line) => line.title)).toEqual(['tot', 'tard', 'sans']);
  });
});
