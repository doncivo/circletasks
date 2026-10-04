import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createMemoryFocusWindow, type MemoryFocusWindow } from '../../platform/focus';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNoticeStore } from '../app/notice';
import { UndoToast } from '../app/UndoToast';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { FocusHost } from './FocusHost';
import { launchFocus } from './focusActions';
import { focusStore } from './focusStore';
import { useFocusShortcut } from './useFocusShortcut';
import { MIN, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

let counter = 0;

function Shortcut({ taskId }: { readonly taskId: Parameters<typeof useFocusShortcut>[0] }) {
  useFocusShortcut(taskId);
  return null;
}

describe('FocusHost : où la session s’affiche (F-01 critères 2, 3, 6, 9)', () => {
  let h: FocusHarness;
  let win: MemoryFocusWindow | null = null;

  async function boot(width: number, withWindow: boolean, extra?: () => JSX.Element) {
    mockViewport(width);
    win = withWindow ? createMemoryFocusWindow() : null;
    h = await setupFocus(`2${width >= 1024 ? '1' : '0'}${withWindow ? '1' : '0'}${String(counter++)}`, win ? { focusWindow: win.platform } : {});
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
    const task = await seedFocusTask(h.container, 'Envoyer la facture', { time: '09:00' });
    const view = render(
      <AppContainerProvider container={h.container}>
        <FocusHost />
        {extra?.()}
        <UndoToast />
      </AppContainerProvider>,
    );
    return { task, view };
  }

  beforeEach(() => {
    useNoticeStore.setState({ notice: null });
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [], day: null });
    useNoticeStore.setState({ notice: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await h.db.close();
  });

  it('critère 2 (iPhone) : le lancement ouvre l’écran plein et le minuteur démarre aussitôt avec 25 min', async () => {
    const { task } = await boot(390, false);
    expect(screen.queryByRole('region', { name: 'Session Focus' })).not.toBeInTheDocument();
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    const screenEl = await screen.findByRole('region', { name: 'Session Focus' });
    expect(screenEl).toHaveClass('ct-focus--screen');
    expect(screen.getByRole('timer')).toHaveTextContent('25:00');
    expect(screen.getByText('restantes sur 25 min')).toBeInTheDocument();
    expect(screen.getByText('09:00 ·', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });

  it('critère 9 : à l’ouverture de l’app, l’écran Focus se rouvre dans son état exact', async () => {
    mockViewport(390);
    h = await setupFocus('399');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
    const task = await seedFocusTask(h.container);
    await focusStore.get(h.container).getState().start(task.id);
    h.db.clock.advance(9 * MIN + 26_000);
    // Redémarrage : conteneur et magasins neufs sur les mêmes données.
    const { reopen } = await import('./testKit');
    const again = reopen(h);
    render(
      <AppContainerProvider container={again}>
        <FocusHost />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('timer')).toHaveTextContent('15:34');
    expect(screen.getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
  });

  it('critère 3 (PC sans mini-fenêtre système) : le même contenu s’affiche en panneau dans la fenêtre principale', async () => {
    const { task } = await boot(1440, false);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    expect(await screen.findByRole('region', { name: 'Session Focus' })).toHaveClass('ct-focus--panel');
  });

  it('critère 3 (PC) : la mini-fenêtre s’ouvre à la position mémorisée et reçoit les horodatages de la session', async () => {
    const { task } = await boot(1440, true);
    await h.db.data.repos.settings.set('focus.windowPosition', { x: 120, y: 80 });
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await waitFor(() => expect(win?.states.length).toBeGreaterThan(0));
    expect(win?.isOpen()).toBe(true);
    expect(win?.openedAt[0]).toEqual({ x: 120, y: 80 });
    const sent = win?.states.at(-1);
    expect(sent).toMatchObject({ phase: 'running', title: 'Envoyer la facture', time: '09:00', spaceName: 'Pro', canFinishTask: true, session: { plannedMin: 25, pausedSec: 0, endedAt: null } });
    // La fenêtre principale n’affiche pas de second écran de session.
    expect(screen.queryByRole('region', { name: 'Session Focus' })).not.toBeInTheDocument();
  });

  it('critère 3 : sans position mémorisée la fenêtre s’ouvre centrée ; son déplacement est mémorisé', async () => {
    const { task } = await boot(1440, true);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await waitFor(() => expect(win?.isOpen()).toBe(true));
    expect(win?.openedAt[0]).toBeNull();
    act(() => win?.move({ x: 300, y: 200 }));
    await waitFor(async () => expect(await h.db.data.repos.settings.get('focus.windowPosition')).toEqual({ x: 300, y: 200 }));
  });

  it('D4 : les ordres de la mini-fenêtre (durée, arrêt) sont exécutés par la fenêtre principale, qui écrit', async () => {
    const { task } = await boot(1440, true);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await waitFor(() => expect(win?.isOpen()).toBe(true));
    act(() => win?.emitAction({ type: 'duration', minutes: 50 }));
    await waitFor(async () => expect((await h.db.data.repos.focusSessions.getOpen())?.plannedMin).toBe(50));
    await waitFor(() => expect(win?.states.at(-1)?.session.plannedMin).toBe(50));
    h.db.clock.advance(7 * MIN);
    act(() => win?.emitAction({ type: 'stop' }));
    await waitFor(() => expect(win?.isOpen()).toBe(false));
    expect(await h.db.data.repos.focusSessions.getOpen()).toBeNull();
  });

  it('critère 6 : un second lancement affiche « Une session est déjà en cours » et ramène la fenêtre existante au premier plan', async () => {
    const { task } = await boot(1440, true);
    const other = await seedFocusTask(h.container, 'Autre tâche');
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await waitFor(() => expect(win?.isOpen()).toBe(true));
    const before = win?.bringToFrontCount() ?? 0;
    await act(async () => {
      await launchFocus(h.container, other.id);
    });
    expect(useNoticeStore.getState().notice?.text).toBe('Une session est déjà en cours');
    expect(win?.bringToFrontCount()).toBeGreaterThan(before);
    expect(await h.db.driver.select('SELECT id FROM focus_session', [])).toHaveLength(1);
  });

  it('critère 8 : « Terminer la tâche » ferme l’écran et propose « Annuler » (message de la tâche terminée)', async () => {
    const { task } = await boot(390, false);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await screen.findByRole('region', { name: 'Session Focus' });
    h.db.clock.advance(4 * MIN);
    fireEvent.click(screen.getByRole('button', { name: 'Terminer la tâche' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session Focus' })).not.toBeInTheDocument());
    expect(await screen.findByText('« Envoyer la facture » terminée')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
  });

  it('critère 7 : la croix demande confirmation puis arrête et enregistre', async () => {
    const { task } = await boot(390, false);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await screen.findByRole('region', { name: 'Session Focus' });
    h.db.clock.advance(12 * MIN);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter et enregistrer 12 min' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session Focus' })).not.toBeInTheDocument());
    expect(await h.db.data.repos.focusSessions.getOpen()).toBeNull();
    const rows = await h.db.driver.select<{ ended_at: string | null }>('SELECT ended_at FROM focus_session WHERE deleted_at IS NULL', []);
    expect(rows).toEqual([{ ended_at: '2026-10-04T08:12:00.000Z' }]);
  });

  it('critère 3 : Ctrl+Maj+F (registre) lance la session sur la tâche sélectionnée ; refusé si la tâche est terminée', async () => {
    const { task } = await boot(390, false, () => <Shortcut taskId={null} />);
    cleanup();
    render(
      <AppContainerProvider container={h.container}>
        <FocusHost />
        <Shortcut taskId={task.id} />
      </AppContainerProvider>,
    );
    h.container.taskEntities.publish([task]);
    const key = { key: 'F', code: 'KeyF', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, editable: false };
    await act(async () => {
      expect(h.container.shortcuts.handle(key)).toBe('list.focus');
    });
    await screen.findByRole('region', { name: 'Session Focus' });
    expect(SPACE_PRO_ID).toBeTruthy();
  });

  it('critère 3 : Ctrl+Maj+F décline sur une tâche terminée', async () => {
    const { task } = await boot(390, false);
    cleanup();
    const done = await h.db.data.repos.tasks.complete(task.id, '2026-10-04T08:00:00.000Z' as never);
    h.container.taskEntities.publish([done]);
    render(
      <AppContainerProvider container={h.container}>
        <FocusHost />
        <Shortcut taskId={task.id} />
      </AppContainerProvider>,
    );
    const key = { key: 'F', code: 'KeyF', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, editable: false };
    expect(h.container.shortcuts.handle(key)).toBeNull();
  });

  it('arrière-plan (iPhone) : la fin passée pendant que l’app dormait est constatée au retour au premier plan, sans aucun tic', async () => {
    const { task } = await boot(390, false);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await screen.findByRole('timer');
    // L'app part en arrière-plan : 40 minutes passent sans le moindre tic (ni intervalle ni minuterie ne s'exécute).
    h.db.clock.advance(40 * MIN);
    expect(screen.getByRole('timer')).toHaveTextContent('25:00'); // rien n'a été relu
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Session terminée · 25 min');
    expect(screen.getByRole('timer')).toHaveTextContent('00:00');
    expect((await h.db.driver.select<{ ended_at: string }>('SELECT ended_at FROM focus_session', []))[0]?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('F-02 : la pause et la reprise de la mini-fenêtre sont écrites et republiées (phase paused puis running)', async () => {
    const { task } = await boot(1440, true);
    await act(async () => {
      await launchFocus(h.container, task.id);
    });
    await waitFor(() => expect(win?.isOpen()).toBe(true));
    h.db.clock.advance(4 * MIN);
    act(() => win?.emitAction({ type: 'pause' }));
    await waitFor(() => expect(win?.states.at(-1)).toMatchObject({ phase: 'paused', session: { pausedAt: '2026-10-04T08:04:00.000Z' } }));
    h.db.clock.advance(6 * MIN);
    act(() => win?.emitAction({ type: 'resume' }));
    await waitFor(() => expect(win?.states.at(-1)).toMatchObject({ phase: 'running', session: { pausedAt: null, pausedSec: 360 } }));
  });
});
