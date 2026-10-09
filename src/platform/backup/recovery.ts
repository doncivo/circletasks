import { reloadApp, relaunchApp } from '../relaunch';
import { reasonOf } from './tauriBackup';
import { startupRecoveryAvailable } from './recoveryAvailable';
import { BackupError, type BackupService } from './types';

export { startupRecoveryAvailable };

/**
 * I-06 (ADR 0007 avenant I-06 point 7, revue I2) : service de restauration de l'écran d'échec du démarrage, quand la base est FERMÉE
 * (migration en échec). Restaurer la sauvegarde « Avant mise à jour » est un RETOUR ARRIÈRE LOCAL, pas un retour dans le temps : commande
 * `restore_backup` avec `local: true` (Rust `restore_local_rollback`) : mêmes contrôles et même échange que P-04 / P-04-iOS, copie de
 * sécurité de la base actuelle, mais AUCUN marqueur de restauration de la synchro (jamais de fenêtre « Appliquer partout », la fusion
 * normale reprend). Rust vérifie qu'aucun pool SQL n'est ouvert (`db-open` sinon). Après l'échange : relance (PC) ou rechargement de la
 * WebView (iPhone). Navigateur de développement et autres systèmes : null (aucune action proposée).
 * En développement, un e2e peut poser `globalThis.__ctStartupRecovery` (faux) avant le chargement de la page.
 */
export interface StartupRecoveryApi {
  /** Retour arrière local (`restore_backup` avec `local: true`) ; rend l'issue de Rust (`marker: 'skipped'`). */
  rollback(name: string, stamp: string): Promise<unknown>;
  relaunch(): Promise<void>;
}

export function loadStartupRecoveryApi(): StartupRecoveryApi {
  return {
    async rollback(name, stamp) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('restore_backup', { name, stamp, local: true });
    },
    relaunch: relaunchApp,
  };
}

export function openStartupRecovery(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other', api: StartupRecoveryApi = loadStartupRecoveryApi()): BackupService | null {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctStartupRecovery?: BackupService }).__ctStartupRecovery;
    if (override) return override;
  }
  if (!startupRecoveryAvailable(runtime, os)) return null;
  return {
    available: () => true,
    list: () => Promise.resolve({ directory: null, versions: [] }),
    createDaily: () => Promise.reject(new BackupError('unavailable')),
    async restore({ name, stamp }) {
      try {
        await api.rollback(name, stamp);
      } catch (error) {
        // Base déjà fermée : un échec après l'appel demande un redémarrage pour la rouvrir (texte « redémarrez » de P-04).
        throw new BackupError(reasonOf(error), { cause: error, databaseClosed: true });
      }
      // Aucun marqueur : service « sans marqueur » au sens du contrat (`undefined`).
      return undefined;
    },
    restart: os === 'ios' ? reloadApp : () => api.relaunch(),
  };
}
