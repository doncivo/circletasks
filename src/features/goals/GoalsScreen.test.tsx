import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { seedTask } from '../today/testKit';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026, semaine 40 : lun. 28 sept. au dim. 4 oct.
const WEEK = '2026-09-28' as LocalDate;
const titleField = (name = 'Objectif de la semaine') => screen.getByRole('textbox', { name });

describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Écran Objectif (OB-01), %s', (_name, width) => {
  let h: GoalsHarness;

  beforeEach(async () => {
    h = await setupGoals(width < 1024 ? '301' : '302');
    mockViewport(width);
  });
  afterEach(() => teardownGoals(h));

  const goalsOfWeek = () => h.container.data.repos.goals.listForWeek(WEEK, 'all');

  it('affiche la semaine en cours « Semaine 40 · 28 sept. – 4 oct. » (critère 1)', async () => {
    renderGoals(h.container);
    expect(await screen.findByText('Semaine 40 · 28 sept. – 4 oct.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Objectif' })).toBeInTheDocument();
  });

  it('sans objectif : champ vide focalisé et aide (critère 2)', async () => {
    renderGoals(h.container);
    const field = await screen.findByRole('textbox', { name: 'Objectif de la semaine' });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue('');
    expect(screen.getByText('Fixez ce qui compte cette semaine')).toBeInTheDocument();
  });

  it('Entrée crée l’objectif : semaine en cours, ouvert, épinglé, espace Pro par défaut (critère 3)', async () => {
    renderGoals(h.container);
    const field = await screen.findByRole('textbox', { name: 'Objectif de la semaine' });
    fireEvent.change(field, { target: { value: '  Finaliser le PRD CircleTasks ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(async () => expect(await goalsOfWeek()).toHaveLength(1));
    const [goal] = await goalsOfWeek();
    expect(goal).toMatchObject({ title: 'Finaliser le PRD CircleTasks', status: 'open', pinned: true, spaceId: SPACE_PRO_ID, weekStart: WEEK, carriedFromId: null });
    // La perte de focus qui suit la validation ne crée pas de doublon.
    fireEvent.blur(field);
    await act(async () => undefined);
    expect(await goalsOfWeek()).toHaveLength(1);
  });

  it('la perte de focus valide aussi, dans l’espace du filtre actif (critère 3, T-01)', async () => {
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    renderGoals(h.container);
    const field = await screen.findByRole('textbox', { name: 'Objectif de la semaine' });
    fireEvent.change(field, { target: { value: 'Ranger le garage' } });
    fireEvent.blur(field);
    await waitFor(async () => expect(await goalsOfWeek()).toHaveLength(1));
    const [goal] = await goalsOfWeek();
    expect(goal?.spaceId).toBe(SPACE_PERSO_ID);
  });

  it('un titre vide est refusé : rien n’est créé (critère 5)', async () => {
    renderGoals(h.container);
    const field = await screen.findByRole('textbox', { name: 'Objectif de la semaine' });
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    fireEvent.blur(field);
    await act(async () => undefined);
    expect(await goalsOfWeek()).toEqual([]);
  });

  it('modifier le titre l’enregistre ; vidé, l’ancien titre revient (critère 5)', async () => {
    const goal = await seedGoal(h);
    renderGoals(h.container);
    const field = await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.change(field, { target: { value: 'Livrer le PRD' } });
    fireEvent.blur(field);
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.title).toBe('Livrer le PRD'));
    fireEvent.change(titleField(), { target: { value: '   ' } });
    fireEvent.blur(titleField());
    await waitFor(() => expect(titleField()).toHaveValue('Livrer le PRD'));
    expect((await h.container.data.repos.goals.getById(goal.id))?.title).toBe('Livrer le PRD');
  });

  it('le titre est limité à 200 caractères (critère 5)', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    expect(await screen.findByDisplayValue('Finaliser le PRD CircleTasks')).toHaveAttribute('maxlength', '200');
  });

  it('change l’espace de l’objectif (critère 5)', async () => {
    const goal = await seedGoal(h);
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.click(within(screen.getByRole('group', { name: 'Espace de l’objectif' })).getByRole('button', { name: 'Perso' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.spaceId).toBe(SPACE_PERSO_ID));
  });

  it('choisit une icône avec le composant commun Icône / Emoji (critère 4)', async () => {
    const goal = await seedGoal(h);
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.click(screen.getByRole('button', { name: 'Icône de l’objectif' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Emoji' }));
    const emojis = screen.getAllByRole('button').filter((button) => /\p{Extended_Pictographic}/u.test(button.textContent ?? ''));
    expect(emojis.length).toBeGreaterThan(0);
    fireEvent.click(emojis[0] as HTMLElement);
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.icon?.kind).toBe('emoji'));
  });

  it('« + Ajouter un objectif » ajoute une section vide sous la précédente, sans sélecteur d’objectif (critère 6)', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.click(screen.getByRole('button', { name: '+ Ajouter un objectif' }));
    const second = await screen.findByRole('textbox', { name: 'Objectif de la semaine (2)' });
    await waitFor(() => expect(second).toHaveFocus());
    fireEvent.change(second, { target: { value: 'Ranger le bureau' } });
    fireEvent.blur(second);
    await waitFor(async () => expect(await goalsOfWeek()).toHaveLength(2));
    expect(await screen.findAllByRole('region', { name: /Objectif de la semaine/ })).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('button', { name: '+ Ajouter un objectif' })).toHaveLength(1);
  });

  it('supprime un objectif après confirmation : ses tâches restent sans rattachement, annulable (critère 7)', async () => {
    const goal = await seedGoal(h);
    const task = await seedTask(h, { title: 'Relire le PRD' });
    await h.container.data.repos.tasks.update(task.id, { goalId: goal.id });
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer l’objectif' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    await waitFor(async () => expect(await h.container.data.repos.goals.getById(goal.id)).toBeNull());
    expect((await h.container.data.repos.tasks.getById(task.id))?.goalId).toBeNull();
    expect((await h.container.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await h.container.data.repos.goals.getById(goal.id))?.title).toBe('Finaliser le PRD CircleTasks'));
    expect((await h.container.data.repos.tasks.getById(task.id))?.goalId).toBe(goal.id);
  });

  it('le filtre d’espace global masque les sections d’un autre espace', async () => {
    await seedGoal(h, { title: 'Objectif Perso', spaceId: SPACE_PERSO_ID });
    await seedGoal(h, { title: 'Objectif Pro' });
    renderGoals(h.container);
    await screen.findByDisplayValue('Objectif Pro');
    expect(screen.getByDisplayValue('Objectif Perso')).toBeInTheDocument();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    expect(screen.queryByDisplayValue('Objectif Perso')).toBeNull();
    expect(screen.getByDisplayValue('Objectif Pro')).toBeInTheDocument();
  });
});
