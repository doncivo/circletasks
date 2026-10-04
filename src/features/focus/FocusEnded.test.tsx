import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createFakeSoundPlayer, createMemoryFocusWindow, type FakeSoundPlayer, type FocusWindowAction, type FocusWindowState } from '../../platform/focus';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { FocusHost } from './FocusHost';
import { FocusMiniWindow } from './FocusMiniWindow';
import { FocusSoundSetting } from './FocusSoundSetting';
import { FocusView } from './FocusView';
import { launchFocus } from './focusActions';
import { focusStore } from './focusStore';
import { MIN, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

const START = '2026-10-04T08:00:00.000Z';

function endedState(over: Partial<FocusWindowState> = {}, nonce = 0, enabled = true): FocusWindowState {
  return {
    phase: 'ended',
    session: { id: 's1', plannedMin: 25, startedAt: START, endedAt: '2026-10-04T08:25:00.000Z', pausedSec: 0, pausedAt: null },
    title: 'Envoyer la facture',
    time: '09:00',
    spaceName: 'Pro',
    canFinishTask: true,
    today: { minutes: 25, sessions: 1 },
    sound: { enabled, nonce },
    endedMinutes: 25,
    locale: 'fr',
    ...over,
  };
}

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('État « Session terminée » (F-04 critères 2, 4, 10)', () => {
  const clock = () => createManualClock(Date.parse('2026-10-04T08:26:00.000Z'));

  it('affiche l’anneau complet, 00:00 et « Session terminée · 25 min » annoncé en alerte, sans pastilles de durée', () => {
    const { container } = render(<FocusView state={endedState()} variant="screen" clock={clock()} onAction={() => undefined} />);
    expect(screen.getByRole('timer')).toHaveTextContent('00:00');
    expect(screen.getByRole('alert')).toHaveTextContent('Session terminée · 25 min');
    expect(container.querySelector('.ct-focus__arc')?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(screen.getByRole('region', { name: 'Session Focus' })).toHaveClass('ct-focus--ended');
    expect(screen.queryByRole('group', { name: 'Durée de la session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('propose « Terminer la tâche », « Une autre session » et « Fermer »', () => {
    const actions: FocusWindowAction[] = [];
    render(<FocusView state={endedState()} variant="window" clock={clock()} onAction={(a) => actions.push(a)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminer la tâche' }));
    fireEvent.click(screen.getByRole('button', { name: 'Une autre session' }));
    fireEvent.click(screen.getByRole('button', { name: /^Fermer$/ }));
    expect(actions).toEqual([{ type: 'finishTask' }, { type: 'another' }, { type: 'dismiss' }]);
  });

  it('la croix ferme directement l’écran terminé, sans confirmation', () => {
    const actions: FocusWindowAction[] = [];
    render(<FocusView state={endedState()} variant="screen" clock={clock()} onAction={(a) => actions.push(a)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    expect(actions).toEqual([{ type: 'dismiss' }]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('sans tâche (supprimée) : seul « Fermer » est proposé', () => {
    render(<FocusView state={endedState({ canFinishTask: false, title: null })} variant="screen" clock={clock()} onAction={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Terminer la tâche' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Une autre session' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Fermer$/ })).toBeInTheDocument();
  });

  it('une session libre close au plafond annonce sa durée en heures', () => {
    render(<FocusView state={endedState({ endedMinutes: 480, session: { id: 's1', plannedMin: null, startedAt: START, endedAt: '2026-10-04T16:00:00.000Z', pausedSec: 0, pausedAt: null } })} variant="screen" clock={clock()} onAction={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Session terminée · 8 h');
  });
});

describe('Son de fin (F-04 critères 2, 3, 5)', () => {
  const clock = () => createManualClock(Date.parse('2026-10-04T08:26:00.000Z'));
  const running = (nonce: number, enabled = true): FocusWindowState => ({ ...endedState({}, nonce, enabled), phase: 'running', session: { id: 's1', plannedMin: 25, startedAt: START, endedAt: null, pausedSec: 0, pausedAt: null } });

  it('joue le carillon une seule fois à la fin vécue en direct', () => {
    const player: FakeSoundPlayer = createFakeSoundPlayer();
    const view = render(<FocusView state={running(0)} variant="window" clock={clock()} onAction={() => undefined} player={player} />);
    expect(player.plays()).toBe(0);
    view.rerender(<FocusView state={endedState({}, 1)} variant="window" clock={clock()} onAction={() => undefined} player={player} />);
    expect(player.plays()).toBe(1);
    view.rerender(<FocusView state={endedState({ today: { minutes: 50, sessions: 2 } }, 1)} variant="window" clock={clock()} onAction={() => undefined} player={player} />);
    expect(player.plays()).toBe(1);
  });

  it('critère 5 : ouvert directement sur une fin passée (même nonce), aucun son', () => {
    const player = createFakeSoundPlayer();
    render(<FocusView state={endedState({}, 4)} variant="screen" clock={clock()} onAction={() => undefined} player={player} />);
    expect(player.plays()).toBe(0);
  });

  it('critère 3 : son désactivé, aucun son', () => {
    const player = createFakeSoundPlayer();
    const view = render(<FocusView state={running(0, false)} variant="window" clock={clock()} onAction={() => undefined} player={player} />);
    view.rerender(<FocusView state={endedState({}, 1, false)} variant="window" clock={clock()} onAction={() => undefined} player={player} />);
    expect(player.plays()).toBe(0);
    expect(screen.getByRole('alert')).toBeInTheDocument(); // le texte signale la fin même sans son (critère 10)
  });

  it('critère 2 : la mini-fenêtre joue le son et n’utilise aucune notification Windows', async () => {
    const notification = vi.fn();
    vi.stubGlobal('Notification', notification);
    const memory = createMemoryFocusWindow();
    const player = createFakeSoundPlayer();
    await memory.platform.open(null);
    render(<FocusMiniWindow client={memory.client} clock={clock()} player={player} />);
    await act(async () => {
      await memory.platform.publish(running(0));
    });
    await screen.findByRole('timer');
    await act(async () => {
      await memory.platform.publish(endedState({}, 1));
    });
    await waitFor(() => expect(player.plays()).toBe(1));
    expect(notification).not.toHaveBeenCalled();
  });
});

describe('Hôte : fin de session sur iPhone, réglage du son (F-04)', () => {
  let h: FocusHarness;
  let player: FakeSoundPlayer;
  let counter = 0;

  beforeEach(async () => {
    mockViewport(390);
    player = createFakeSoundPlayer();
    h = await setupFocus(`41${String(counter++)}`, { soundPlayer: player });
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    useAppStore.setState({ spaces: [], day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await h.db.close();
  });

  async function runToEnd() {
    const task = await seedFocusTask(h.container, 'Envoyer la facture', { time: '09:00' });
    render(
      <AppContainerProvider container={h.container}>
        <FocusHost />
      </AppContainerProvider>,
    );
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await screen.findByRole('timer');
    h.db.clock.advance(25 * MIN);
    await act(async () => {
      await focusStore.get(h.container).getState().checkElapsed();
    });
    return task;
  }

  it('critères 1, 2, 4 : la fin close la session, joue le son et affiche l’état terminé au premier plan', async () => {
    await runToEnd();
    expect(await screen.findByRole('alert')).toHaveTextContent('Session terminée · 25 min');
    await waitFor(() => expect(player.plays()).toBe(1));
    expect(screen.getByRole('region', { name: 'Session Focus' })).toHaveClass('ct-focus--screen');
    expect(await h.db.data.repos.focusSessions.getOpen()).toBeNull();
  });

  it('critère 3 : réglage coupé dans Réglages, la fin est silencieuse', async () => {
    focusStore.get(h.container).getState().setEndSound(false);
    await runToEnd();
    await screen.findByRole('alert');
    expect(player.plays()).toBe(0);
  });

  it('critère 4 : « Une autre session » relance, « Fermer » ferme l’écran', async () => {
    await runToEnd();
    fireEvent.click(await screen.findByRole('button', { name: 'Une autre session' }));
    await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('25:00'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('critère 4 : « Fermer » laisse la tâche inchangée et ferme l’écran', async () => {
    const task = await runToEnd();
    fireEvent.click(await screen.findByRole('button', { name: /^Fermer$/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session Focus' })).not.toBeInTheDocument());
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
  });

  it('D2 : l’interrupteur « Son de fin de session » est activé par défaut et se mémorise', async () => {
    render(
      <AppContainerProvider container={h.container}>
        <FocusSoundSetting />
      </AppContainerProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Son de fin de session' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(async () => expect(await h.db.data.repos.settings.get('focus.endSound')).toBe(false));
    expect(screen.getByRole('switch', { name: 'Son de fin de session' })).not.toBeChecked();
  });
});
