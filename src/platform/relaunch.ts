import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Seul point de relance de l'app (PC) : utilisé après l'installation d'une mise à jour (D-03) et après une restauration de sauvegarde (P-04).
 * Permission `process:allow-restart` de la capability `desktop`.
 */
export function relaunchApp(): Promise<void> {
  return relaunch();
}
