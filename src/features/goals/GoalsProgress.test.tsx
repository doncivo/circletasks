import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { Goal, Task } from '../../domain/model';
import type { LocalDate } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { UndoToast } from '../app/UndoToast';
import { TodayScreen } from '../today/TodayScreen';
import { seedTask } from '../today/testKit';
import { registerGoalsSource, unregisterGoalsSource } from './goalsSource';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
async function attach(h: GoalsHarness, goal: Goal, titles: readonly string[], done: readonly string[] = [], extra: Partial<{ spaceId: typeof SPACE_PRO_ID }> = {}): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const title of titles) {
    const task = await seedTask(h, { title, ...(extra.spaceId ? { spaceId: extra.spaceId } : {}) });
    let written = await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    if (done.includes(title)) written = await h.container.data.repos.tasks.complete(task.id, new Date(h.db.clock.nowMs()).toISOString() as never);
    tasks.push(written);
  }
  return tasks;
}

const bar = () => screen.getByRole('progressbar', { name: 'Avancement de l’objectif' });

describe('Avancement de l’objectif (OB-04), écran Objectif', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('341');
    mockViewport(440);
  });
  afterEach(() => teardownGoals(h));

  it('5 tâches dont 2 faites : « 2 faites sur 5 » et barre à 40 % (critère 1)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A', 'B', 'C', 'D', 'E'], ['A', 'B']);
    renderGoals(h.container);
    expect(await screen.findByText('2 faites sur 5')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '40');
    expect(bar()).toHaveAttribute('aria-valuemin', '0');
    expect(bar()).toHaveAttribute('aria-valuemax', '100');
  });

  it('terminer une tâche rattachée fait passer à « 3 faites sur 5 » sans rechargement ; la rouvrir redescend (critères 2 et 3)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A', 'B', 'C', 'D', 'E'], ['A', 'B']);
    renderGoals(h.container);
    await screen.findByText('2 faites sur 5');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : C' }));
    expect(await screen.findByText('3 faites sur 5')).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-valuenow', '60');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rouvrir : C' }));
    expect(await screen.findByText('2 faites sur 5')).toBeInTheDocument();
  });

  it('terminer la tâche ailleurs (source unique) met aussi l’avancement à jour (critère 2)', async () => {
    const goal = await seedGoal(h);
    const [first] = await attach(h, goal, ['A', 'B']);
    renderGoals(h.container);
    await screen.findByText('0 faite sur 2');
    await act(async () => {
      h.container.taskEntities.publish([await h.container.data.repos.tasks.complete((first as Task).id, new Date(h.db.clock.nowMs()).toISOString() as never)]);
    });
    expect(await screen.findByText('1 faite sur 2')).toBeInTheDocument();
  });

  it('les tâches supprimées ne comptent pas (critère 3)', async () => {
    const goal = await seedGoal(h);
    const [, second] = await attach(h, goal, ['A', 'B', 'C']);
    renderGoals(h.container);
    await screen.findByText('0 faite sur 3');
    await act(async () => {
      await h.container.data.repos.tasks.softDelete([(second as Task).id]);
      h.container.taskEntities.remove([(second as Task).id]);
    });
    expect(await screen.findByText('0 faite sur 2')).toBeInTheDocument();
  });

  it('aucune tâche rattachée : « Aucune tâche rattachée », ni barre ni compteur (critère 4)', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    expect(await screen.findByText('Aucune tâche rattachée')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/faites? sur/)).toBeNull();
  });

  it('le filtre d’espace n’altère pas le compte : toutes les tâches rattachées comptent (critère 7)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['Pro 1', 'Pro 2'], ['Pro 1']);
    await attach(h, goal, ['Perso 1'], [], { spaceId: SPACE_PERSO_ID });
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    renderGoals(h.container);
    expect(await screen.findByText('1 faite sur 3')).toBeInTheDocument();
  });

  it('« Marquer atteint » passe l’objectif à atteint, le bouton devient « Rouvrir l’objectif » (critère 5)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A']);
    renderGoals(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Marquer atteint' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.status).toBe('achieved'));
    fireEvent.click(await screen.findByRole('button', { name: 'Rouvrir l’objectif' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.status).toBe('open'));
    expect(await screen.findByRole('button', { name: 'Marquer atteint' })).toBeInTheDocument();
  });

  it('toutes les tâches faites : l’objectif n’est pas marqué atteint automatiquement (critère 6)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A', 'B'], ['A']);
    renderGoals(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : B' }));
    expect(await screen.findByText('2 faites sur 2')).toBeInTheDocument();
    expect((await h.container.data.repos.goals.getById(goal.id))?.status).toBe('open');
    expect(screen.getByRole('button', { name: 'Marquer atteint' })).toBeInTheDocument();
  });

  it('chaque section a son avancement et son bouton « Marquer atteint » (QB-12)', async () => {
    const one = await seedGoal(h, { title: 'Objectif un' });
    const two = await seedGoal(h, { title: 'Objectif deux', spaceId: SPACE_PERSO_ID });
    await attach(h, one, ['A', 'B'], ['A']);
    await attach(h, two, ['C']);
    renderGoals(h.container);
    await screen.findByText('1 faite sur 2');
    const sections = screen.getAllByRole('region', { name: /Objectif de la semaine/ });
    expect(sections).toHaveLength(2);
    expect(within(sections[0] as HTMLElement).getByText('1 faite sur 2')).toBeInTheDocument();
    expect(within(sections[1] as HTMLElement).getByText('0 faite sur 1')).toBeInTheDocument();
    for (const section of sections) expect(within(section).getByRole('button', { name: 'Marquer atteint' })).toBeInTheDocument();
    fireEvent.click(within(sections[1] as HTMLElement).getByRole('button', { name: 'Marquer atteint' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(two.id))?.status).toBe('achieved'));
    expect((await h.container.data.repos.goals.getById(one.id))?.status).toBe('open');
  });
});

describe('Avancement dans l’encadré d’Aujourd’hui (OB-04)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('342');
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
  const card = () => document.querySelector<HTMLElement>('.ct-today-goal') as HTMLElement;

  it('« 2/5 » dans l’encadré, « 3/5 » dès qu’une tâche rattachée est terminée dans la liste (critères 1 et 2)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A', 'B', 'C', 'D', 'E'], ['A', 'B']);
    renderToday();
    await waitFor(() => expect(card()).toHaveTextContent('2/5'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : C' }));
    await waitFor(() => expect(card()).toHaveTextContent('3/5'));
    expect(card()).toHaveAccessibleName('Objectif de la semaine : Finaliser le PRD CircleTasks, 3 sur 5');
  });

  it('aucune tâche rattachée : l’encadré n’affiche pas de compteur (critère 4)', async () => {
    await seedGoal(h);
    renderToday();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(card()).not.toHaveTextContent('/');
    expect(card()).toHaveAccessibleName('Objectif de la semaine : Finaliser le PRD CircleTasks');
  });

  it('atteint : l’encadré affiche « Atteint » à la place du compteur (critère 5)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['A', 'B']);
    renderToday();
    await waitFor(() => expect(card()).toHaveTextContent('0/2'));
    await act(async () => {
      await (await import('./goalUseCases')).createGoalUseCases(h.container).setStatus(goal.id, 'achieved');
    });
    await waitFor(() => expect(card()).toHaveTextContent('Atteint'));
    expect(card()).not.toHaveTextContent('0/2');
  });

  it('le compte ne dépend pas du filtre d’espace (critère 7)', async () => {
    const goal = await seedGoal(h);
    await attach(h, goal, ['Pro 1'], ['Pro 1']);
    await attach(h, goal, ['Perso 1', 'Perso 2'], [], { spaceId: SPACE_PERSO_ID });
    renderToday();
    await waitFor(() => expect(card()).toHaveTextContent('1/3'));
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    await waitFor(() => expect(card()).toHaveTextContent('1/3'));
  });

  it('une tâche rattachée terminée depuis un jour futur reste comptée (rattachement par semaine, pas par jour)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Plus tard', date: '2026-10-04' as LocalDate });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    renderToday();
    await waitFor(() => expect(card()).toHaveTextContent('0/1'));
  });
});
