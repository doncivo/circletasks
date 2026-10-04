import type { FocusWindowAction, FocusWindowClient, FocusWindowPlatform, FocusWindowPosition, FocusWindowState } from './types';

/**
 * Faux de la mini-fenêtre (tests, F-01) : fenêtre principale et mini-fenêtre reliées en mémoire, sans Tauri. `platform` se passe au
 * conteneur ; `client` à la vue de la mini-fenêtre ; les compteurs et le journal permettent de vérifier ce qui a été demandé.
 */
export interface MemoryFocusWindow {
  readonly platform: FocusWindowPlatform;
  readonly client: FocusWindowClient;
  isOpen(): boolean;
  /** Positions passées à `open` (null : centrée), dans l'ordre. */
  readonly openedAt: (FocusWindowPosition | null)[];
  readonly states: FocusWindowState[];
  bringToFrontCount(): number;
  /** Simule un ordre de la mini-fenêtre. */
  emitAction(action: FocusWindowAction): void;
  /** Simule la croix de la barre de titre. */
  requestClose(): void;
  /** Simule un déplacement de la fenêtre. */
  move(position: FocusWindowPosition): void;
}

export function createMemoryFocusWindow(): MemoryFocusWindow {
  let open = false;
  let bringToFront = 0;
  let last: FocusWindowState | null = null;
  const actionHandlers = new Set<(action: FocusWindowAction) => void>();
  const stateHandlers = new Set<(state: FocusWindowState) => void>();
  const closeHandlers = new Set<() => void>();
  const moveHandlers = new Set<(position: FocusWindowPosition) => void>();
  const openedAt: (FocusWindowPosition | null)[] = [];
  const states: FocusWindowState[] = [];

  const emitAction = (action: FocusWindowAction): void => {
    for (const handler of actionHandlers) handler(action);
  };

  return {
    platform: {
      open: (position) => {
        openedAt.push(position);
        if (open) bringToFront += 1;
        open = true;
        return Promise.resolve();
      },
      bringToFront: () => {
        if (open) bringToFront += 1;
        return Promise.resolve();
      },
      close: () => {
        open = false;
        last = null;
        return Promise.resolve();
      },
      publish: (state) => {
        last = state;
        states.push(state);
        if (open) for (const handler of stateHandlers) handler(state);
        return Promise.resolve();
      },
      onAction: (handler) => {
        actionHandlers.add(handler);
        return Promise.resolve(() => actionHandlers.delete(handler));
      },
    },
    client: {
      onState: (handler) => {
        stateHandlers.add(handler);
        if (last) handler(last);
        return Promise.resolve(() => stateHandlers.delete(handler));
      },
      send: (action) => {
        emitAction(action);
        return Promise.resolve();
      },
      onCloseRequested: (handler) => {
        closeHandlers.add(handler);
        return Promise.resolve(() => closeHandlers.delete(handler));
      },
      onMoved: (handler) => {
        moveHandlers.add(handler);
        return Promise.resolve(() => moveHandlers.delete(handler));
      },
    },
    isOpen: () => open,
    openedAt,
    states,
    bringToFrontCount: () => bringToFront,
    emitAction,
    requestClose: () => {
      for (const handler of closeHandlers) handler();
    },
    move: (position) => {
      emitAction({ type: 'moved', ...position });
      for (const handler of moveHandlers) handler(position);
    },
  };
}
