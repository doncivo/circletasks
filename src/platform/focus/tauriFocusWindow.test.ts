// Correctif F-01 (lot Y1, ADR 0011 section 2.1) : la mini-fenêtre Focus est ouverte, ramenée et fermée par des commandes Rust ; la
// fenêtre principale ne crée plus de fenêtre. Comportement inchangé : état publié seulement quand la fenêtre est ouverte, renvoyé à « ready ».
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitTo = vi.fn(async () => undefined);
const listeners: ((event: { payload: unknown }) => void)[] = [];
vi.mock('@tauri-apps/api/event', () => ({
  emitTo,
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler);
    return () => undefined;
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));

const { createTauriFocusWindow } = await import('./tauriFocusWindow');

describe('createTauriFocusWindow (F-01, correctif du lot Y1)', () => {
  beforeEach(() => {
    emitTo.mockClear();
    listeners.length = 0;
  });

  it('ouvre, ramène et ferme par les trois commandes Rust, position arrondie', async () => {
    const call = vi.fn(async () => undefined);
    const platform = createTauriFocusWindow(call);
    await platform.open({ x: 10.6, y: 20.2 });
    await platform.open(null);
    await platform.bringToFront();
    await platform.close();
    expect(call.mock.calls).toEqual([
      ['focus_window_open', { position: { x: 11, y: 20 } }],
      ['focus_window_open', { position: null }],
      ['focus_window_bring_to_front'],
      ['focus_window_close'],
    ]);
  });

  it('publie l’état seulement fenêtre ouverte, et le renvoie quand la mini-fenêtre est prête', async () => {
    const platform = createTauriFocusWindow(vi.fn(async () => undefined));
    const state = { phase: 'running' } as never;
    await platform.publish(state);
    expect(emitTo).not.toHaveBeenCalled();
    await platform.open(null);
    await platform.publish(state);
    expect(emitTo).toHaveBeenCalledWith('focus', 'focus://state', state);
    const actions: unknown[] = [];
    await platform.onAction((action) => actions.push(action));
    listeners[0]?.({ payload: { type: 'ready' } });
    expect(emitTo).toHaveBeenCalledTimes(2);
    expect(actions).toEqual([{ type: 'ready' }]);
  });

  it('revue 21 : une mini-fenêtre prête (ouverture dont la réponse a échoué) reçoit de nouveau les états publiés', async () => {
    const call = vi.fn(async (command: string) => (command === 'focus_window_open' ? Promise.reject(new Error('délai')) : undefined));
    const platform = createTauriFocusWindow(call);
    await expect(platform.open(null)).rejects.toThrow();
    await platform.onAction(() => undefined);
    listeners[0]?.({ payload: { type: 'ready' } });
    const state = { phase: 'running' } as never;
    await platform.publish(state);
    expect(emitTo).toHaveBeenCalledWith('focus', 'focus://state', state);
  });

  it('une fermeture qui échoue côté Rust est sans effet visible', async () => {
    const platform = createTauriFocusWindow(vi.fn(async (command: string) => (command === 'focus_window_close' ? Promise.reject(new Error('x')) : undefined)));
    await expect(platform.close()).resolves.toBeUndefined();
  });
});
