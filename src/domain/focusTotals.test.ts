import { describe, expect, it } from 'vitest';
import { daySpan, focusTotalMinutes, focusTotals, focusTotalsByTask, localDaysSpan, monthSpan, weekSpan } from './focusTotals';
import type { FocusSessionRecord } from './focusSession';
import { ALL_ITEMS, type ItemFilter } from './itemFilter';
import { asEntityId, type IsoDateTime, type LocalDate, type ProjectId, type SpaceId, type TaskId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-000000000001');
const tid = (n: number) => asEntityId<TaskId>(`20000000-0000-4000-8000-00000000000${String(n)}`);
const d = (value: string) => value as LocalDate;

/** Instant UTC d'une heure murale LOCALE de l'appareil (les tests ne dépendent pas du fuseau de la machine). */
const local = (y: number, m: number, day: number, h: number, min: number): IsoDateTime => new Date(y, m - 1, day, h, min).toISOString() as IsoDateTime;

let counter = 0;
const session = (taskId: TaskId | null, spaceId: SpaceId, startedAt: IsoDateTime, minutes: number | null, pausedSec = 0): FocusSessionRecord => ({
  id: `40000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}` as never,
  taskId,
  spaceId,
  plannedMin: 25,
  startedAt,
  endedAt: minutes === null ? null : (new Date(Date.parse(startedAt) + minutes * 60_000 + pausedSec * 1000).toISOString() as IsoDateTime),
  pausedSec,
  pausedAt: null,
});

const tasks = new Map<TaskId, { projectId: ProjectId | null }>([
  [tid(1), { projectId: MISSION }],
  [tid(2), { projectId: null }],
  [tid(3), { projectId: MISSION }],
]);
const f = (space: ItemFilter['space'], project: ItemFilter['project'] = null): ItemFilter => ({ space, project });

describe('plages locales', () => {
  it('un jour local va de minuit à minuit du fuseau de l’appareil', () => {
    const span = daySpan(d('2026-10-04'));
    expect(span.from).toBe(local(2026, 10, 4, 0, 0));
    expect(span.to).toBe(local(2026, 10, 5, 0, 0));
  });

  it('critère 7 : la semaine suit le premier jour choisi (P-03) : lundi, samedi, dimanche', () => {
    // Le dimanche 4 octobre 2026 : semaine du lundi 28 sept., du samedi 3 oct., du dimanche 4 oct.
    expect(weekSpan(d('2026-10-04'), 'monday').from).toBe(local(2026, 9, 28, 0, 0));
    expect(weekSpan(d('2026-10-04'), 'monday').to).toBe(local(2026, 10, 5, 0, 0));
    expect(weekSpan(d('2026-10-04'), 'saturday').from).toBe(local(2026, 10, 3, 0, 0));
    expect(weekSpan(d('2026-10-04'), 'sunday')).toEqual({ from: local(2026, 10, 4, 0, 0), to: local(2026, 10, 11, 0, 0) });
  });

  it('le mois civil, y compris décembre', () => {
    expect(monthSpan(d('2026-10-17'))).toEqual({ from: local(2026, 10, 1, 0, 0), to: local(2026, 11, 1, 0, 0) });
    expect(monthSpan(d('2026-12-31'))).toEqual({ from: local(2026, 12, 1, 0, 0), to: local(2027, 1, 1, 0, 0) });
  });

  it('plage de plusieurs jours', () => {
    expect(localDaysSpan(d('2026-10-01'), d('2026-10-03'))).toEqual({ from: local(2026, 10, 1, 0, 0), to: local(2026, 10, 4, 0, 0) });
  });
});

describe('totaux de concentration (F-03)', () => {
  const today = daySpan(d('2026-10-04'));

  it('critère 1 : trois sessions de 45 + 20 + 10 min = 75 min, 3 sessions', () => {
    const sessions = [
      session(tid(1), PRO, local(2026, 10, 4, 9, 0), 45),
      session(tid(2), PRO, local(2026, 10, 4, 11, 0), 20),
      session(null, PERSO, local(2026, 10, 4, 15, 0), 10),
    ];
    const total = focusTotals(sessions, tasks, ALL_ITEMS, today);
    expect(total.sessions).toBe(3);
    expect(focusTotalMinutes(total)).toBe(75);
  });

  it('critère 2 : aucune session, zéro', () => {
    expect(focusTotals([], tasks, ALL_ITEMS, today)).toEqual({ seconds: 0, sessions: 0 });
  });

  it('une session en cours n’est pas comptée', () => {
    expect(focusTotals([session(tid(1), PRO, local(2026, 10, 4, 9, 0), null)], tasks, ALL_ITEMS, today).sessions).toBe(0);
  });

  it('les pauses sont retirées : 30 min de présence dont 5 de pause = 25 min', () => {
    const total = focusTotals([session(tid(1), PRO, local(2026, 10, 4, 9, 0), 25, 300)], tasks, ALL_ITEMS, today);
    expect(focusTotalMinutes(total)).toBe(25);
  });

  it('D2 : une session compte au jour de son début, même si elle franchit minuit', () => {
    const late = session(tid(1), PRO, local(2026, 10, 4, 23, 40), 50);
    expect(focusTotals([late], tasks, ALL_ITEMS, today).sessions).toBe(1);
    expect(focusTotals([late], tasks, ALL_ITEMS, daySpan(d('2026-10-05'))).sessions).toBe(0);
  });

  it('les bornes : minuit pile appartient au jour qui commence', () => {
    const midnight = session(tid(1), PRO, local(2026, 10, 5, 0, 0), 30);
    expect(focusTotals([midnight], tasks, ALL_ITEMS, today).sessions).toBe(0);
    expect(focusTotals([midnight], tasks, ALL_ITEMS, daySpan(d('2026-10-05'))).sessions).toBe(1);
  });

  it('critère 5 : filtre Pro puis projet « Mission client » (ES-08) ; sans projet, seulement dans « Tous les projets »', () => {
    const sessions = [
      session(tid(1), PRO, local(2026, 10, 4, 9, 0), 25), // Pro / Mission
      session(tid(3), PRO, local(2026, 10, 4, 10, 0), 30), // Pro / Mission
      session(tid(2), PRO, local(2026, 10, 4, 11, 0), 20), // Pro sans projet
      session(null, PRO, local(2026, 10, 4, 12, 0), 15), // Pro sans tâche
      session(tid(1), PERSO, local(2026, 10, 4, 13, 0), 10), // espace propre de la session : Perso
    ];
    expect(focusTotalMinutes(focusTotals(sessions, tasks, f(PRO, MISSION), today))).toBe(55);
    expect(focusTotalMinutes(focusTotals(sessions, tasks, f(PRO), today))).toBe(90);
    expect(focusTotalMinutes(focusTotals(sessions, tasks, f(PERSO), today))).toBe(10);
    expect(focusTotalMinutes(focusTotals(sessions, tasks, ALL_ITEMS, today))).toBe(100);
  });

  it('critère 8 : une tâche supprimée ne change jamais le total (sans filtre de projet)', () => {
    const sessions = [session(tid(1), PRO, local(2026, 10, 4, 9, 0), 25)];
    const withTask = focusTotals(sessions, tasks, ALL_ITEMS, today);
    const withoutTask = focusTotals(sessions, new Map<TaskId, { projectId: ProjectId | null }>(), ALL_ITEMS, today);
    expect(withoutTask).toEqual(withTask);
    expect(focusTotals(sessions, new Map<TaskId, { projectId: ProjectId | null }>(), f(PRO), today)).toEqual(withTask);
  });

  it('semaine et mois : cumul des jours de la plage seulement', () => {
    const sessions = [
      session(tid(1), PRO, local(2026, 9, 27, 18, 0), 60), // dimanche d'avant (semaine lundi)
      session(tid(1), PRO, local(2026, 9, 28, 9, 0), 25),
      session(tid(1), PRO, local(2026, 10, 4, 9, 0), 35),
      session(tid(1), PRO, local(2026, 10, 5, 9, 0), 40), // semaine suivante
    ];
    expect(focusTotalMinutes(focusTotals(sessions, tasks, ALL_ITEMS, weekSpan(d('2026-10-04'), 'monday')))).toBe(60);
    expect(focusTotalMinutes(focusTotals(sessions, tasks, ALL_ITEMS, monthSpan(d('2026-10-04'))))).toBe(75); // octobre seulement : 35 + 40
  });

  it('les cinq tâches les plus travaillées du mois, du plus au moins travaillé', () => {
    const sessions = [
      session(tid(1), PRO, local(2026, 10, 2, 9, 0), 75),
      session(tid(1), PRO, local(2026, 10, 3, 9, 0), 75),
      session(tid(3), PRO, local(2026, 10, 4, 9, 0), 100),
      session(tid(2), PRO, local(2026, 10, 4, 12, 0), 20),
      session(null, PRO, local(2026, 10, 4, 14, 0), 500),
    ];
    const top = focusTotalsByTask(sessions, tasks, ALL_ITEMS, monthSpan(d('2026-10-04')), 5);
    expect(top.map((entry) => [entry.taskId, focusTotalMinutes(entry), entry.sessions])).toEqual([
      [tid(1), 150, 2],
      [tid(3), 100, 1],
      [tid(2), 20, 1],
    ]);
    expect(focusTotalsByTask(sessions, tasks, ALL_ITEMS, monthSpan(d('2026-10-04')), 1)).toHaveLength(1);
    expect(focusTotalsByTask(sessions, tasks, f(PRO, MISSION), monthSpan(d('2026-10-04')), 5).map((entry) => entry.taskId)).toEqual([tid(1), tid(3)]);
  });
});
