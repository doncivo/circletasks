import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../app/appStore';
import { AppContainerProvider } from '../app/AppContainerContext';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { useNoticeStore } from '../app/notice';
import { TaskDetail } from '../tasks/TaskDetail';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { focusStore } from './focusStore';
import { seedFocusTask, setupFocus, type FocusHarness } from './testKit';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

let counter = 0;

describe('Bouton Focus de la fiche détail (F-01 critère 1)', () => {
  let h: FocusHarness;

  async function openDetail(width: number, complete = false, lastDuration: 25 | 50 | 90 | null = 25) {
    mockViewport(width);
    h = await setupFocus(`4${String(counter++).padStart(2, '0')}`);
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
    const task = await seedFocusTask(h.container, 'Envoyer la facture', { time: '09:00' });
    if (complete) await createTaskUseCases(h.container).complete(task.id);
    await h.db.data.repos.settings.set('focus.lastDuration', lastDuration);
    await focusStore.get(h.container).getState().restore();
    useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    await screen.findByText('Envoyer la facture');
    return task;
  }

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [], day: null });
    useNoticeStore.setState({ notice: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await h.db.close();
  });

  it('iPhone : « Lancer un Focus » ; le toucher démarre la session', async () => {
    const task = await openDetail(390);
    const button = await screen.findByRole('button', { name: 'Lancer un Focus' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(focusStore.get(h.container).getState().session?.taskId).toBe(task.id);
  });

  it('PC : « Focus 25 min » (la dernière durée utilisée)', async () => {
    await openDetail(1440);
    expect(await screen.findByRole('button', { name: 'Focus 25 min' })).toBeInTheDocument();
  });

  it('PC : « Focus libre » si la dernière durée est Libre', async () => {
    await openDetail(1440, false, null);
    expect(await screen.findByRole('button', { name: 'Focus libre' })).toBeInTheDocument();
  });

  it('absent pour une tâche terminée', async () => {
    await openDetail(390, true);
    expect(screen.queryByRole('button', { name: 'Lancer un Focus' })).not.toBeInTheDocument();
    cleanup();
  });

  it('absent pour une tâche terminée (PC)', async () => {
    await openDetail(1440, true);
    expect(screen.queryByRole('button', { name: /^Focus/ })).not.toBeInTheDocument();
  });
});
