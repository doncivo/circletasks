import { describe, expect, it } from 'vitest';
import type { Checklist, ChecklistSummary, Goal, Routine, Task } from './model';
import { buildTodayList, rowIsDone, rowTime, type TodayEventEntry, type TodayRoutineEntry } from './todayList';
import { asEntityId, asLocalDate, asLocalTime, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const DAY = asLocalDate('2026-09-23');

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, spaceId: PRO, title: id, date: DAY, time: null, status: 'todo', sortOrder: 0, someday: false, deletedAt: null, ...over } as unknown as Task;
}

function routine(id: string, over: Partial<Routine> = {}): TodayRoutineEntry {
  const r = { id, spaceId: PRO, title: id, time: null, paused: false, archived: false, deletedAt: null, ...over } as unknown as Routine;
  return { routine: r, done: false };
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);
const time = asLocalTime;

describe('buildTodayList (A-01)', () => {
  it('ne garde que les tâches du jour : ni autres jours, ni « Un jour », ni supprimées (critère 4)', () => {
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [
        task('a'),
        task('autre-jour', { date: asLocalDate('2026-09-24') }),
        task('un-jour', { date: null, someday: true }),
        task('supprimee', { deletedAt: '2026-09-23T08:00:00.000Z' as never }),
      ],
    });
    expect(ids(list.rows)).toEqual(['a']);
  });

  it('chaque élément n’apparaît qu’une fois, même fourni deux fois (critère 4)', () => {
    const list = buildTodayList({ date: DAY, filter: 'all', tasks: [task('a'), task('a')], routines: [routine('r'), routine('r')] });
    expect(ids(list.rows)).toEqual(['r', 'a']);
  });

  it('trie par heure puis sans heure dans l’ordre manuel (Q11), routines placées par leur heure', () => {
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [
        task('sans-b', { sortOrder: 20 }),
        task('sans-a', { sortOrder: 10 }),
        task('14h', { time: time('14:00'), sortOrder: 1 }),
        task('9h', { time: time('09:00'), sortOrder: 99 }),
      ],
      routines: [routine('eau', { time: time('08:30') as never }), routine('sport', { time: time('18:00') as never }), routine('sans-heure')],
    });
    expect(ids(list.rows)).toEqual(['eau', '9h', '14h', 'sport', 'sans-heure', 'sans-a', 'sans-b']);
  });

  it('à heure égale : routine d’abord, puis ordre manuel', () => {
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [task('t2', { time: time('09:00'), sortOrder: 2 }), task('t1', { time: time('09:00'), sortOrder: 1 })],
      routines: [routine('r', { time: time('09:00') as never })],
    });
    expect(ids(list.rows)).toEqual(['r', 't1', 't2']);
  });

  it('place les éléments terminés (tâches et routines) en bas, avec le même tri (critère 3)', () => {
    const done = routine('fait', { time: time('07:00') as never });
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [task('a'), task('b', { status: 'done', time: time('10:00') }), task('c', { status: 'done', time: time('08:00') })],
      routines: [{ ...done, done: true }],
    });
    expect(ids(list.rows)).toEqual(['a']);
    expect(ids(list.doneRows)).toEqual(['fait', 'c', 'b']);
    expect(list.doneRows.every(rowIsDone)).toBe(true);
    expect(rowTime(list.doneRows[1] as never)).toBe('08:00');
  });

  it('filtre par espace : Pro ne garde que Pro, Tout garde tout (critère 6)', () => {
    const input = {
      date: DAY,
      tasks: [task('pro', { sortOrder: 1 }), task('perso', { spaceId: PERSO, sortOrder: 2 })],
      routines: [routine('r-perso', { spaceId: PERSO })],
      events: [
        { id: 'e-pro', title: 'Pro', allDay: false, startTime: time('10:00'), spaceId: PRO, calendarName: null, icon: null },
        { id: 'e-perso', title: 'Perso', allDay: false, startTime: time('11:00'), spaceId: PERSO, calendarName: null, icon: null },
        { id: 'ext', title: 'Externe', allDay: false, startTime: time('12:00'), spaceId: null, calendarName: 'Google Agenda', icon: null },
      ] satisfies TodayEventEntry[],
    };
    const pro = buildTodayList({ ...input, filter: PRO });
    expect(ids(pro.rows)).toEqual(['pro']);
    expect(ids(pro.events)).toEqual(['e-pro', 'ext']);
    const all = buildTodayList({ ...input, filter: 'all' });
    expect(ids(all.rows)).toEqual(['r-perso', 'pro', 'perso']);
    expect(ids(all.events)).toEqual(['e-pro', 'e-perso', 'ext']);
  });

  it('trie les événements : toute la journée, puis par heure', () => {
    const base = { spaceId: null, calendarName: null, icon: null };
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [],
      events: [
        { id: 'b', title: 'B', allDay: false, startTime: time('15:00'), ...base },
        { id: 'a', title: 'A', allDay: false, startTime: time('09:00'), ...base },
        { id: 'j', title: 'J', allDay: true, startTime: null, ...base },
      ],
    });
    expect(ids(list.events)).toEqual(['j', 'a', 'b']);
  });

  it('ignore les routines archivées, en pause ou supprimées', () => {
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [],
      routines: [routine('ok'), routine('pause', { paused: true }), routine('archivee', { archived: true }), routine('sup', { deletedAt: 'x' as never })],
    });
    expect(ids(list.rows)).toEqual(['ok']);
  });

  it('masque les routines quand hideRoutines est vrai (A-03 critères 2 et 5), tâches inchangées', () => {
    const input = { date: DAY, filter: 'all' as const, tasks: [task('a')], routines: [routine('r'), { ...routine('fait'), done: true }] };
    const hidden = buildTodayList({ ...input, hideRoutines: true });
    expect(ids(hidden.rows)).toEqual(['a']);
    expect(hidden.doneRows).toEqual([]);
    const shown = buildTodayList({ ...input, hideRoutines: false });
    expect(ids(shown.rows)).toEqual(['r', 'a']);
    expect(ids(shown.doneRows)).toEqual(['fait']);
  });

  it('une journée sans tâche, routines masquées, est vide (A-03 critère 7)', () => {
    const list = buildTodayList({ date: DAY, filter: 'all', tasks: [], routines: [routine('r')], hideRoutines: true });
    expect(list.isEmpty).toBe(true);
    expect(buildTodayList({ date: DAY, filter: 'all', tasks: [], routines: [routine('r')] }).isEmpty).toBe(false);
  });

  it('garde les checklists datées du jour, hors modèles et hors autres jours', () => {
    const checklist = (id: string, over: Partial<Checklist> = {}): ChecklistSummary => ({
      checklist: { id, spaceId: PRO, title: id, date: DAY, isTemplate: false, deletedAt: null, ...over } as unknown as Checklist,
      checked: 3,
      total: 5,
    });
    const list = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [],
      checklists: [checklist('valise'), checklist('modele', { isTemplate: true }), checklist('demain', { date: asLocalDate('2026-09-24') })],
    });
    expect(list.checklists.map((c) => c.checklist.id)).toEqual(['valise']);
    expect(list.isEmpty).toBe(false);
  });

  it('l’objectif épinglé suit le filtre d’espace et ne rend pas la liste « non vide »', () => {
    const goal = { goal: { id: 'g', spaceId: PRO, title: 'Objectif', deletedAt: null } as unknown as Goal, progress: { done: 2, total: 5 } };
    expect(buildTodayList({ date: DAY, filter: 'all', tasks: [], goal }).goal).toBe(goal);
    expect(buildTodayList({ date: DAY, filter: PERSO, tasks: [], goal }).goal).toBeNull();
    expect(buildTodayList({ date: DAY, filter: 'all', tasks: [], goal }).isEmpty).toBe(true);
  });

  it('un jour sans événement, routine ni checklist : sources absentes = rien d’inventé', () => {
    const list = buildTodayList({ date: DAY, filter: 'all', tasks: [] });
    expect(list).toMatchObject({ goal: null, events: [], rows: [], doneRows: [], checklists: [], isEmpty: true });
  });
});
