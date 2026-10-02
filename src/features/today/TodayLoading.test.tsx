import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DataAccess } from '../../db/repositories';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { mockViewport, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { TodayScreen } from './TodayScreen';

describe('Aujourd’hui : squelettes de chargement (A-09)', () => {
  let h: TodayHarness;
  let release: () => void = () => undefined;

  beforeEach(async () => {
    h = await setupToday('109');
    await seedTask(h, { title: 'Une tâche' });
    mockViewport(440);
  });
  afterEach(async () => {
    release();
    vi.useRealTimers();
    await teardownToday(h);
  });

  /** Conteneur dont la lecture du jour attend `release()` : un chargement lent. */
  function slowContainer() {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = h.db.data.repos.tasks;
    const slow = { ...real, listForDay: async (...args: Parameters<typeof real.listForDay>) => (await gate, real.listForDay(...args)) };
    const data = { ...h.db.data, repos: { ...h.db.data.repos, tasks: slow } } as DataAccess;
    return createAppContainer({ clock: h.db.clock, hlc: createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId }), data });
  }

  it('aucun squelette sous 150 ms, puis des lignes grises masquées aux lecteurs d’écran et une seule annonce (critères 1, 2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const container = slowContainer();
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
      </AppContainerProvider>,
    );
    await act(async () => void vi.advanceTimersByTime(100));
    expect(screen.queryByTestId('list-skeleton')).toBeNull();

    await act(async () => void vi.advanceTimersByTime(100));
    expect(screen.getByTestId('list-skeleton')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('list-skeleton').parentElement).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('list')).toBeNull(); // le squelette n'est pas une liste annoncée
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Chargement');
    expect(screen.queryByText('Chargement…')).toBeNull();

    vi.useRealTimers();
    await act(async () => {
      release();
    });
    expect(await screen.findByRole('button', { name: 'Une tâche' })).toBeInTheDocument();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
    expect(screen.getByRole('list', { name: 'Liste du jour' })).toHaveAttribute('aria-busy', 'false');
    cleanup();
  });

  it('un chargement rapide n’affiche jamais de squelette', async () => {
    render(
      <AppContainerProvider container={h.container}>
        <TodayScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Une tâche' })).toBeInTheDocument();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
  });
});
