import { emitTo, listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  FOCUS_ACTION_EVENT,
  FOCUS_STATE_EVENT,
  FOCUS_WINDOW_HEIGHT,
  FOCUS_WINDOW_LABEL,
  FOCUS_WINDOW_URL,
  FOCUS_WINDOW_WIDTH,
  MAIN_WINDOW_LABEL,
} from './constants';
import type { FocusWindowAction, FocusWindowClient, FocusWindowPlatform, FocusWindowPosition, FocusWindowState } from './types';

/** La position mémorisée tombe-t-elle encore sur un écran ? (un écran débranché ne doit pas rendre la fenêtre introuvable). */
async function isOnScreen(position: FocusWindowPosition): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    return monitors.some((monitor) => {
      const { x, y } = monitor.position;
      const { width, height } = monitor.size;
      return position.x >= x - 40 && position.y >= y && position.x < x + width - 80 && position.y < y + height - 80;
    });
  } catch {
    return false;
  }
}

/** Implémentation Tauri (Windows) côté fenêtre principale. Ne s'importe que via `openFocusWindowPlatform`. */
export function createTauriFocusWindow(): FocusWindowPlatform {
  let lastState: FocusWindowState | null = null;

  async function existing(): Promise<WebviewWindow | null> {
    return WebviewWindow.getByLabel(FOCUS_WINDOW_LABEL);
  }

  async function reveal(window: WebviewWindow): Promise<void> {
    await window.unminimize().catch(() => undefined);
    await window.show().catch(() => undefined);
    await window.setFocus().catch(() => undefined);
  }

  return {
    async open(position) {
      const current = await existing();
      if (current) {
        await reveal(current);
        return;
      }
      const usable = position && (await isOnScreen(position)) ? position : null;
      await new Promise<void>((resolve, reject) => {
        const created = new WebviewWindow(FOCUS_WINDOW_LABEL, {
          url: FOCUS_WINDOW_URL,
          title: 'Focus',
          width: FOCUS_WINDOW_WIDTH,
          height: FOCUS_WINDOW_HEIGHT,
          // Position et taille en pixels logiques : x / y mémorisés sont physiques, convertis par la fenêtre à l'ouverture.
          ...(usable ? { x: usable.x, y: usable.y } : { center: true }),
          resizable: false,
          maximizable: false,
          minimizable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          focus: true,
        });
        void created.once('tauri://created', () => resolve());
        void created.once('tauri://error', (event) => reject(new Error(String(event.payload))));
      });
    },

    async bringToFront() {
      const current = await existing();
      if (current) await reveal(current);
    },

    async close() {
      lastState = null;
      const current = await existing();
      if (current) await current.destroy().catch(() => undefined);
    },

    async publish(state) {
      lastState = state;
      if (await existing()) await emitTo(FOCUS_WINDOW_LABEL, FOCUS_STATE_EVENT, state);
    },

    onAction: (handler) =>
      listen<FocusWindowAction>(FOCUS_ACTION_EVENT, (event) => {
        // La mini-fenêtre vient de charger son interface : elle reçoit aussitôt l'état courant.
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
