import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from './itemFilter';
import type { Task } from './model';
import { canMoveToSomeday, compareSomedayTasks, isInSomedayList, resolveScheduleTarget, scheduleLabelKind, scheduleSomeday, selectSomedayTasks, sendToSomeday, somedayHeadOrder } from './someday';
import { asEntityId, asLocalDate, asLocalTime, type LocalDate, type LocalTime, type ProjectId, type RecurrenceId, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const MISSION = asEntityId<ProjectId>('20000000-0000-4000-8000-000000000001');

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, spaceId: PRO, projectId: null, title: id, date: null, time: null, status: 'todo', sortOrder: 0, someday: true, deletedAt: null, ...over } as unknown as Task;
}

describe('liste « Un jour » (SD-01)', () => {
  it('ne garde que les tâches sans date, à faire et non supprimées (critères 7, 8)', () => {
    const list = selectSomedayTasks(
      [
        task('a'),
        task('datee', { someday: false, date: asLocalDate('2026-10-03') }),
        task('faite', { status: 'done' }),
        task('supprimee', { deletedAt: '2026-10-03T08:00:00.000Z' as never }),
      ],
      ALL_ITEMS,
    );
    expect(list.map((x) => x.id)).toEqual(['a']);
  });

  it('suit le filtre d’espace et de projet (critère 6, SD-04 critères 3 et 4)', () => {
    const tasks = [task('pro'), task('perso', { spaceId: PERSO }), task('mission', { projectId: MISSION })];
    expect(selectSomedayTasks(tasks, { space: PERSO, project: null }).map((x) => x.id)).toEqual(['perso']);
    expect(selectSomedayTasks(tasks, { space: PRO, project: MISSION }).map((x) => x.id)).toEqual(['mission']);
    expect(isInSomedayList(task('pro'), { space: PERSO, project: null })).toBe(false);
  });

  it('suit l’ordre manuel, puis l’identifiant', () => {
    const list = selectSomedayTasks([task('c', { sortOrder: 5 }), task('b', { sortOrder: 1 }), task('a', { sortOrder: 5 })], ALL_ITEMS);
    expect(list.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(compareSomedayTasks(task('a'), task('a'))).toBe(0);
  });

  it('une nouvelle tâche passe en tête (SD-04 critère 2)', () => {
    expect(somedayHeadOrder([10, 4, 7], 99)).toBe(3);
    expect(somedayHeadOrder([], 99)).toBe(99);
  });
});

describe('scheduleSomeday (SD-02)', () => {
  const day = asLocalDate('2026-10-04');

  it('lève « Un jour », pose la date sans heure et efface le badge', () => {
    expect(scheduleSomeday(task('a', { sortOrder: 3 }), day, null, null)).toEqual({
      ok: true,
      value: { date: day, time: null, someday: false, carriedOver: false, sortOrder: 3 },
    });
  });

  it('accepte une heure facultative (choix d’une date)', () => {
    const result = scheduleSomeday(task('a'), day, asLocalTime('10:00'), null);
    expect(result).toMatchObject({ ok: true, value: { date: day, time: '10:00' } });
  });

  it('prend la fin de l’ordre du jour d’arrivée', () => {
    expect(scheduleSomeday(task('a', { sortOrder: 1 }), day, null, 40)).toMatchObject({ ok: true, value: { sortOrder: 41 } });
  });

  it('refuse une tâche qui n’est pas dans « Un jour », terminée, ou une date / heure invalide', () => {
    expect(scheduleSomeday(task('a', { someday: false }), day, null, null)).toEqual({ ok: false, error: 'not-someday' });
    expect(scheduleSomeday(task('a', { status: 'done' }), day, null, null)).toEqual({ ok: false, error: 'not-someday' });
    expect(scheduleSomeday(task('a'), '2026-02-31' as LocalDate, null, null)).toEqual({ ok: false, error: 'invalid-date' });
    expect(scheduleSomeday(task('a'), day, '25:00' as LocalTime, null)).toEqual({ ok: false, error: 'invalid-time' });
  });
});

describe('resolveScheduleTarget et scheduleLabelKind (SD-02)', () => {
  const today = asLocalDate('2026-10-02');

  it('« Aujourd’hui » et « Demain » se calculent depuis aujourd’hui, sans heure', () => {
    expect(resolveScheduleTarget(today, 'today')).toEqual({ date: '2026-10-02', time: null });
    expect(resolveScheduleTarget(today, 'tomorrow')).toEqual({ date: '2026-10-03', time: null });
    expect(resolveScheduleTarget(asLocalDate('2026-12-31'), 'tomorrow')).toEqual({ date: '2027-01-01', time: null });
  });

  it('une date choisie garde son heure facultative', () => {
    expect(resolveScheduleTarget(today, { date: asLocalDate('2026-10-09'), time: asLocalTime('10:00') })).toEqual({ date: '2026-10-09', time: '10:00' });
    expect(resolveScheduleTarget(today, { date: asLocalDate('2026-10-09') })).toEqual({ date: '2026-10-09', time: null });
  });

  it('le libellé suit la date réelle : aujourd’hui, demain ou une autre date', () => {
    expect(scheduleLabelKind(today, asLocalDate('2026-10-02'))).toBe('today');
    expect(scheduleLabelKind(today, asLocalDate('2026-10-03'))).toBe('tomorrow');
    expect(scheduleLabelKind(today, asLocalDate('2026-10-09'))).toBe('date');
  });
});

describe('sendToSomeday (SD-03)', () => {
  const dated = { status: 'todo' as const, someday: false, recurrenceId: null };

  it('retire date et heure, efface le badge « reportée » et place la tâche en tête (critères 1 et 4)', () => {
    expect(sendToSomeday(dated, [5, 9], 100)).toEqual({ ok: true, value: { date: null, time: null, someday: true, carriedOver: false, sortOrder: 4 } });
  });

  it('liste vide : valeur de départ', () => {
    expect(sendToSomeday(dated, [], 100)).toMatchObject({ ok: true, value: { sortOrder: 100 } });
  });

  it('refuse une tâche terminée (critère 7), déjà dans « Un jour », ou récurrente (QB-11)', () => {
    expect(sendToSomeday({ ...dated, status: 'done' }, [], 1)).toEqual({ ok: false, error: 'done' });
    expect(sendToSomeday({ ...dated, someday: true }, [], 1)).toEqual({ ok: false, error: 'already-someday' });
    expect(sendToSomeday({ ...dated, recurrenceId: asEntityId<RecurrenceId>('30000000-0000-4000-8000-000000000001') }, [], 1)).toEqual({ ok: false, error: 'recurrent' });
  });
});

describe('canMoveToSomeday = sendToSomeday(...).ok (A-08, SD-03)', () => {
  const base = { status: 'todo' as const, someday: false, recurrenceId: null };
  it('suit exactement la règle de sendToSomeday', () => {
    expect(canMoveToSomeday(base)).toBe(true);
    expect(canMoveToSomeday({ ...base, status: 'done' })).toBe(false);
    expect(canMoveToSomeday({ ...base, someday: true })).toBe(false);
    expect(canMoveToSomeday({ ...base, recurrenceId: asEntityId<RecurrenceId>('30000000-0000-4000-8000-000000000001') })).toBe(false);
  });
});
