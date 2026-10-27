import { describe, expect, it } from 'vitest';
import type { Goal, Routine, Task } from './model';
import { buildTodayAgenda, lateMinutes, type AgendaLine } from './todayAgenda';
import { buildTodayList, type TodayEventEntry } from './todayList';
import { asEntityId, asLocalDate, asLocalTime, type RoutineId, type SpaceId, type TaskId } from './types';

/**
 * UI-REFONTE-02 — l'agenda du jour (Jour.html) : lignes triées par heure, ligne « maintenant » insérée à l'heure courante,
 * ce qui est passé recule, ce qui est dû (tâche à l'heure non faite, heure passée) se place juste avant « maintenant »,
 * les éléments sans heure viennent après tout le reste, les faits restent à leur heure.
 */

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const DAY = asLocalDate('2026-09-23');

function task(id: string, title: string, time: string | null, extra: Partial<Task> = {}): Task {
  return {
    id: asEntityId<TaskId>(`8000000${id}-0000-4000-8000-000000000000`),
    spaceId: PRO,
    projectId: null,
    title,
    date: DAY,
    time: time === null ? null : asLocalTime(time),
    status: 'open',
    sortOrder: Number(id),
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

function routine(id: string, title: string, time: string | null): Routine {
  return {
    id: asEntityId<RoutineId>(`7000000${id}-0000-4000-8000-000000000000`),
    spaceId: PRO,
    title,
    icon: null,
    time: time === null ? null : asLocalTime(time),
    paused: false,
    archived: false,
    deletedAt: null,
  } as unknown as Routine;
}

function event(id: string, title: string, time: string | null, allDay = false): TodayEventEntry {
  return { id, title, allDay, startTime: time === null ? null : asLocalTime(time), spaceId: null, calendarName: 'Google Agenda', icon: null };
}

const summarize = (lines: readonly AgendaLine[]): string[] =>
  lines.map((line) => {
    if (line.kind === 'now') return `now@${line.time}`;
    const title = line.kind === 'event' ? line.event.title : line.row.kind === 'task' ? line.row.task.title : line.row.routine.title;
    return `${line.phase}:${line.time ?? '—'}:${title}`;
  });

describe('buildTodayAgenda (UI-REFONTE-02, Jour.html)', () => {
  const list = buildTodayList({
    date: DAY,
    filter: 'all',
    tasks: [
      task('1', 'Envoyer la facture', '09:00', { status: 'done' }),
      task('2', 'Appeler le notaire', '14:00'),
      task('3', 'Préparer le dépôt GitHub', null),
      task('4', 'Faire mon lit', null, { status: 'done' }),
      task('5', 'Relire le contrat', '16:30'),
    ],
    routines: [
      { routine: routine('1', 'Boire de l’eau', '08:30'), done: true },
      { routine: routine('2', 'Sport', '18:00'), done: false },
    ],
    events: [event('e1', 'Point client', '10:00'), event('e2', 'Anniversaire de Lina', null, true)],
  });

  it('le jour courant : passé atténué, dû juste avant « maintenant », à venir, puis sans heure ; les faits restent à leur heure', () => {
    const lines = buildTodayAgenda(list, asLocalTime('14:32'));
    expect(summarize(lines)).toEqual([
      'allDay:—:Anniversaire de Lina',
      'past:08:30:Boire de l’eau',
      'past:09:00:Envoyer la facture',
      'past:10:00:Point client',
      'due:14:00:Appeler le notaire',
      'now@14:32',
      'upcoming:16:30:Relire le contrat',
      'upcoming:18:00:Sport',
      'untimed:—:Préparer le dépôt GitHub',
      'untimed:—:Faire mon lit',
    ]);
  });

  it('le retard d’une tâche due est donné en minutes ; rien pour les autres lignes', () => {
    const lines = buildTodayAgenda(list, asLocalTime('14:32'));
    const due = lines.find((line) => line.kind === 'row' && line.phase === 'due');
    expect(due && due.kind === 'row' ? due.lateMinutes : null).toBe(32);
    for (const line of lines) if (line.kind === 'row' && line.phase !== 'due') expect(line.lateMinutes).toBeNull();
  });

  it('une routine ou un événement dont l’heure est passée recule sans être « dû » ; une tâche faite à l’heure passée aussi', () => {
    const lines = buildTodayAgenda(list, asLocalTime('18:30'));
    expect(summarize(lines)).toEqual([
      'allDay:—:Anniversaire de Lina',
      'past:08:30:Boire de l’eau',
      'past:09:00:Envoyer la facture',
      'past:10:00:Point client',
      'past:18:00:Sport',
      'due:14:00:Appeler le notaire',
      'due:16:30:Relire le contrat',
      'now@18:30',
      'untimed:—:Préparer le dépôt GitHub',
      'untimed:—:Faire mon lit',
    ]);
  });

  it('à l’heure exacte, la ligne n’est ni passée ni due : elle vient après « maintenant »', () => {
    const lines = buildTodayAgenda(list, asLocalTime('14:00'));
    const index = (title: string) => summarize(lines).findIndex((line) => line.endsWith(`:${title}`));
    expect(index('Appeler le notaire')).toBeGreaterThan(summarize(lines).indexOf('now@14:00'));
    expect(summarize(lines)).toContain('upcoming:14:00:Appeler le notaire');
  });

  it('avant la première ligne, « maintenant » précède tout ce qui est à l’heure ; après la dernière, il suit tout', () => {
    const early = summarize(buildTodayAgenda(list, asLocalTime('06:00')));
    expect(early.indexOf('now@06:00')).toBe(1); // après la journée entière
    const late = summarize(buildTodayAgenda(list, asLocalTime('23:59')));
    expect(late.indexOf('now@23:59')).toBe(late.indexOf('untimed:—:Préparer le dépôt GitHub') - 1);
  });

  it('un autre jour que le jour courant : pas de « maintenant », rien de passé ni de dû, lignes triées par heure puis sans heure', () => {
    const lines = buildTodayAgenda(list, null);
    expect(summarize(lines)).toEqual([
      'allDay:—:Anniversaire de Lina',
      'upcoming:08:30:Boire de l’eau',
      'upcoming:09:00:Envoyer la facture',
      'upcoming:10:00:Point client',
      'upcoming:14:00:Appeler le notaire',
      'upcoming:16:30:Relire le contrat',
      'upcoming:18:00:Sport',
      'untimed:—:Préparer le dépôt GitHub',
      'untimed:—:Faire mon lit',
    ]);
  });

  it('à heure égale : événement, puis routine, puis tâches dans l’ordre manuel', () => {
    const same = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [task('2', 'Seconde', '09:00'), task('1', 'Première', '09:00')],
      routines: [{ routine: routine('1', 'Routine', '09:00'), done: false }],
      events: [event('e', 'Événement', '09:00')],
    });
    expect(summarize(buildTodayAgenda(same, null)).map((line) => line.split(':').pop())).toEqual(['Événement', 'Routine', 'Première', 'Seconde']);
  });

  it('sans heure : les tâches à faire dans l’ordre manuel, puis les faites ; une liste vide donne seulement « maintenant »', () => {
    const untimed = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [task('3', 'Troisième', null), task('1', 'Première faite', null, { status: 'done' }), task('2', 'Deuxième', null)],
    });
    expect(summarize(buildTodayAgenda(untimed, asLocalTime('09:00')))).toEqual(['now@09:00', 'untimed:—:Deuxième', 'untimed:—:Troisième', 'untimed:—:Première faite']);
    expect(summarize(buildTodayAgenda(buildTodayList({ date: DAY, filter: 'all', tasks: [] }), asLocalTime('09:00')))).toEqual(['now@09:00']);
  });

  it('les objectifs et checklists ne sont pas des lignes de l’agenda', () => {
    const withGoal = buildTodayList({
      date: DAY,
      filter: 'all',
      tasks: [],
      goals: [{ goal: { id: 'g', spaceId: PRO, title: 'Finaliser le PRD', icon: null, weekStart: '2026-09-21', pinned: true, status: 'open', createdAt: '2026-09-21T08:00:00.000Z', deletedAt: null } as unknown as Goal, progress: { done: 2, total: 5 } }],
    });
    expect(buildTodayAgenda(withGoal, null)).toEqual([]);
  });

  it('lateMinutes : différence en minutes entre l’heure courante et l’heure de la ligne', () => {
    expect(lateMinutes(asLocalTime('14:00'), asLocalTime('14:32'))).toBe(32);
    expect(lateMinutes(asLocalTime('08:15'), asLocalTime('10:05'))).toBe(110);
    expect(lateMinutes(asLocalTime('10:00'), asLocalTime('10:00'))).toBe(0);
  });
});
