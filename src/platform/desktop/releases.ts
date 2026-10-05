/**
 * Dépôt public des versions (D-03). Doit rester cohérent avec `plugins.updater.endpoints` de
 * src-tauri/tauri.conf.json et le périmètre `opener:allow-open-url` de
 * src-tauri/capabilities/desktop.json (vérifié par releases.test.ts et cargo test).
 * Aucun secret : le dépôt est public.
 */
export const RELEASES_REPOSITORY_URL = 'https://github.com/doncivo/circletasks-releases';

/** Page de la dernière version, ouverte depuis « À propos ». */
export const LATEST_RELEASE_URL = `${RELEASES_REPOSITORY_URL}/releases/latest`;

/** Événement émis par Rust pour l'entrée « Ajout rapide » (src-tauri/src/desktop.rs, QUICK_ADD_EVENT). */
export const QUICK_ADD_EVENT = 'desktop://quick-add';

/** Événement émis par Rust pour l'entrée « Synchroniser maintenant » (src-tauri/src/desktop.rs, TRAY_SYNC_NOW_EVENT ; Y-03). */
export const TRAY_SYNC_NOW_EVENT = 'tray-sync-now';

/** Commande Rust qui reçoit les textes du menu (src-tauri/src/desktop.rs, set_tray_labels). */
export const SET_TRAY_LABELS_COMMAND = 'set_tray_labels';

/** Événement émis par Rust avant de quitter (QUITTING_EVENT) ; le front répond par confirm_quit. */
export const QUITTING_EVENT = 'desktop://quitting';

/** Commande Rust de confirmation de sortie (src-tauri/src/desktop.rs, confirm_quit). */
export const CONFIRM_QUIT_COMMAND = 'confirm_quit';

/** Commandes Rust du raccourci global (src-tauri/src/shortcut.rs, D-04). */
export const SET_QUICK_CAPTURE_COMMAND = 'set_quick_capture_shortcut';
export const CLEAR_QUICK_CAPTURE_COMMAND = 'clear_quick_capture_shortcut';
export const GET_QUICK_CAPTURE_COMMAND = 'get_quick_capture_shortcut';
