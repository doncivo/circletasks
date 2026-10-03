import { describe, expect, it } from 'vitest';
import { asLocalDate, asLocalTime } from './types';
import { scheduleOf, setTaskSchedule, sortTasksForDay, type ScheduleFields } from './taskSchedule';
import type { TaskStatus } from './model';

const DATE = asLocalDate('2026-10-05');
const OTHER_DATE = asLocalDate('2026-10-06');
const TIME = asLocalTime('10:00');

const DATED_WITH_TIME: ScheduleFields = { date: DATE, time: TIME, someday: false };
const DATED_NO_TIME: ScheduleFields = { date: DATE, time: null, someday: false };
const SOMEDAY: ScheduleFields = { date: null, time: null, someday: true };
const DATELESS: ScheduleFields = { date: null, time: null, someday: false };

describe('setTaskSchedule (T-02)', () => {
  it('efface l’heure et conserve la date (critère 5, première partie)', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { time: null })).toEqual({
      ok: true,
      value: { date: DATE, time: null, someday: false },
    });
  });

  it('passer en « Un jour » efface aussi la date et l’heure (critère 5, invariant M18)', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { someday: true })).toEqual({
      ok: true,
      value: { date: null, time: null, someday: true },
    });
  });

  it('effacer la date hors « Un jour » efface aussi l’heure, sans erreur (invariant silencieux)', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { date: null })).toEqual({
      ok: true,
      value: { date: null, time: null, someday: false },
    });
  });

  it('pose une heure sur une tâche déjà datée', () => {
    expect(setTaskSchedule(DATED_NO_TIME, { time: TIME })).toEqual({
      ok: true,
      value: { date: DATE, time: TIME, someday: false },
    });
  });

  it('change la date et conserve l’heure quand elle n’est pas fournie', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { date: OTHER_DATE })).toEqual({
      ok: true,
      value: { date: OTHER_DATE, time: TIME, someday: false },
    });
  });

  it('refuse une heure sans date, tâche déjà sans date (symétrique à T-01)', () => {
    expect(setTaskSchedule(DATELESS, { time: TIME })).toEqual({ ok: false, error: 'time-without-date' });
  });

  it('refuse une heure fournie en même temps que l’effacement de la date', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { date: null, time: TIME })).toEqual({
      ok: false,
      error: 'time-without-date',
    });
  });

  it('refuse une heure fournie en passant en « Un jour » dans le même appel', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, { someday: true, time: TIME })).toEqual({
      ok: false,
      error: 'time-without-date',
    });
  });

  it('reprend une tâche « Un jour » avec une nouvelle date, sans heure par défaut', () => {
    expect(setTaskSchedule(SOMEDAY, { someday: false, date: OTHER_DATE })).toEqual({
      ok: true,
      value: { date: OTHER_DATE, time: null, someday: false },
    });
  });

  it('l’heure stockée est indépendante du fuseau (critère 6) : aucune conversion, la valeur passe telle quelle', () => {
    const result = setTaskSchedule(DATED_NO_TIME, { time: asLocalTime('23:45') });
    expect(result).toEqual({ ok: true, value: { date: DATE, time: asLocalTime('23:45'), someday: false } });
  });

  it('un appel sans changement est idempotent', () => {
    expect(setTaskSchedule(DATED_WITH_TIME, {})).toEqual({ ok: true, value: DATED_WITH_TIME });
    expect(setTaskSchedule(DATELESS, {})).toEqual({ ok: true, value: DATELESS });
  });
});

describe('scheduleOf', () => {
  it('extrait les trois champs de planification d’une tâche', () => {
    expect(scheduleOf({ date: DATE, time: TIME, someday: false })).toEqual(DATED_WITH_TIME);
  });
});

interface FakeTask {
  readonly id: string;
  readonly time: ReturnType<typeof asLocalTime> | null;
  readonly status: TaskStatus;
}

function task(id: string, time: string | null, status: TaskStatus = 'todo'): FakeTask {
  return { id, time: time === null ? null : asLocalTime(time), status };
}

describe('sortTasksForDay (T-02, Q11)', () => {
  it('trie trois tâches à l’heure par ordre croissant (critère 3)', () => {
    const tasks = [task('a', '14:00'), task('b', '09:00'), task('c', '11:30')];
    expect(sortTasksForDay(tasks).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('place les tâches à l’heure avant celles sans heure, qui gardent leur ordre manuel (critère 4, Q11)', () => {
    // A (14:00), B (09:00), C sans heure, D sans heure (C avant D, ordre manuel donné par le repository).
    const tasks = [task('A', '14:00'), task('B', '09:00'), task('C', null), task('D', null)];
    expect(sortTasksForDay(tasks).map((t) => t.id)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('garde les tâches terminées en bas, quel que soit leur horaire (critère 8, T-04)', () => {
    const tasks = [
      task('done-early', '08:00', 'done'),
      task('todo-late', '18:00'),
      task('todo-no-time', null),
      task('done-no-time', null, 'done'),
    ];
    expect(sortTasksForDay(tasks).map((t) => t.id)).toEqual(['todo-late', 'todo-no-time', 'done-early', 'done-no-time']);
  });

  it('ne modifie pas l’ordre relatif des tâches sans heure (tri stable)', () => {
    const tasks = [task('x', null), task('y', null), task('z', null)];
    expect(sortTasksForDay(tasks).map((t) => t.id)).toEqual(['x', 'y', 'z']);
  });
});
