import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { Goal, Task } from '../../domain/model';
import { goalWeekNumber } from '../../domain/goalRules';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import type { LocalDate } from '../../domain/types';
import { createTaskUseCases } from '../tasks';
import { createGoalUseCases } from './goalUseCases';
import { loadPinnedGoalEntries } from './goalsSource';
import { seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

const d = (iso: string) => iso as LocalDate;

async function attached(h: GoalsHarness, goal: Goal, title: string, date: string | null, spaceId = SPACE_PRO_ID): Promise<Task> {
  h.db.clock.advance(1);
  const created = await createTaskUseCases(h.container).create({
    title,
    spaceId,
    date: date === null ? null : d(date),
    ...(date === null ? { someday: true } : {}),
    goalId: goal.id,
  });
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

const progress = async (h: GoalsHarness, goal: Goal) => (await h.container.data.repos.tasks.progressByGoal([goal.id])).get(goal.id);

describe('Lot OB, cas limites QA : semaine à cheval sur deux années (week_start lundi)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('901', '2027-01-01T10:00:00.000Z'); // ven. 1er janvier 2027, semaine ISO 53 de 2026
  });
  afterEach(() => teardownGoals(h));

  it('OB-01 un objectif créé le 1er janvier prend le lundi 28 déc. 2026 ; reconduit le lundi suivant (S53 puis S1)', async () => {
    const useCases = createGoalUseCases(h.container);
    const created = await useCases.create({ title: 'Fin d’année', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('création');
    expect(created.value.weekStart).toBe('2026-12-28');
    expect(goalWeekNumber(created.value.weekStart)).toBe(53);
    expect(goalWeekNumber(d('2027-01-04'))).toBe(1);
    h.db.clock.advance(3 * 86_400_000); // lun. 4 janvier 2027
    const next = await useCases.carryOver(created.value.id);
    expect(next).toMatchObject({ weekStart: '2027-01-04', carriedFromId: created.value.id });
    expect((await h.container.data.repos.goals.getById(created.value.id))?.status).toBe('closed');
  });

  it('OB-02 l’encadré est affiché du lundi 28 déc. au dimanche 3 janv., plus le lundi 4', async () => {
    await seedGoal(h, { weekStart: d('2026-12-28') });
    for (const day of ['2026-12-28', '2026-12-31', '2027-01-03']) expect(await loadPinnedGoalEntries(h.container, d(day), 'all')).toHaveLength(1);
    expect(await loadPinnedGoalEntries(h.container, d('2027-01-04'), 'all')).toHaveLength(0);
  });
});

describe('Lot OB, cas limites QA : avancement et rattachement', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('902'); // ven. 2 oct. 2026
  });
  afterEach(() => teardownGoals(h));

  it('OB-04 tâche rattachée supprimée : ne compte plus ; restaurée (annuler) : recompte', async () => {
    const goal = await seedGoal(h);
    const a = await attached(h, goal, 'A', '2026-10-02');
    await attached(h, goal, 'B', '2026-10-02');
    expect(await progress(h, goal)).toEqual({ done: 0, total: 2 });
    await createTaskUseCases(h.container).remove([a.id]);
    expect(await progress(h, goal)).toEqual({ done: 0, total: 1 });
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect(await progress(h, goal)).toEqual({ done: 0, total: 2 });
    expect((await h.container.data.repos.tasks.getById(a.id))?.goalId).toBe(goal.id);
  });

  it('OB-03 tâche reportée hors de la semaine : rattachement et avancement inchangés (critère 6)', async () => {
    const goal = await seedGoal(h);
    const t = await attached(h, goal, 'A', '2026-10-02');
    await createTaskUseCases(h.container).moveToDay(t.id, d('2026-10-14'));
    expect(await h.container.data.repos.tasks.getById(t.id)).toMatchObject({ goalId: goal.id, date: '2026-10-14' });
    expect(await progress(h, goal)).toEqual({ done: 0, total: 1 });
    expect((await h.container.data.repos.tasks.listByGoal(goal.id)).map((x) => x.id)).toContain(t.id);
  });

  it('OB-03 une tâche Perso se rattache à un objectif Pro ; le filtre Perso masque l’encadré, le compte la garde', async () => {
    const goal = await seedGoal(h, { spaceId: SPACE_PRO_ID });
    await attached(h, goal, 'Perso', '2026-10-02', SPACE_PERSO_ID);
    expect(await progress(h, goal)).toEqual({ done: 0, total: 1 });
    expect(await loadPinnedGoalEntries(h.container, d('2026-10-02'), SPACE_PERSO_ID)).toHaveLength(0);
    expect((await loadPinnedGoalEntries(h.container, d('2026-10-02'), SPACE_PRO_ID))[0]?.progress).toEqual({ done: 0, total: 1 });
  });

  it('OB-02 deux objectifs épinglés Pro et Perso : Tout 2 encadrés, Pro 1, Perso 1, chacun son avancement', async () => {
    const pro = await seedGoal(h, { title: 'Pro' });
    const perso = await seedGoal(h, { title: 'Perso', spaceId: SPACE_PERSO_ID });
    const t = await attached(h, pro, 'A', '2026-10-02');
    await h.container.data.repos.tasks.complete(t.id, new Date(h.db.clock.nowMs()).toISOString() as never);
    await attached(h, perso, 'B', '2026-10-02', SPACE_PERSO_ID);
    const all = await loadPinnedGoalEntries(h.container, d('2026-10-02'), 'all');
    expect(all.map((e) => [e.goal.title, e.progress.done, e.progress.total])).toEqual([
      ['Pro', 1, 1],
      ['Perso', 0, 1],
    ]);
    expect((await loadPinnedGoalEntries(h.container, d('2026-10-02'), SPACE_PRO_ID)).map((e) => e.goal.title)).toEqual(['Pro']);
    expect((await loadPinnedGoalEntries(h.container, d('2026-10-02'), SPACE_PERSO_ID)).map((e) => e.goal.title)).toEqual(['Perso']);
  });

  it('OB-04 occurrence récurrente rattachée terminée : « 1/1 », la prochaine occurrence ne gonfle pas le total', async () => {
    const goal = await seedGoal(h);
    const t = await attached(h, goal, 'Hebdo', '2026-10-02');
    const rule = defaultRecurrence('weekly', d('2026-10-02'));
    const rec = await createTaskUseCases(h.container).setRecurrence(t.id, rule);
    if (!rec.ok) throw new Error(rec.error);
    await createTaskUseCases(h.container).complete(t.id);
    expect(await progress(h, goal)).toEqual({ done: 1, total: 1 });
  });
});

describe('Lot OB, cas limites QA : reconduction (QB-14)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('903', '2026-09-30T08:00:00.000Z'); // mer. 30 sept.
  });
  afterEach(() => teardownGoals(h));

  it('OB-05 reconduire, annuler (Ctrl+Z), reconduire de nouveau : un seul nouvel objectif, dates correctes', async () => {
    const old = await seedGoal(h, { weekStart: d('2026-09-21') });
    const past = await attached(h, old, 'Vendredi', '2026-09-25');
    const keep = await attached(h, old, 'Datée dans la semaine', '2026-10-02');
    const useCases = createGoalUseCases(h.container);
    await useCases.carryOver(old.id);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect(await h.container.data.repos.tasks.getById(past.id)).toMatchObject({ goalId: old.id, date: '2026-09-25' });
    expect(await h.container.data.repos.tasks.getById(keep.id)).toMatchObject({ goalId: old.id, date: '2026-10-02' });
    const again = (await useCases.carryOver(old.id)) as Goal;
    expect(await h.container.data.repos.tasks.getById(past.id)).toMatchObject({ goalId: again.id, date: '2026-09-30' });
    expect(await h.container.data.repos.tasks.getById(keep.id)).toMatchObject({ goalId: again.id, date: '2026-10-02' });
    expect(await h.container.data.repos.goals.listForWeek(d('2026-09-28'), 'all')).toHaveLength(1);
  });

  it('OB-05 application fermée plusieurs semaines : reconduit dans la semaine en cours, plus reproposé', async () => {
    const old = await seedGoal(h, { weekStart: d('2026-09-14') });
    const repos = h.container.data.repos;
    const past = await attached(h, old, 'Ancienne', '2026-09-16');
    h.db.clock.advance(19 * 86_400_000); // lun. 19 oct.
    expect(await repos.goals.listOpenBefore(d('2026-10-19'))).toHaveLength(1);
    const created = (await createGoalUseCases(h.container).carryOver(old.id)) as Goal;
    expect(created.weekStart).toBe('2026-10-19');
    expect(await repos.tasks.getById(past.id)).toMatchObject({ goalId: created.id, date: '2026-10-19' });
    expect(await repos.goals.listOpenBefore(d('2026-10-19'))).toHaveLength(0);
    expect(await createGoalUseCases(h.container).carryOver(old.id)).toBeNull();
  });

  it('OB-05 pas de proposition avant le lundi suivant', async () => {
    await seedGoal(h, { weekStart: d('2026-09-21') });
    expect(await h.container.data.repos.goals.listOpenBefore(d('2026-09-21'))).toHaveLength(0);
    expect(await h.container.data.repos.goals.listOpenBefore(d('2026-09-28'))).toHaveLength(1);
  });

  it('OB-04 objectif atteint : plus proposé ni reconductible', async () => {
    const g = await seedGoal(h, { weekStart: d('2026-09-21') });
    await createGoalUseCases(h.container).setStatus(g.id, 'achieved');
    expect(await h.container.data.repos.goals.listOpenBefore(d('2026-09-28'))).toHaveLength(0);
    expect(await createGoalUseCases(h.container).carryOver(g.id)).toBeNull();
  });
});
