import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockViewport, renderGoals, seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

/**
 * UI-FIX-05 (défaut 15 de la liste d'Ali du 2026-10-27) : un seul moyen d'ajouter un objectif. Tant qu'un champ de saisie vide (brouillon)
 * est présent, le bouton « + Ajouter un objectif » n'est pas proposé ; il revient sous le dernier objectif une fois le brouillon créé.
 */
const addButton = () => screen.queryByRole('button', { name: '+ Ajouter un objectif' });

describe('Objectif : un seul moyen d’ajouter (UI-FIX-05)', () => {
  let h: GoalsHarness;
  beforeEach(async () => {
    h = await setupGoals('f051');
    mockViewport(440);
  });
  afterEach(() => teardownGoals(h));

  it('sans objectif : le champ vide est là, aucun bouton d’ajout', async () => {
    renderGoals(h.container);
    await screen.findByRole('textbox', { name: 'Objectif de la semaine (1)' });
    expect(addButton()).toBeNull();
  });

  it('avec un objectif : le bouton ouvre un brouillon et disparaît ; il revient après la création', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    expect(addButton()).not.toBeNull();
    fireEvent.click(addButton() as HTMLElement);
    const draft = await screen.findByRole('textbox', { name: 'Objectif de la semaine (2)' });
    await waitFor(() => expect(draft).toHaveFocus());
    expect(addButton()).toBeNull();
    fireEvent.change(draft, { target: { value: 'Ranger le bureau' } });
    fireEvent.blur(draft);
    await waitFor(() => expect(screen.getAllByRole('region', { name: /Objectif de la semaine/ })).toHaveLength(2));
    await waitFor(() => expect(addButton()).not.toBeNull());
    expect(screen.getAllByRole('button', { name: '+ Ajouter un objectif' })).toHaveLength(1);
  });

  it('un brouillon laissé vide ne crée rien et garde le champ ; la saisie et le focus sont conservés', async () => {
    await seedGoal(h);
    renderGoals(h.container);
    await screen.findByDisplayValue('Finaliser le PRD CircleTasks');
    fireEvent.click(addButton() as HTMLElement);
    const draft = await screen.findByRole('textbox', { name: 'Objectif de la semaine (2)' });
    fireEvent.change(draft, { target: { value: 'Brouillon en cours' } });
    expect(draft).toHaveValue('Brouillon en cours');
    expect(addButton()).toBeNull();
    expect(screen.getAllByRole('region', { name: /Objectif de la semaine/ })).toHaveLength(2);
  });
});
