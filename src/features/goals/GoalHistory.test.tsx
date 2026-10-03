import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate } from '../../domain/types';
import { addDays } from '../../domain/localDate';
import { useAppStore } from '../app/appStore';
import { seedTask } from '../today/testKit';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026 (S40) ; S39 = lun. 21 sept., S38 = lun. 14 sept., S37 = lun. 7 sept.
const date = (iso: string) => iso as LocalDate;
const rows = () => [...document.querySelectorAll<HTMLElement>('.ct-goal-history__row')];
const rowText = (row: HTMLElement) => row.textContent ?? '';

describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Historique « SEMAINES PRÉCÉDENTES » (OB-06), %s', (_name, width) => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals(width < 1024 ? '361' : '362');
    mockViewport(width);
  });
  afterEach(() => teardownGoals(h));

  it('liste S38 puis S37, de la plus récente à la plus ancienne, avec les badges (critères 1 et 2)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-07'), title: 'Trier les papiers administratifs', status: 'closed' });
    await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Clôturer la paie de septembre', status: 'achieved' });
    renderGoals(h.container);
    expect(await screen.findByRole('heading', { name: 'SEMAINES PRÉCÉDENTES' })).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowText(rows()[0] as HTMLElement)).toBe('S38Clôturer la paie de septembreAtteint');
    expect(rowText(rows()[1] as HTMLElement)).toBe('S37Trier les papiers administratifsNon atteint');
  });

  it('un objectif resté ouvert sans réponse apparaît « Non atteint » (critère 2)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-21'), title: 'Sans réponse', status: 'open' });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowText(rows()[0] as HTMLElement)).toContain('Non atteint');
  });

  it('toucher une ligne la déplie sur ses tâches avec leur état ; un second toucher la replie (critère 3)', async () => {
    const goal = await seedGoal(h, { weekStart: date('2026-09-21'), title: 'Finaliser le PRD', status: 'closed' });
    const done = await seedTask(h, { title: 'Relire', date: date('2026-09-22') });
    const todo = await seedTask(h, { title: 'Écrire', date: date('2026-09-23') });
    await h.container.data.repos.tasks.update(done.id, { goalId: goal.id });
    await h.container.data.repos.tasks.update(todo.id, { goalId: goal.id });
    await h.container.data.repos.tasks.complete(done.id, new Date(h.db.clock.nowMs()).toISOString() as never);
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    const list = await screen.findByRole('list', { name: 'Tâches rattachées à l’objectif « Finaliser le PRD »' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('RelireFait');
    expect(second).toHaveTextContent('ÉcrireNon fait');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(row);
    expect(screen.queryByRole('list', { name: /Tâches rattachées à l’objectif/ })).toBeNull();
  });

  it('une ligne sans tâche rattachée le dit', async () => {
    await seedGoal(h, { weekStart: date('2026-09-21'), status: 'closed' });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    expect(await screen.findAllByText('Aucune tâche rattachée')).not.toHaveLength(0);
  });

  it('plusieurs objectifs d’une même semaine : une ligne chacun, même numéro de semaine (critère 4)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Premier', status: 'achieved' });
    await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Second', status: 'closed', spaceId: SPACE_PERSO_ID });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((row) => row.querySelector('.ct-goal-history__week')?.textContent)).toEqual(['S38', 'S38']);
  });

  it('un objectif reconduit affiche « Reconduit en S39 » sous son titre (critère 5)', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Reconduit', status: 'closed' });
    await seedGoal(h, { weekStart: date('2026-09-21'), title: 'Reconduit', status: 'achieved', carriedFromId: old.id });
    await seedGoal(h, { weekStart: date('2026-09-07'), title: 'Jamais reconduit', status: 'closed' });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const byWeek = (week: string) => rows().find((row) => row.querySelector('.ct-goal-history__week')?.textContent === week) as HTMLElement;
    expect(byWeek('S38')).toHaveTextContent('Reconduit en S39');
    expect(byWeek('S39')).not.toHaveTextContent('Reconduit en');
    expect(byWeek('S37')).not.toHaveTextContent('Reconduit en');
  });

  it('le filtre d’espace s’applique à l’historique (critère 6)', async () => {
    await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Pro', status: 'achieved', spaceId: SPACE_PRO_ID });
    await seedGoal(h, { weekStart: date('2026-09-14'), title: 'Perso', status: 'closed', spaceId: SPACE_PERSO_ID });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowText(rows()[0] as HTMLElement)).toContain('Perso');
  });

  it('la semaine en cours n’est pas dans l’historique ; sans semaine passée, pas de section', async () => {
    await seedGoal(h, { weekStart: date('2026-09-28'), title: 'En cours' });
    renderGoals(h.container);
    await screen.findByDisplayValue('En cours');
    await act(async () => undefined);
    expect(screen.queryByRole('heading', { name: 'SEMAINES PRÉCÉDENTES' })).toBeNull();
  });

  it('chargement par pages de 20 semaines (critère 7)', async () => {
    for (let week = 1; week <= 25; week += 1) {
      await seedGoal(h, { weekStart: addDays(date('2026-09-28'), -7 * week), title: `Objectif ${week}`, status: 'closed' });
    }
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(rowText(rows()[0] as HTMLElement)).toContain('Objectif 1');
    fireEvent.click(screen.getByRole('button', { name: 'Semaines plus anciennes' }));
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(screen.queryByRole('button', { name: 'Semaines plus anciennes' })).toBeNull();
  });

  it('reconduire un objectif le fait passer dans l’historique « Reconduit en S40 » sans recharger l’écran', async () => {
    const old = await seedGoal(h, { weekStart: date('2026-09-21'), title: 'À reconduire' });
    renderGoals(h.container);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => {
      await (await import('./goalUseCases')).createGoalUseCases(h.container).carryOver(old.id);
    });
    await waitFor(() => expect(rowText(rows()[0] as HTMLElement)).toContain('Reconduit en S40'));
  });
});

