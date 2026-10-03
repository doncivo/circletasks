import { describe, expect, it } from 'vitest';
import {
  carryOverGoal,
  goalProgress,
  goalsAvailableFor,
  goalsOfWeek,
  goalsToReview,
  goalWeekNumber,
  historyStatusOf,
  pinnedGoalsForWeek,
  progressPercent,
  validateGoalTitle,
} from './goalRules';
import type { Goal, Task } from './model';
import { asEntityId, asLocalDate, type GoalId, type SpaceId, type TaskId } from './types';

const PRO = '10000000-0000-4000-8000-000000000001' as SpaceId;
const PERSO = '10000000-0000-4000-8000-000000000002' as SpaceId;
const date = asLocalDate;

let counter = 0;
function goal(overrides: Partial<Goal> = {}): Goal {
  counter += 1;
  return {
    id: asEntityId<GoalId>(`c0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`),
    spaceId: PRO,
    weekStart: date('2026-09-28'),
    title: `Objectif ${counter}`,
    icon: null,
    pinned: true,
    status: 'open',
    carriedFromId: null,
    createdAt: `2026-09-28T08:00:${String(counter % 60).padStart(2, '0')}.000Z` as Goal['createdAt'],
    updatedAt: '2026-09-28T08:00:00.000Z' as Goal['updatedAt'],
    deletedAt: null,
    deviceId: 'd' as never,
    hlc: 'h' as never,
    ...overrides,
  } as Goal;
}

function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: asEntityId<TaskId>(`a0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`),
    status: 'todo',
    date: null,
    time: null,
    someday: false,
    deletedAt: null,
    ...overrides,
  } as Task;
}

describe('validateGoalTitle (OB-01 critère 5)', () => {
  it('accepte 1 à 200 caractères, espaces de bord retirés', () => {
    expect(validateGoalTitle('  Finaliser le PRD  ')).toEqual({ ok: true, value: 'Finaliser le PRD' });
    expect(validateGoalTitle('x'.repeat(200)).ok).toBe(true);
  });
  it('refuse le titre vide ou trop long', () => {
    expect(validateGoalTitle('   ')).toEqual({ ok: false, error: 'empty-title' });
    expect(validateGoalTitle('x'.repeat(201))).toEqual({ ok: false, error: 'title-too-long' });
  });
});

describe('pinnedGoalsForWeek (OB-02)', () => {
  const pro = goal({ title: 'Pro', spaceId: PRO });
  const perso = goal({ title: 'Perso', spaceId: PERSO });
  const unpinned = goal({ title: 'Non épinglé', pinned: false });
  const closed = goal({ title: 'Clos', status: 'closed' });
  const achieved = goal({ title: 'Atteint', status: 'achieved' });
  const old = goal({ title: 'Ancien', weekStart: date('2026-09-21') });
  const all = [pro, perso, unpinned, closed, achieved, old];

  it('tous les jours de la semaine, du lundi au dimanche (critère 1)', () => {
    for (const day of ['2026-09-28', '2026-10-01', '2026-10-04']) {
      expect(pinnedGoalsForWeek(all, date(day), 'all').map((g) => g.title)).toEqual(['Pro', 'Perso', 'Atteint']);
    }
  });
  it('plus d’encadré le lundi suivant (critère 3)', () => {
    expect(pinnedGoalsForWeek(all, date('2026-10-05'), 'all')).toEqual([]);
  });
  it('le filtre d’espace masque l’autre espace ; un encadré par objectif (critères 5 et 9)', () => {
    expect(pinnedGoalsForWeek(all, date('2026-10-01'), PRO).map((g) => g.title)).toEqual(['Pro', 'Atteint']);
    expect(pinnedGoalsForWeek(all, date('2026-10-01'), PERSO).map((g) => g.title)).toEqual(['Perso']);
  });
  it('ordre de création, et un objectif supprimé n’est jamais affiché', () => {
    const deleted = goal({ deletedAt: '2026-09-29T08:00:00.000Z' as never });
    expect(pinnedGoalsForWeek([perso, pro, deleted], date('2026-10-01'), 'all').map((g) => g.title)).toEqual(['Pro', 'Perso']);
  });
});

describe('goalsOfWeek', () => {
  it('filtre par semaine et par espace', () => {
    const a = goal();
    const b = goal({ spaceId: PERSO });
    const c = goal({ weekStart: date('2026-10-05') });
    expect(goalsOfWeek([a, b, c], date('2026-09-28'))).toEqual([a, b]);
    expect(goalsOfWeek([a, b, c], date('2026-09-28'), PERSO)).toEqual([b]);
  });
});

describe('goalsAvailableFor (OB-03 critères 7 et 8, QB-13)', () => {
  const pro = goal({ title: 'Pro', spaceId: PRO });
  const perso = goal({ title: 'Perso', spaceId: PERSO });
  const achieved = goal({ title: 'Atteint', status: 'achieved' });
  const next = goal({ title: 'Semaine suivante', weekStart: date('2026-10-05') });
  const goals = [pro, perso, achieved, next];

  it('objectifs ouverts de la semaine de la tâche, tous espaces confondus', () => {
    expect(goalsAvailableFor(date('2026-10-02'), date('2026-10-02'), goals).map((g) => g.title)).toEqual(['Pro', 'Perso']);
  });
  it('semaine de la date de la tâche, pas celle d’aujourd’hui', () => {
    expect(goalsAvailableFor(date('2026-10-06'), date('2026-10-02'), goals).map((g) => g.title)).toEqual(['Semaine suivante']);
  });
  it('tâche sans date : semaine en cours', () => {
    expect(goalsAvailableFor(null, date('2026-10-02'), goals).map((g) => g.title)).toEqual(['Pro', 'Perso']);
  });
  it('aucun objectif cette semaine : liste vide', () => {
    expect(goalsAvailableFor(date('2026-11-02'), date('2026-10-02'), goals)).toEqual([]);
  });
});

describe('goalProgress (OB-04)', () => {
  it('compte faites / total, sans les tâches supprimées (critères 1 et 3)', () => {
    const tasks = [task({ status: 'done' }), task({ status: 'done' }), task(), task(), task(), task({ deletedAt: '2026-10-01T00:00:00.000Z' as never, status: 'done' })];
    expect(goalProgress(tasks)).toEqual({ done: 2, total: 5 });
    expect(progressPercent({ done: 2, total: 5 })).toBe(40);
  });
  it('aucune tâche : 0 sur 0 et 0 %', () => {
    expect(goalProgress([])).toEqual({ done: 0, total: 0 });
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
  });
});

describe('goalsToReview (OB-05)', () => {
  const lastWeek = goal({ title: 'Semaine passée' });
  const older = goal({ title: 'Il y a deux semaines', weekStart: date('2026-09-21') });
  const achieved = goal({ status: 'achieved' });
  const closed = goal({ status: 'closed' });
  const current = goal({ weekStart: date('2026-10-05') });
  const goals = [lastWeek, older, achieved, closed, current];

  it('le lundi suivant : objectifs ouverts d’une semaine terminée, du plus ancien au plus récent (critères 1 et 2)', () => {
    expect(goalsToReview(date('2026-10-05'), goals).map((g) => g.title)).toEqual(['Il y a deux semaines', 'Semaine passée']);
  });
  it('encore proposé le mercredi (critère 2), jamais pendant la semaine de l’objectif', () => {
    expect(goalsToReview(date('2026-10-07'), goals)).toHaveLength(2);
    expect(goalsToReview(date('2026-10-04'), [lastWeek])).toEqual([]);
  });
  it('un objectif atteint ou clos ne déclenche rien (critère 6)', () => {
    expect(goalsToReview(date('2026-10-12'), [achieved, closed])).toEqual([]);
  });
  it('plusieurs objectifs de la même semaine : un chacun, filtrés par espace', () => {
    const perso = goal({ spaceId: PERSO });
    expect(goalsToReview(date('2026-10-05'), [lastWeek, perso])).toHaveLength(2);
    expect(goalsToReview(date('2026-10-05'), [lastWeek, perso], PERSO)).toEqual([perso]);
  });
});

describe('carryOverGoal (OB-05 critères 3 et 4, QB-14)', () => {
  const old = goal({ title: 'Finaliser le PRD', icon: { kind: 'emoji', value: '🎯' }, spaceId: PERSO, pinned: false });
  const newId = asEntityId<GoalId>('c0000000-0000-4000-8000-0000000000ff');
  const pastUndone = task({ date: date('2026-10-02'), time: '09:00' as never });
  const pastUndone2 = task({ date: date('2026-09-28') });
  const inNewWeek = task({ date: date('2026-10-06') });
  const later = task({ date: date('2026-10-20') });
  const someday = task({ date: null, someday: true });
  const undated = task({ date: null });
  const done = task({ status: 'done', date: date('2026-09-29') });
  const deleted = task({ deletedAt: '2026-10-01T00:00:00.000Z' as never, date: date('2026-09-29') });
  const tasks = [pastUndone, pastUndone2, inNewWeek, later, someday, undated, done, deleted];

  it('crée un objectif identique pour la semaine en cours, relié à l’ancien', () => {
    const plan = carryOverGoal(old, tasks, date('2026-10-07'), newId);
    expect(plan.goal).toEqual({
      id: newId,
      spaceId: PERSO,
      weekStart: date('2026-10-05'),
      title: 'Finaliser le PRD',
      icon: { kind: 'emoji', value: '🎯' },
      pinned: false,
      status: 'open',
      carriedFromId: old.id,
    });
  });
  it('rattache les tâches non faites ; seules celles restées dans le passé sont redatées', () => {
    const plan = carryOverGoal(old, tasks, date('2026-10-07'), newId);
    expect(plan.taskIds).toEqual([pastUndone.id, pastUndone2.id, inNewWeek.id, later.id, someday.id, undated.id]);
    expect(plan.redatedTaskIds).toEqual([pastUndone.id, pastUndone2.id]);
  });
  it('une tâche datée du premier jour de la nouvelle semaine garde sa date', () => {
    const monday = task({ date: date('2026-10-05') });
    expect(carryOverGoal(old, [monday], date('2026-10-07'), newId).redatedTaskIds).toEqual([]);
  });
});

describe('historique (OB-06)', () => {
  it('atteint → « achieved », sinon « notAchieved » (ouvert sans réponse compris)', () => {
    expect(historyStatusOf({ status: 'achieved' })).toBe('achieved');
    expect(historyStatusOf({ status: 'closed' })).toBe('notAchieved');
    expect(historyStatusOf({ status: 'open' })).toBe('notAchieved');
  });
  it('numéro de semaine ISO', () => {
    expect(goalWeekNumber(date('2026-09-21'))).toBe(39);
    expect(goalWeekNumber(date('2026-09-14'))).toBe(38);
    expect(goalWeekNumber(date('2025-12-29'))).toBe(1);
  });
});
