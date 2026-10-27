import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDate } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { GoalAttachSwitch } from './GoalAttachSwitch';
import { seedGoal, setupGoals, teardownGoals, type GoalsHarness } from './testKit';

let h: GoalsHarness;
beforeEach(async () => { h = await setupGoals('d71'); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await teardownGoals(h); });
describe('UI-FIX-02 : rattachement sans objectif', () => {
  it.each(['sheet', 'detail'] as const)('%s : une seule explication et aucune action sans objectif', async (variant) => {
    const change = vi.fn();
    render(<AppContainerProvider container={h.container}><GoalAttachSwitch variant={variant} taskDate={h.today} attachedGoalId={null} onChange={change} /></AppContainerProvider>);
    expect(await screen.findByText('Aucun objectif cette semaine')).toBeInTheDocument();
    const control = screen.getByRole('switch', { name: 'Rattacher à mon objectif' });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(change).not.toHaveBeenCalled();
    expect(screen.queryByText('Non rattachée')).toBeNull();
  });

  it('désactive immédiatement un choix périmé quand la date passe à une semaine sans objectif', async () => {
    await seedGoal(h);
    const change = vi.fn();
    const view = render(<AppContainerProvider container={h.container}><GoalAttachSwitch variant="sheet" taskDate={h.today} attachedGoalId={null} onChange={change} /></AppContainerProvider>);
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    const original = h.container.data.repos.goals.listForWeek.bind(h.container.data.repos.goals);
    let release!: () => void;
    vi.spyOn(h.container.data.repos.goals, 'listForWeek').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(...args);
    });
    view.rerender(<AppContainerProvider container={h.container}><GoalAttachSwitch variant="sheet" taskDate={'2026-10-05' as LocalDate} attachedGoalId={null} onChange={change} /></AppContainerProvider>);
    const disabled = (screen.getByRole('switch') as HTMLButtonElement).disabled;
    fireEvent.click(screen.getByRole('switch'));
    release();
    await screen.findByText('Aucun objectif cette semaine');
    expect(disabled).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
});
