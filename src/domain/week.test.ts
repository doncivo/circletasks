import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import { sortTasksForDay } from './taskSchedule';
import { asEntityId, asLocalDate, asLocalTime, type SpaceId } from './types';
import { addWeeks, buildWeek, isoWeekOf, rowIndexForDrop, weekDays, weekStartOf } from './week';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const d = asLocalDate;

function task(id: string, date: string, over: Partial<Task> = {}): Task {
  return { id, spaceId: PRO, title: id, date: d(date), time: null, status: 'todo', sortOrder: 0, someday: false, deletedAt: null, ...over } as unknown as Task;
}

describe('weekStartOf / weekDays (S-01 critères 1 et 11)', () => {
  it('le lundi est le premier jour, quel que soit le jour de la semaine', () => {
    for (const day of ['2026-09-21', '2026-09-23', '2026-09-27']) expect(weekStartOf(d(day))).toBe('2026-09-21');
    expect(weekStartOf(d('2026-09-28'))).toBe('2026-09-28');
  });

  it('donne sept jours consécutifs du lundi au dimanche', () => {
    expect(weekDays(d('2026-09-21'))).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
  });

  it('traverse un changement de mois et d’année', () => {
    expect(weekDays(d('2026-12-28')).at(-1)).toBe('2027-01-03');
    expect(weekStartOf(d('2027-01-01'))).toBe('2026-12-28');
  });

  it('compte sept jours la semaine du changement d’heure (aucun effet de fuseau)', () => {
    expect(weekDays(d('2026-03-23'))).toEqual(['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']);
    expect(weekDays(d('2026-10-26')).at(-1)).toBe('2026-11-01');
  });

  it('addWeeks décale de semaines entières', () => {
    expect(addWeeks(d('2026-09-21'), 1)).toBe('2026-09-28');
    expect(addWeeks(d('2026-09-21'), -3)).toBe('2026-08-31');
  });
});

describe('isoWeekOf (S-01 critère 2)', () => {
  it('le 23 sept. 2026 est en semaine 39', () => {
    expect(isoWeekOf(d('2026-09-23'))).toEqual({ year: 2026, week: 39 });
    expect(isoWeekOf(d('2026-09-21'))).toEqual({ year: 2026, week: 39 });
    expect(isoWeekOf(d('2026-09-27'))).toEqual({ year: 2026, week: 39 });
  });

  it('2026 a 53 semaines : le 28 déc. 2026 est en semaine 53, le 4 janv. 2027 en semaine 1', () => {
    expect(isoWeekOf(d('2026-12-28'))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekOf(d('2027-01-03'))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekOf(d('2027-01-04'))).toEqual({ year: 2027, week: 1 });
  });

  it('le 1er janvier peut appartenir à la dernière semaine de l’année précédente', () => {
    expect(isoWeekOf(d('2021-01-01'))).toEqual({ year: 2020, week: 53 });
    expect(isoWeekOf(d('2024-12-30'))).toEqual({ year: 2025, week: 1 });
    expect(isoWeekOf(d('2025-01-01'))).toEqual({ year: 2025, week: 1 });
  });
});

// Le repository rend les tâches triées par ordre manuel (sort_order) avant le tri de journée.
const byManualOrder = (tasks: readonly Task[]): Task[] => [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);

describe('buildWeek (S-01 critères 4 et 6)', () => {
  const week = d('2026-09-21');

  it('répartit les tâches sur les sept jours et ignore celles d’une autre semaine', () => {
    const days = buildWeek({
      weekStart: week,
      filter: 'all',
      tasks: [task('lun', '2026-09-21'), task('mer', '2026-09-23'), task('dim', '2026-09-27'), task('apres', '2026-09-28'), task('avant', '2026-09-20')],
    });
    expect(days.map((day) => day.date)).toEqual(weekDays(week));
    expect(days.map((day) => day.list.rows.map((row) => row.id))).toEqual([['lun'], [], ['mer'], [], [], [], ['dim']]);
  });

  it('applique l’ordre du jour (Q11) à chaque jour : heures triées, puis sans heure dans l’ordre manuel', () => {
    const wednesday = [
      task('sans-b', '2026-09-23', { sortOrder: 20 }),
      task('14h', '2026-09-23', { time: asLocalTime('14:00'), sortOrder: 1 }),
      task('sans-a', '2026-09-23', { sortOrder: 10 }),
      task('9h', '2026-09-23', { time: asLocalTime('09:00'), sortOrder: 99 }),
    ];
    const friday = [task('v-sans', '2026-09-25', { sortOrder: 1 }), task('v-11h', '2026-09-25', { time: asLocalTime('11:00'), sortOrder: 2 })];
    const days = buildWeek({ weekStart: week, filter: 'all', tasks: [...wednesday, ...friday] });
    expect(days[2]?.list.rows.map((row) => row.id)).toEqual(['9h', '14h', 'sans-a', 'sans-b']);
    expect(days[4]?.list.rows.map((row) => row.id)).toEqual(['v-11h', 'v-sans']);
    // Même résultat que le tri de journée du domaine (revue T-02).
    expect(days[2]?.list.rows.map((row) => row.id)).toEqual(sortTasksForDay(byManualOrder(wednesday)).map((t) => t.id));
    expect(days[4]?.list.rows.map((row) => row.id)).toEqual(sortTasksForDay(byManualOrder(friday)).map((t) => t.id));
  });

  it('place les tâches terminées après les autres, barrées mais présentes', () => {
    const days = buildWeek({
      weekStart: week,
      filter: 'all',
      tasks: [task('faite', '2026-09-22', { status: 'done', time: asLocalTime('08:00') }), task('a-faire', '2026-09-22', { time: asLocalTime('18:00') })],
    });
    expect(days[1]?.list.rows.map((row) => row.id)).toEqual(['a-faire']);
    expect(days[1]?.list.doneRows.map((row) => row.id)).toEqual(['faite']);
  });

  it('applique le filtre d’espace aux sept jours (critère 6)', () => {
    const tasks = [task('pro', '2026-09-22'), task('perso', '2026-09-24', { spaceId: PERSO })];
    const pro = buildWeek({ weekStart: week, filter: PRO, tasks });
    expect(pro.flatMap((day) => day.list.rows.map((row) => row.id))).toEqual(['pro']);
    const all = buildWeek({ weekStart: week, filter: 'all', tasks });
    expect(all.flatMap((day) => day.list.rows.map((row) => row.id))).toEqual(['pro', 'perso']);
  });

  it('une tâche « Un jour » ou supprimée n’apparaît pas', () => {
    const days = buildWeek({
      weekStart: week,
      filter: 'all',
      tasks: [task('un-jour', '2026-09-22', { someday: true }), task('sup', '2026-09-22', { deletedAt: '2026-09-23T08:00:00.000Z' as never })],
    });
    expect(days.every((day) => day.list.isEmpty)).toBe(true);
  });

  it('place les événements fournis en tête du jour qui les reçoit', () => {
    const extras = new Map([
      [d('2026-09-23'), { events: [{ id: 'e', title: 'Point client', allDay: false, startTime: asLocalTime('10:00'), spaceId: null, calendarName: 'Google Agenda', icon: null }] }],
    ]);
    const days = buildWeek({ weekStart: week, filter: 'all', tasks: [task('a', '2026-09-23')], extras });
    expect(days[2]?.list.events.map((event) => event.id)).toEqual(['e']);
    expect(days[1]?.list.events).toEqual([]);
  });
});

describe('rowIndexForDrop (S-02 critère 10)', () => {
  const week = d('2026-09-21');
  const list = buildWeek({
    weekStart: week,
    filter: 'all',
    tasks: [
      task('9h', '2026-09-23', { time: asLocalTime('09:00') }),
      task('a', '2026-09-23', { sortOrder: 1 }),
      task('b', '2026-09-23', { sortOrder: 2 }),
      task('c', '2026-09-23', { sortOrder: 3 }),
      task('faite', '2026-09-23', { status: 'done', sortOrder: 4 }),
    ],
  }).at(2)?.list ?? { rows: [], doneRows: [] };

  it('compte les autres tâches au-dessus du pointeur', () => {
    // Ordre affiché : 9h, a, b, c | faite
    expect(rowIndexForDrop(list, 'c', 0)).toBe(0); // avant 9h (sera ramené derrière l'heure par moveTaskRow)
    expect(rowIndexForDrop(list, 'c', 2)).toBe(2); // avant « b »
    expect(rowIndexForDrop(list, 'a', 3)).toBe(3); // après « c », avant « faite » : fin des éléments à faire
    expect(rowIndexForDrop(list, 'a', 4)).toBe(3); // sous la tâche terminée : fin de liste
  });

  it('une position absurde est ramenée dans la liste', () => {
    expect(rowIndexForDrop(list, 'a', 99)).toBe(3);
    expect(rowIndexForDrop(list, 'a', -5)).toBe(0);
  });
});
