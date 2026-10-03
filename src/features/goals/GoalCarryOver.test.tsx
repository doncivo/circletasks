import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import type { Goal, Task } from '../../domain/model';
import type { LocalDate, LocalTime, ReminderId } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { UndoToast } from '../app/UndoToast';
import { TodayScreen } from '../today/TodayScreen';
import { createTaskUseCases } from '../tasks';
import { goalsStore } from './goalsStore';
import { createGoalUseCases } from './goalUseCases';
import { registerGoalsSource, unregisterGoalsSource } from './goalsSource';
import { mockViewport, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

const date = (iso: string) => iso as LocalDate;
const WED_30_SEPT = '2026-09-30T08:00:00.000Z'; // mer. 30 sept. 10:00 à Paris
const MON_5_OCT = '2026-10-05T08:00:00.000Z';

async function task(h: GoalsHarness, title: string, goal: Goal | null, over: { date?: string | null; time?: string; done?: boolean; someday?: boolean } = {}): Promise<Task> {
  h.db.clock.advance(1);
  const created = await createTaskUseCases(h.container).create({
    title,
    spaceId: SPACE_PRO_ID,
    date: over.someday ? null : over.date === undefined ? date('2026-09-25') : over.date === null ? null : date(over.date),
    ...(over.someday ? { someday: true } : {}),
    ...(over.time ? { time: over.time as LocalTime } : {}),
    ...(goal ? { goalId: goal.id } : {}),
  });
  if (!created.ok) throw new Error(created.error);
  if (!over.done) return created.value;
  return h.container.data.repos.tasks.complete(created.value.id, new Date(h.db.clock.nowMs()).toISOString() as never);
}

describe('Reconduire ou clore un objectif non atteint : cas d’usage (OB-05)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('351', WED_30_SEPT);
  });
  afterEach(() => teardownGoals(h));

  const repos = () => h.container.data.repos;

  it('reconduire un mercredi : ancien objectif clos, nouveau identique pour la semaine en cours, relié à l’ancien (critère 3)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21'), title: 'Finaliser le PRD', icon: { kind: 'emoji', value: '🎯' }, spaceId: SPACE_PERSO_ID, pinned: true });
    const created = await createGoalUseCases(h.container).carryOver(old.id);
    expect(created).toMatchObject({ title: 'Finaliser le PRD', icon: { kind: 'emoji', value: '🎯' }, spaceId: SPACE_PERSO_ID, pinned: true, status: 'open', weekStart: '2026-09-28', carriedFromId: old.id });
    expect((await repos().goals.getById(old.id))?.status).toBe('closed');
  });

  it('les tâches non faites passent au nouvel objectif ; celles du passé prennent la date du jour de réponse, heure conservée (critère 4, QB-14)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    const past = await task(h, 'Vendredi passé', old, { date: '2026-09-25', time: '09:00' });
    const alreadyInNewWeek = await task(h, 'Déjà datée de la nouvelle semaine', old, { date: '2026-10-02' });
    const today = await task(h, 'Datée du jour', old, { date: '2026-09-30' });
    const later = await task(h, 'Plus tard', old, { date: '2026-10-20' });
    const someday = await task(h, 'Un jour', old, { someday: true });
    const done = await task(h, 'Faite', old, { date: '2026-09-24', done: true });
    await repos().reminders.replaceForTarget({ type: 'task', id: past.id }, [
      { id: newEntityId<ReminderId>(h.container.ids), targetType: 'task', targetId: past.id, offsetMin: 0, fireAt: '2026-09-25T09:00' as never },
    ]);

    const created = (await createGoalUseCases(h.container).carryOver(old.id)) as Goal;
    const get = async (t: Task) => (await repos().tasks.getById(t.id)) as Task;

    expect(await get(past)).toMatchObject({ goalId: created.id, date: '2026-09-30', time: '09:00', carriedOver: true });
    expect(await get(alreadyInNewWeek)).toMatchObject({ goalId: created.id, date: '2026-10-02' });
    expect(await get(today)).toMatchObject({ goalId: created.id, date: '2026-09-30' });
    expect(await get(later)).toMatchObject({ goalId: created.id, date: '2026-10-20' });
    expect(await get(someday)).toMatchObject({ goalId: created.id, date: null, someday: true });
    // Les tâches faites restent sur l'ancien objectif.
    expect(await get(done)).toMatchObject({ goalId: old.id, status: 'done' });
    // L'heure flottante garde son rappel recalculé sur la nouvelle date.
    const [reminder] = await repos().reminders.listForTarget({ type: 'task', id: past.id });
    expect(reminder?.fireAt.startsWith('2026-09-30T09:00')).toBe(true);
  });

  it('la reconduction est publiée dans la source unique (listes à jour) et ne se rejoue pas (critère 8)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    const past = await task(h, 'Vendredi passé', old, { date: '2026-09-25' });
    const useCases = createGoalUseCases(h.container);
    await useCases.carryOver(old.id);
    expect(h.container.taskEntities.get(past.id)?.date).toBe('2026-09-30');
    // Déjà répondu (autre appareil, double clic) : aucun doublon.
    expect(await useCases.carryOver(old.id)).toBeNull();
    expect(await repos().goals.listForWeek(date('2026-09-28'), 'all')).toHaveLength(1);
  });

  it('un objectif atteint, clos ou de la semaine en cours ne se reconduit pas (critère 6)', async () => {
    const achieved = await seedGoal(h, { weekStart: date('2026-09-21'), status: 'achieved' });
    const closed = await seedGoal(h, { weekStart: date('2026-09-21'), status: 'closed' });
    const current = await seedGoal(h, { weekStart: date('2026-09-28') });
    const useCases = createGoalUseCases(h.container);
    expect(await useCases.carryOver(achieved.id)).toBeNull();
    expect(await useCases.carryOver(closed.id)).toBeNull();
    expect(await useCases.carryOver(current.id)).toBeNull();
    expect(await useCases.close(achieved.id)).toBe(false);
  });

  it('clore : l’objectif passe à clos, ses tâches non faites gardent date et rattachement (critère 5)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    const past = await task(h, 'Vendredi passé', old, { date: '2026-09-25' });
    expect(await createGoalUseCases(h.container).close(old.id)).toBe(true);
    expect((await repos().goals.getById(old.id))?.status).toBe('closed');
    expect(await repos().tasks.getById(past.id)).toMatchObject({ goalId: old.id, date: '2026-09-25' });
    expect(await repos().goals.listForWeek(date('2026-09-28'), 'all')).toEqual([]);
  });

  it('annuler la reconduction rétablit les deux objectifs, le rattachement et les dates (critère 7)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    const past = await task(h, 'Vendredi passé', old, { date: '2026-09-25', time: '09:00' });
    const created = (await createGoalUseCases(h.container).carryOver(old.id)) as Goal;
    const result = await h.container.undo.undoLast();
    expect(result.status).toBe('undone');
    expect((await repos().goals.getById(old.id))?.status).toBe('open');
    expect(await repos().goals.getById(created.id)).toBeNull();
    expect(await repos().tasks.getById(past.id)).toMatchObject({ goalId: old.id, date: '2026-09-25', time: '09:00', carriedOver: false });
    expect(h.container.taskEntities.get(past.id)?.date).toBe('2026-09-25');
  });

  it('annuler la reconduction après modification du nouvel objectif : rien n’est écrit', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    const created = (await createGoalUseCases(h.container).carryOver(old.id)) as Goal;
    h.db.clock.advance(1000);
    await createGoalUseCases(h.container).setTitle(created.id, 'Modifié');
    expect((await h.container.undo.undoLast()).status).toBe('stale');
    expect((await repos().goals.getById(created.id))?.title).toBe('Modifié');
    expect((await repos().goals.getById(old.id))?.status).toBe('closed');
  });

  it('annuler « Clore » rouvre l’objectif, qui est de nouveau proposé (critère 7)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21') });
    await createGoalUseCases(h.container).close(old.id);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect((await repos().goals.getById(old.id))?.status).toBe('open');
    expect(await repos().goals.listOpenBefore(date('2026-09-28'))).toHaveLength(1);
  });
});

describe('Cartes « Reconduire / Clore » en tête d’Aujourd’hui (OB-05)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('352', MON_5_OCT);
    mockViewport(440);
    registerGoalsSource();
  });
  afterEach(async () => {
    unregisterGoalsSource();
    await teardownGoals(h);
  });

  const renderToday = () =>
    render(
      <AppContainerProvider container={h.container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );

  it('le lundi suivant, une carte « Objectif non atteint : … » avec « Reconduire » et « Clore » (critère 1)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Finaliser le PRD' });
    renderToday();
    const list = await screen.findByRole('list', { name: 'Objectifs à réviser' });
    expect(within(list).getByText('Objectif non atteint : Finaliser le PRD')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /^Reconduire/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /^Clore/ })).toBeInTheDocument();
  });

  it('la carte reste proposée le mercredi, une par objectif concerné (critère 2)', async () => {
    h.db.clock.set('2026-10-07T08:00:00.000Z');
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Premier' });
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Second', spaceId: SPACE_PERSO_ID });
    renderToday();
    await waitFor(() => expect(screen.getAllByText(/^Objectif non atteint :/)).toHaveLength(2));
  });

  it('« Reconduire » crée le nouvel objectif (encadré), clôt l’ancien et retire la carte ; « Annuler » rétablit', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Finaliser le PRD' });
    renderToday();
    fireEvent.click(await screen.findByRole('button', { name: /^Reconduire/ }));
    await waitFor(() => expect(screen.queryByText(/^Objectif non atteint :/)).toBeNull());
    expect((await h.container.data.repos.goals.getById(old.id))?.status).toBe('closed');
    await waitFor(() => expect(document.querySelectorAll('.ct-today-goal')).toHaveLength(1));
    expect(document.querySelector('.ct-today-goal')).toHaveTextContent('Finaliser le PRD');
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.getByText('Objectif non atteint : Finaliser le PRD')).toBeInTheDocument());
    expect(document.querySelectorAll('.ct-today-goal')).toHaveLength(0);
  });

  it('« Clore » retire la carte sans créer d’objectif (critère 5)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-28') });
    renderToday();
    fireEvent.click(await screen.findByRole('button', { name: /^Clore/ }));
    await waitFor(() => expect(screen.queryByText(/^Objectif non atteint :/)).toBeNull());
    expect((await h.container.data.repos.goals.getById(old.id))?.status).toBe('closed');
    expect(await h.container.data.repos.goals.listForWeek(date('2026-10-05'), 'all')).toEqual([]);
  });

  it('un objectif atteint ou déjà clos ne déclenche aucune proposition (critère 6)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-28'), status: 'achieved' });
    await seedGoal(h, { weekStart: date('2026-09-28'), status: 'closed' });
    renderToday();
    await screen.findByRole('button', { name: 'Ajouter' });
    await act(async () => undefined);
    expect(screen.queryByRole('list', { name: 'Objectifs à réviser' })).toBeNull();
  });

  it('le filtre d’espace s’applique aux cartes', async () => {
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Pro', spaceId: SPACE_PRO_ID });
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'Perso', spaceId: SPACE_PERSO_ID });
    renderToday();
    await waitFor(() => expect(screen.getAllByText(/^Objectif non atteint :/)).toHaveLength(2));
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    expect(screen.getAllByText(/^Objectif non atteint :/)).toHaveLength(1);
    expect(screen.getByText('Objectif non atteint : Perso')).toBeInTheDocument();
  });

  it('le calcul des propositions suit le store partagé (démarrage : loadReviews)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-28') });
    await goalsStore.get(h.container).getState().loadReviews(date('2026-10-05'));
    expect(goalsStore.get(h.container).getState().reviews).toHaveLength(1);
    await goalsStore.get(h.container).getState().loadReviews(date('2026-10-02'));
    // Même semaine que l'objectif : rien à réviser.
    expect(goalsStore.get(h.container).getState().reviews).toHaveLength(0);
  });
});
