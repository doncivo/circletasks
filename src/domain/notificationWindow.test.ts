import { describe, expect, it } from 'vitest';
import type { Reminder, Task } from './model';
import { planNotifications, type NotificationPlanInput } from './notificationPlan';
import { makeRoutine } from './routineTestKit';
import { asLocalDate, asLocalDateTime, asLocalTime } from './types';

describe('N-TECH-02 : couverture réelle des routines', () => {
  const routine = makeRoutine({ time: asLocalTime('07:00') });
  const reminder = {
    id: '22000000-0000-4000-8000-000000000001', targetType: 'routine', targetId: routine.id,
    offsetMin: 0, deletedAt: null,
  } as unknown as Reminder;
  const plan = (now: string, over: Partial<NotificationPlanInput> = {}) => planNotifications({
    now: asLocalDateTime(now), tasks: [], routines: [routine], routinePauses: [], routineLogs: [], events: [],
    reminders: [reminder], spaces: [{ id: routine.spaceId, quietHours: [] }],
    recaps: { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: false, time: asLocalTime('21:00') } }, ...over,
  });

  it('application fermée deux jours : cinq rappels restent sans aucun nouveau passage', () => {
    const initial = plan('2026-10-07T10:00');
    expect(initial.items).toHaveLength(7);
    expect(initial.items.filter(item => item.fireAt > '2026-10-09T10:00').map(item => item.fireAt)).toEqual([
      '2026-10-10T07:00', '2026-10-11T07:00', '2026-10-12T07:00', '2026-10-13T07:00', '2026-10-14T07:00',
    ]);
    expect(initial.coverage).toEqual({ state: 'until', until: '2026-10-14T07:00' });
    expect(plan('2026-10-09T10:00').items.map(item => item.fireAt)).toEqual([
      '2026-10-10T07:00', '2026-10-11T07:00', '2026-10-12T07:00', '2026-10-13T07:00', '2026-10-14T07:00', '2026-10-15T07:00', '2026-10-16T07:00',
    ]);
  });

  it('borne exacte : fenêtre ouverte au début, fermée à sept jours', () => {
    const atTen = { ...routine, time: asLocalTime('10:00') };
    expect(plan('2026-10-07T10:00', { routines: [atTen] }).items.map(item => item.fireAt)).toEqual(
      Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 8).padStart(2, '0')}T10:00`),
    );
    expect(plan('2026-10-07T09:59', { routines: [atTen] }).items.map(item => item.fireAt)).toEqual(
      Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 7).padStart(2, '0')}T10:00`),
    );
  });

  it('douze routines et récapitulatifs : préfixe de 64, aucun jour partiellement couvert', () => {
    const routines = Array.from({ length: 12 }, () => makeRoutine({ time: asLocalTime('07:00') }));
    const reminders = routines.map((r, i) => ({ ...reminder, id: `22000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, targetId: r.id }) as unknown as Reminder);
    const result = plan('2026-10-07T10:00', { routines, reminders, recaps: { morning: { enabled: true, time: asLocalTime('07:30') }, evening: { enabled: true, time: asLocalTime('21:00') } } });
    expect(result.total).toBe(885);
    expect(result.items).toHaveLength(64);
    const counts = routines.map(r => result.items.filter(item => item.kind === 'routine' && item.targetId === r.id).length);
    expect(counts.filter(n => n === 4)).toHaveLength(5);
    expect(counts.filter(n => n === 5)).toHaveLength(7);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-11T21:00' });
  });

  it.each([false, true])('plafond et égalité de minute : allSame=%s', allSame => {
    const tasks = Array.from({ length: 70 }, (_, i) => ({ id: `11000000-0000-4000-8000-${String(i).padStart(12, '0')}`, spaceId: routine.spaceId, title: 'Tâche', date: '2026-10-08', time: allSame || i < 60 ? '08:00' : '09:00', status: 'todo', someday: false, deletedAt: null }) as unknown as Task);
    const reminders = tasks.map((task, i) => ({ ...reminder, id: `22000000-0000-4000-8000-${String(i).padStart(12, '0')}`, targetType: 'task', targetId: task.id }) as unknown as Reminder);
    const result = plan('2026-10-07T10:00', { routines: [], tasks, reminders });
    expect(result.items).toHaveLength(64);
    expect(result.coverage).toEqual({ state: 'until', until: allSame ? '2026-10-07T10:00' : '2026-10-08T08:00' });
  });

  it('une tâche lointaine ne prolonge pas artificiellement la couverture des routines', () => {
    const task = { id: '11000000-0000-4000-8000-000000000001', spaceId: routine.spaceId, title: 'Tâche', date: '2026-10-20', time: '09:00', status: 'todo', someday: false, deletedAt: null } as unknown as Task;
    const result = plan('2026-10-07T10:00', { tasks: [task], reminders: [reminder, { ...reminder, id: '22000000-0000-4000-8000-000000000002', targetType: 'task', targetId: task.id } as unknown as Reminder] });
    expect(result.items).toHaveLength(8);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-14T07:00' });
  });

  it('repli hors fenêtre : première occurrence réellement posée et sa couverture', () => {
    const late = { ...routine, scheduleType: 'every_n_days' as const, interval: 14, startDate: asLocalDate('2026-10-20') };
    const result = plan('2026-10-07T10:00', { routines: [late] });
    expect(result.items.map(item => item.fireAt)).toEqual(['2026-10-20T07:00']);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-20T07:00' });
  });

  it('plafond au jour trois : la couverture désigne un rappel posé, jamais la fin visée', () => {
    const result = plan('2026-10-07T10:00', { limit: 3 });
    expect(result.items.map(item => item.fireAt)).toEqual(['2026-10-08T07:00', '2026-10-09T07:00', '2026-10-10T07:00']);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-10T07:00' });
    expect(plan('2026-10-07T10:00', { limit: 0 }).coverage).toEqual({ state: 'until', until: '2026-10-07T10:00' });
  });
});
