import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FOCUS_ACTION_EVENT, FOCUS_STATE_EVENT, FOCUS_WINDOW_LABEL, MAIN_WINDOW_LABEL } from './constants';
import type { FocusWindowAction, FocusWindowClient, FocusWindowPlatform, FocusWindowState } from './types';

/** Commandes Rust de la mini-fenêtre (`src-tauri/src/focus_window.rs`), injectables pour les tests. */
export type FocusWindowInvoker = (command: 'focus_window_open' | 'focus_window_bring_to_front' | 'focus_window_close', args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Implémentation Tauri (Windows) côté fenêtre principale. Ne s'importe que via `openFocusWindowPlatform`.
 *
 * Correctif du lot Y1 (ADR 0011 section 2.1, troisième audit H1) : la fenêtre principale ne crée plus de fenêtre. Ouverture, retour au
 * premier plan et fermeture passent par trois commandes Rust, qui fixent libellé, URL et options et recentrent une position tombée hors
 * des écrans ; la capability `focus-launcher.json` n'accorde que ces trois commandes. Comportement de F-01 inchangé.
 */
export function createTauriFocusWindow(call: FocusWindowInvoker = (command, args) => invoke(command, args)): FocusWindowPlatform {
  let lastState: FocusWindowState | null = null;
  let open = false;

  return {
    async open(position) {
      await call('focus_window_open', { position: position ? { x: Math.round(position.x), y: Math.round(position.y) } : null });
      open = true;
    },

    async bringToFront() {
      await call('focus_window_bring_to_front');
    },

    async close() {
      lastState = null;
      open = false;
      await call('focus_window_close').catch(() => undefined);
    },

    async publish(state) {
      lastState = state;
      if (open) await emitTo(FOCUS_WINDOW_LABEL, FOCUS_STATE_EVENT, state);
    },

    onAction: (handler) =>
      listen<FocusWindowAction>(FOCUS_ACTION_EVENT, (event) => {
        // La mini-fenêtre vient de charger son interface : elle reçoit aussitôt l'état courant.
        // La mini-fenêtre existe (rechargée, ou rouverte après un échec d'appel) : l'état lui est de nouveau publié (revue 21).
        if (event.payload.type === 'ready') open = true;
        if (event.payload.type === 'ready' && lastState) void emitTo(FOCUS_WINDOW_LABEL, FOCUS_STATE_EVENT, lastState);
        handler(event.payload);
      }),
  };
}

/** Implémentation Tauri côté mini-fenêtre (aucun accès à la base : D4). */
export function createTauriFocusClient(): FocusWindowClient {
  const current = getCurrentWindow();
  return {
    onState: (handler) => listen<FocusWindowState>(FOCUS_STATE_EVENT, (event) => handler(event.payload)),
    send: (action) => emitTo(MAIN_WINDOW_LABEL, FOCUS_ACTION_EVENT, action),
    onCloseRequested: (handler) =>
      current.onCloseRequested((event) => {
        event.preventDefault();
        handler();
      }),
    onMoved: (handler) => current.onMoved((event) => handler({ x: event.payload.x, y: event.payload.y })),
  };
}
