import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { TodayScreen } from '../today/TodayScreen';
import { seedTask } from '../today/testKit';
import { WeekScreen } from '../week/WeekScreen';
import { registerGoalsSource, unregisterGoalsSource } from './goalsSource';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
function renderToday(h: GoalsHarness) {
  return render(
    <AppContainerProvider container={h.container}>
      <TodayScreen />
    </AppContainerProvider>,
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>('.ct-today-goal')];

describe('Encadrés d’objectif épinglés dans Aujourd’hui (OB-02)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('321');
    mockViewport(440);
    registerGoalsSource();
  });
  afterEach(async () => {
    unregisterGoalsSource();
    await teardownGoals(h);
  });

  it('l’encadré s’affiche en tête de liste, avant les tâches (critère 1)', async () => {
    await seedGoal(h);
    await seedTask(h, { title: 'Envoyer la facture' });
    renderToday(h);
    const card = await screen.findByRole('button', { name: /^Objectif de la semaine : Finaliser le PRD CircleTasks/ });
    const task = screen.getByRole('button', { name: 'Envoyer la facture' });
    expect(card.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('OBJECTIF DE LA SEMAINE', { exact: false })).toBeInTheDocument();
  });

  it('pas d’encadré pour un objectif non épinglé, d’une autre semaine ou clos', async () => {
    await seedGoal(h, { title: 'Non épinglé', pinned: false });
    await seedGoal(h, { title: 'Semaine passée', weekStart: '2026-09-21' as never });
    await seedGoal(h, { title: 'Clos', status: 'closed' });
    renderToday(h);
    await screen.findByRole('button', { name: 'Ajouter' });
    await waitFor(() => expect(h.container.data.repos.goals.listForWeek('2026-09-28' as never, 'all')).resolves.toHaveLength(2));
    expect(cards()).toHaveLength(0);
  });

  it('un encadré par objectif épinglé, Pro et Perso empilés ; le filtre « Pro » ne garde que l’encadré Pro (critère 9)', async () => {
    await seedGoal(h, { title: 'Objectif Pro' });
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    renderToday(h);
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().map((card) => card.textContent)).toEqual([expect.stringContaining('Objectif Pro'), expect.stringContaining('Objectif Perso')]);
    expect(screen.queryByText('+1')).toBeNull();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveTextContent('Objectif Pro');
  });

  it('un objectif Perso est masqué sous le filtre « Pro » (critère 5)', async () => {
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    renderToday(h);
    await screen.findByRole('button', { name: 'Ajouter' });
    await act(async () => undefined);
    expect(cards()).toHaveLength(0);
  });

  it('un filtre projet masque l’objectif (ES-03, ES-04)', async () => {
    await seedGoal(h);
    renderToday(h);
    await waitFor(() => expect(cards()).toHaveLength(1));
    const project = { id: '77000000-0000-4000-8000-000000000001' as never, spaceId: SPACE_PRO_ID, name: 'Mission', color: '#2f6b7a' as never, archived: false, sortOrder: 1, deletedAt: null } as never;
    act(() => {
      useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
      useAppStore.getState().setProjects([project]);
      useAppStore.getState().setProjectFilter((project as { id: never }).id);
    });
    await waitFor(() => expect(cards()).toHaveLength(0));
  });

  it('visible tous les jours de la semaine, plus le lundi suivant (critères 1 et 3)', async () => {
    await seedGoal(h);
    renderToday(h);
    await waitFor(() => expect(cards()).toHaveLength(1));
    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'today', date: '2026-09-28' as never }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('28'));
    await waitFor(() => expect(cards()).toHaveLength(1));
    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'today', date: '2026-10-05' as never }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('5'));
    await waitFor(() => expect(cards()).toHaveLength(0));
  });

  it('désépingler retire l’encadré aussitôt ; l’objectif reste dans l’écran Objectif (critère 2)', async () => {
    const goal = await seedGoal(h);
    renderToday(h);
    await waitFor(() => expect(cards()).toHaveLength(1));
    await act(async () => {
      await (await import('./goalUseCases')).createGoalUseCases(h.container).update(goal.id, { pinned: false });
    });
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect((await h.container.data.repos.goals.getById(goal.id))?.title).toBe('Finaliser le PRD CircleTasks');
  });

  it('toucher l’encadré ouvre l’écran Objectif (critère 4)', async () => {
    await seedGoal(h);
    renderToday(h);
    fireEvent.click(await screen.findByRole('button', { name: /^Objectif de la semaine : Finaliser/ }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'goals' });
  });

  it('un objectif atteint reste affiché avec « Atteint » jusqu’à la fin de la semaine (critère 7)', async () => {
    await seedGoal(h, { status: 'achieved' });
    renderToday(h);
    const card = await screen.findByRole('button', { name: /Atteint/ });
    expect(within(card).getByText('Atteint')).toBeInTheDocument();
  });
});

describe('Interrupteur « Épinglé en haut de la liste » (OB-02)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('322');
    mockViewport(440);
  });
  afterEach(() => teardownGoals(h));

  it('un nouvel objectif est épinglé par défaut (critère 8) et l’interrupteur le désépingle puis le réépingle', async () => {
    const goal = await seedGoal(h);
    renderGoals(h.container);
    const toggle = await screen.findByRole('switch', { name: 'Épinglé en haut de la liste' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.pinned).toBe(false));
    expect(screen.getByRole('switch', { name: 'Épinglé en haut de la liste' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('switch', { name: 'Épinglé en haut de la liste' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.pinned).toBe(true));
  });
});

describe('Bandeau d’objectif de la Semaine PC (OB-02 critère 6)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('323');
    mockViewport(1440);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownGoals(h);
  });

  const renderWeek = () =>
    render(
      <AppContainerProvider container={h.container}>
        <WeekScreen />
      </AppContainerProvider>,
    );

  it('un bandeau par objectif épinglé de la semaine, filtré par espace', async () => {
    await seedGoal(h, { title: 'Objectif Pro' });
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    await seedGoal(h, { title: 'Non épinglé', pinned: false });
    renderWeek();
    const group = await screen.findByRole('group', { name: 'Objectifs de la semaine' });
    expect(within(group).getAllByRole('group')).toHaveLength(2);
    expect(within(group).getByText('Objectif Pro')).toBeInTheDocument();
    expect(within(group).getByText('Objectif Perso')).toBeInTheDocument();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Objectifs de la semaine' })).getAllByRole('group')).toHaveLength(1));
  });

  it('une autre semaine affiche le bandeau de cette semaine-là, ou aucun', async () => {
    await seedGoal(h, { title: 'Objectif de la semaine passée', weekStart: '2026-09-21' as never });
    renderWeek();
    await screen.findByText('Semaine 40');
    await act(async () => undefined);
    expect(screen.queryByRole('group', { name: 'Objectifs de la semaine' })).toBeNull();
    act(() => useNavigationStore.getState().navigate({ tab: 'week', weekStart: '2026-09-21' as never, somedayPanel: false }));
    expect(await screen.findByText('Objectif de la semaine passée')).toBeInTheDocument();
  });

  it('affiche l’avancement « 1/2 » du bandeau', async () => {
    const goal = await seedGoal(h);
    const a = await seedTask(h, { title: 'A faire' });
    const b = await seedTask(h, { title: 'Faite' });
    await h.container.data.repos.tasks.update(a.id, { goalId: goal.id });
    await h.container.data.repos.tasks.update(b.id, { goalId: goal.id });
    await h.container.data.repos.tasks.complete(b.id, new Date(h.db.clock.nowMs()).toISOString() as never);
    renderWeek();
    expect(await screen.findByLabelText('1 sur 2')).toHaveTextContent('1/2');
  });
});
