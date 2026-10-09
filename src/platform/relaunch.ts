import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Seul point de relance de l'app : utilisé après l'installation d'une mise à jour (D-03) et après une restauration de sauvegarde (P-04).
 * PC : relance du processus (permission `process:allow-restart` de la capability `desktop`).
 */
export function relaunchApp(): Promise<void> {
  return relaunch();
}

/**
 * iPhone (P-04-iOS, ADR 0009 avenant lot F B2) : pas de relance de processus sur iOS ; après une restauration, la WebView est RECHARGÉE.
 * La base, fermée avant l'échange, est rouverte par le chemin normal du démarrage (migrations comprises) ; l'état Rust survit.
 */
export function reloadApp(): Promise<void> {
  globalThis.location.reload();
  return Promise.resolve();
}
