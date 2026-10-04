/** Libellé de la mini-fenêtre Focus (capability src-tauri/capabilities/focus.json). */
export const FOCUS_WINDOW_LABEL = 'focus';
/** Libellé de la fenêtre principale (tauri.conf.json). */
export const MAIN_WINDOW_LABEL = 'main';
/** Page chargée par la mini-fenêtre : la même application, en mode « vue Focus » (src/main.tsx). */
export const FOCUS_WINDOW_QUERY = 'window=focus';
export const FOCUS_WINDOW_URL = `index.html?${FOCUS_WINDOW_QUERY}`;
/** 340 × 460 px (F-01 D3, non redimensionnable). */
export const FOCUS_WINDOW_WIDTH = 340;
export const FOCUS_WINDOW_HEIGHT = 460;
/** Événements entre les deux fenêtres. */
export const FOCUS_STATE_EVENT = 'focus://state';
export const FOCUS_ACTION_EVENT = 'focus://action';
