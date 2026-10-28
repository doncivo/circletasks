import { describe, expect, it } from 'vitest';
import type { Routine, Task } from './model';
import { asEntityId, asLocalDate, asLocalTime, type RoutineId, type SpaceId, type TaskId } from './types';
import { buildWeek } from './week';
import { weekSummary } from './weekSummary';

/**
 * UI-REFONTE-03 — ligne de synthèse de la Semaine (Semaine-v2.html) : « 8 tâches restantes · 6 faites · 1 en retard », comptée sur les
 * sept jours affichés, tâches seulement. « En retard » : tâche non faite d'un jour passé, ou du jour courant à l'heure dépassée.
 */

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const WEEK = asLocalDate('2026-09-21'); // lundi
const TODAY = asLocalDate('2026-09-23'); // mercredi

let n = 0;
function task(date: string, title: string, time: string | null = null, extra: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: asEntityId<TaskId>(`8000${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`),
    spaceId: PRO,
    projectId: null,
    title,
    date: asLocalDate(date),
    time: time === null ? null : asLocalTime(time),
    status: 'open',
    sortOrder: n,
    someday: false,
    carriedOver: false,
    recurrenceId: null,
    icon: null,
    note: null,
    goalId: null,
    deletedAt: null,
    ...extra,
  } as unknown as Task;
}

const routine = (title: string): Routine =>
  ({ id: asEntityId<RoutineId>('70000001-0000-4000-8000-000000000000'), spaceId: PRO, title, icon: null, time: asLocalTime('08:00'), paused: false, archived: false, deletedAt: null }) as unknown as Routine;

describe('weekSummary (UI-REFONTE-03, Semaine-v2.html)', () => {
  const tasks = [
    task('2026-09-21', 'Faire mon lit', null, { status: 'done' }),
    task('2026-09-21', 'Relire le contrat', null, { status: 'done' }),
    task('2026-09-22', 'Appeler la banque', '11:00', { status: 'done' }),
    task('2026-09-22', 'Oubliée lundi', null), // jour passé, non faite : en retard
    task('2026-09-23', 'Envoyer la facture', '09:00', { status: 'done' }),
    task('2026-09-23', 'Appeler le notaire', '14:00'), // aujourd'hui, heure dépassée à 14:32 : en retard
    task('2026-09-23', 'Sport', '18:00'),
    task('2026-09-24', 'Réunion d’équipe', '11:00'),
    task('2026-09-24', 'Préparer le dépôt GitHub'),
    task('2026-09-25', 'Clôture mensuelle', null, { spaceId: PERSO }),
    task('2026-09-26', 'Courses', null, { spaceId: PERSO }),
    task('2026-09-23', 'Faite plus tard', '20:00', { status: 'done' }),
  ];

  it('compte les restantes, les faites et les en retard sur les sept jours (jour passé, et jour courant à l’heure dépassée)', () => {
    const days = buildWeek({ weekStart: WEEK, filter: 'all', tasks });
    expect(weekSummary(days, TODAY, asLocalTime('14:32'))).toEqual({ remaining: 7, done: 5, late: 2, total: 12 });
  });

  it('à l’heure exacte, la tâche du jour n’est pas en retard ; sans heure courante (autre jour), seuls les jours passés comptent', () => {
    const days = buildWeek({ weekStart: WEEK, filter: 'all', tasks });
    expect(weekSummary(days, TODAY, asLocalTime('14:00')).late).toBe(1);
    expect(weekSummary(days, TODAY, null).late).toBe(1);
  });

  it('les jours futurs ne sont jamais en retard, même sans heure ; une semaine entièrement passée compte toutes ses restantes en retard', () => {
    const days = buildWeek({ weekStart: WEEK, filter: 'all', tasks });
    expect(weekSummary(days, asLocalDate('2026-09-21'), asLocalTime('23:59')).late).toBe(0);
    expect(weekSummary(days, asLocalDate('2026-10-05'), null).late).toBe(7);
  });

  it('suit le filtre d’espace et ignore routines, événements et checklists', () => {
    const days = buildWeek({
      weekStart: WEEK,
      filter: PERSO,
      tasks,
      extras: new Map([[asLocalDate('2026-09-23'), { routines: [{ routine: routine('Boire de l’eau'), done: false }], events: [{ id: 'e', title: 'Point client', allDay: false, startTime: asLocalTime('10:00'), spaceId: null, calendarName: 'Google Agenda', icon: null }], checklists: [] }]]),
    });
    expect(weekSummary(days, TODAY, asLocalTime('14:32'))).toEqual({ remaining: 2, done: 0, late: 0, total: 2 });
  });

  it('semaine vide : tout à zéro', () => {
    expect(weekSummary(buildWeek({ weekStart: WEEK, filter: 'all', tasks: [] }), TODAY, asLocalTime('14:32'))).toEqual({ remaining: 0, done: 0, late: 0, total: 0 });
  });
});
