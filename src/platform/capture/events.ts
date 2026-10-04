/**
 * Noms partagés avec src-tauri/src/capture.rs (Q-01). Une divergence casse `consistency.test.ts` et `cargo test`.
 */

/** Libellés des deux fenêtres. */
export const MAIN_WINDOW_LABEL = 'main';
export const CAPTURE_WINDOW_LABEL = 'quick-capture';

/** Émis par Rust vers la mini-fenêtre : elle vient d'être montrée (le champ est vidé et focalisé). */
export const SHOWN_EVENT = 'capture://shown';
/** Émis par Rust vers la mini-fenêtre : elle a perdu le focus (fermeture si le champ est vide). */
export const BLURRED_EVENT = 'capture://blurred';

/** Mini-fenêtre -> fenêtre principale : texte à créer (`capture:submit { text }`, Q-01 décision D1). */
export const SUBMIT_EVENT = 'capture:submit';
/** Fenêtre principale -> mini-fenêtre : résultat de la création. */
export const DONE_EVENT = 'capture:done';
/** Fenêtre principale -> mini-fenêtre : espaces, projets et filtre pour les suggestions et l'aperçu. */
export const CONTEXT_EVENT = 'capture:context';
/** Mini-fenêtre -> fenêtre principale : demande d'un contexte à jour. */
export const CONTEXT_REQUEST_EVENT = 'capture:context-request';

/** Commandes Rust de la mini-fenêtre. */
export const HIDE_COMMAND = 'hide_quick_capture';
export const RESIZE_COMMAND = 'resize_quick_capture';

/** Délai d'attente de la réponse de la fenêtre principale avant d'annoncer un échec. */
export const SUBMIT_TIMEOUT_MS = 8_000;
