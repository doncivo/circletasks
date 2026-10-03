import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { addDays } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks';
import { TodayScreen } from '../today/TodayScreen';
import { seedTask } from '../today/testKit';
import { WeekScreen } from '../week/WeekScreen';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const NEXT_WEEK = '2026-10-05' as LocalDate;

function renderToday(h: GoalsHarness) {
  return render(
    <AppContainerProvider container={h.container}>
      <TodayScreen />
    </AppContainerProvider>,
  );
}

const goalSwitch = () => screen.getByRole('switch', { name: 'Rattacher à mon objectif' });
const taskGoalId = async (h: GoalsHarness, id: string) => (await h.container.data.repos.tasks.getById(id as never))?.goalId ?? null;

describe('Rattacher une tâche à un objectif : fiche détail PC (OB-03)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('331');
    mockViewport(1440);
  });
  afterEach(() => teardownGoals(h));

  async function openDetail(title: string): Promise<HTMLElement> {
    renderToday(h);
    fireEvent.click(await screen.findByRole('button', { name: title }));
    return screen.findByRole('complementary', { name: 'Détail de la tâche' });
  }

  it('aucun objectif cette semaine : interrupteur inactif avec l’aide (critère 2)', async () => {
    await seedTask(h, { title: 'Relire le PRD' });
    const fiche = await openDetail('Relire le PRD');
    await waitFor(() => expect(within(fiche).getByText('Aucun objectif cette semaine')).toBeInTheDocument());
    expect(goalSwitch()).toBeDisabled();
    expect(within(fiche).getByText('Non rattachée')).toBeInTheDocument();
  });

  it('un seul objectif ouvert : rattachement direct, « Rattachée : titre », puis détachement (critères 1, 4 et 7)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    const fiche = await openDetail('Relire le PRD');
    await waitFor(() => expect(goalSwitch()).toBeEnabled());
    fireEvent.click(goalSwitch());
    await waitFor(async () => expect(await taskGoalId(h, task.id)).toBe(goal.id));
    expect(await within(fiche).findByText('Rattachée : Finaliser le PRD CircleTasks')).toBeInTheDocument();
    expect(goalSwitch()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(goalSwitch());
    await waitFor(async () => expect(await taskGoalId(h, task.id)).toBeNull());
    expect(await within(fiche).findByText('Non rattachée')).toBeInTheDocument();
  });

  it('plusieurs objectifs ouverts : liste à choisir, une tâche Perso peut servir un objectif Pro (critère 7, QB-13)', async () => {
    const pro = await seedGoal(h, { title: 'Objectif Pro' });
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    const task = await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID });
    await openDetail('Appeler maman');
    await waitFor(() => expect(goalSwitch()).toBeEnabled());
    fireEvent.click(goalSwitch());
    const dialog = await screen.findByRole('alertdialog', { name: 'Rattacher à quel objectif ?' });
    expect(within(dialog).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Objectif Pro · Pro' }));
    await waitFor(async () => expect(await taskGoalId(h, task.id)).toBe(pro.id));
  });

  it('fermer la liste sans choisir laisse l’interrupteur désactivé (critère 7)', async () => {
    await seedGoal(h, { title: 'Objectif Pro' });
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await openDetail('Relire le PRD');
    await waitFor(() => expect(goalSwitch()).toBeEnabled());
    fireEvent.click(goalSwitch());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(goalSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(await taskGoalId(h, task.id)).toBeNull();
  });

  it('un objectif atteint ou clos n’est pas proposé (seuls les objectifs ouverts)', async () => {
    await seedGoal(h, { title: 'Atteint', status: 'achieved' });
    await seedGoal(h, { title: 'Ouvert' });
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await openDetail('Relire le PRD');
    await waitFor(() => expect(goalSwitch()).toBeEnabled());
    fireEvent.click(goalSwitch());
    await waitFor(async () => expect(await taskGoalId(h, task.id)).not.toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('semaine de référence : celle de la date de la tâche (critère 8)', async () => {
    const next = await seedGoal(h, { title: 'Semaine suivante', weekStart: NEXT_WEEK });
    const task = await seedTask(h, { title: 'Tâche de la semaine suivante', date: addDays(h.today, 4) });
    renderToday(h);
    await screen.findByRole('button', { name: 'Ajouter' });
    act(() => useNavigationStore.getState().openDetail({ type: 'task', id: task.id }));
    await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    await waitFor(() => expect(goalSwitch()).toBeEnabled());
    fireEvent.click(goalSwitch());
    await waitFor(async () => expect(await taskGoalId(h, task.id)).toBe(next.id));
  });

  it('une tâche rattachée reportée hors de la semaine garde son rattachement (critère 6)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    await createTaskUseCases(h.container).postpone([task.id], { date: NEXT_WEEK });
    const moved = await h.container.data.repos.tasks.getById(task.id);
    expect(moved?.date).toBe(NEXT_WEEK);
    expect(moved?.goalId).toBe(goal.id);
  });

  it('la ligne d’une tâche rattachée porte l’icône cible « Rattachée à l’objectif » (critère 3)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await seedTask(h, { title: 'Sans objectif' });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    renderToday(h);
    await screen.findByRole('button', { name: 'Sans objectif' });
    const row = (await screen.findByRole('button', { name: 'Relire le PRD' })).closest('.ct-list-row') as HTMLElement;
    expect(within(row).getByRole('img', { name: 'Rattachée à l’objectif' })).toBeInTheDocument();
    expect(row).toHaveTextContent('objectif');
    const other = screen.getByRole('button', { name: 'Sans objectif' }).closest('.ct-list-row') as HTMLElement;
    expect(within(other).queryByRole('img', { name: 'Rattachée à l’objectif' })).toBeNull();
  });
});

describe('Rattacher à la création : feuille « Nouvelle tâche » iPhone (OB-03)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('332');
    mockViewport(440);
  });
  afterEach(() => teardownGoals(h));

  it('l’interrupteur de la feuille rattache la nouvelle tâche à l’objectif (critère 1)', async () => {
    const goal = await seedGoal(h);
    renderToday(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Écrire le plan' } });
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' }));
    expect(await within(dialog).findByText('Rattachée : Finaliser le PRD CircleTasks')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => {
      const [created] = (await h.container.data.repos.tasks.listForDay(h.today, 'all')).filter((task) => task.title === 'Écrire le plan');
      expect(created?.goalId).toBe(goal.id);
    });
  });

  it('sans objectif cette semaine : interrupteur inactif avec l’aide (critère 2)', async () => {
    renderToday(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    await waitFor(() => expect(within(dialog).getByText('Aucun objectif cette semaine')).toBeInTheDocument());
    expect(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' })).toBeDisabled();
  });

  it('deux objectifs : la liste s’ouvre dans la feuille ; fermer sans choisir ne rattache rien', async () => {
    await seedGoal(h, { title: 'Objectif Pro' });
    const perso = await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    renderToday(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' }));
    const choice = await screen.findByRole('alertdialog');
    fireEvent.click(within(choice).getByRole('button', { name: 'Annuler' }));
    expect(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Rattacher à mon objectif' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: `Objectif Perso · Perso` }));
    expect(await within(dialog).findByText('Rattachée : Objectif Perso')).toBeInTheDocument();
    expect(perso.title).toBe('Objectif Perso');
  });
});

describe('Tâches rattachées dans l’écran Objectif et la Semaine (OB-03)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('333');
    mockViewport(440);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownGoals(h);
  });

  it('liste les tâches rattachées avec leur case et leur jour abrégé ; cocher la termine (critère 5)', async () => {
    const goal = await seedGoal(h);
    const monday = await seedTask(h, { title: 'Relire les user stories', date: '2026-09-28' as LocalDate });
    const wednesday = await seedTask(h, { title: 'Mettre à jour CLAUDE.md', date: '2026-09-30' as LocalDate });
    await seedTask(h, { title: 'Hors objectif' });
    for (const task of [monday, wednesday]) await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    renderGoals(h.container);
    const box = await screen.findByRole('checkbox', { name: 'Terminer : Relire les user stories' });
    const section = box.closest('.ct-goal') as HTMLElement;
    expect(within(section).getByText('lun.')).toBeInTheDocument();
    expect(within(section).getByText('mer.')).toBeInTheDocument();
    expect(screen.queryByText('Hors objectif')).toBeNull();
    fireEvent.click(box);
    await waitFor(async () => expect((await h.container.data.repos.tasks.getById(monday.id))?.status).toBe('done'));
    expect(await screen.findByRole('checkbox', { name: 'Rouvrir : Relire les user stories' })).toBeInTheDocument();
    // Annulable (T-13) : le message « Annuler » rouvre la tâche.
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await h.container.data.repos.tasks.getById(monday.id))?.status).toBe('todo'));
  });

  it('sans tâche rattachée : « Aucune tâche rattachée »', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    expect(await screen.findByText('Aucune tâche rattachée')).toBeInTheDocument();
  });

  it('une tâche détachée ailleurs disparaît de la liste', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    renderGoals(h.container);
    await screen.findByRole('checkbox', { name: 'Terminer : Relire le PRD' });
    await act(async () => {
      h.container.taskEntities.publish([await h.container.data.repos.tasks.update(task.id, { goalId: null })]);
    });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Terminer : Relire le PRD' })).toBeNull());
  });

  it('la Semaine marque la tâche rattachée (critère 3, « objectif » sur PC, icône sur iPhone)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    useNavigationStore.getState().navigate({ tab: 'week', weekStart: null, somedayPanel: false });
    render(
      <AppContainerProvider container={h.container}>
        <WeekScreen />
      </AppContainerProvider>,
    );
    const item = (await screen.findByRole('button', { name: 'Relire le PRD' })).closest('.ct-week-item') as HTMLElement;
    expect(within(item).getByRole('img', { name: 'Rattachée à l’objectif' })).toBeInTheDocument();
  });
});

describe('Semaine PC : « objectif » sur la carte (OB-03 critère 3)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('334');
    mockViewport(1440);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownGoals(h);
  });

  it('la carte indique « Pro · objectif » sous le filtre Tout', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD', spaceId: SPACE_PRO_ID });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    render(
      <AppContainerProvider container={h.container}>
        <WeekScreen />
      </AppContainerProvider>,
    );
    const item = (await screen.findByRole('button', { name: 'Relire le PRD' })).closest('.ct-week-item') as HTMLElement;
    expect(item).toHaveTextContent('Pro · objectif');
    expect(within(item).getByRole('img', { name: 'Rattachée à l’objectif' })).toBeInTheDocument();
  });
});
