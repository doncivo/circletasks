import { reloadApp } from '../relaunch';
import { createTauriBackup, type TauriBackupApi } from './tauriBackup';
import type { BackupService } from './types';

/**
 * I-06 (ADR 0007 avenant I-06 point 7) : service de restauration de l'écran d'échec du démarrage, quand la base est FERMÉE (migration en
 * échec). Mêmes commandes Rust que P-04 / P-04-iOS (`createTauriBackup`) ; l'adaptateur de base fermée rend le point de contrôle et la
 * fermeture sans effet (rien n'est ouvert : Rust vérifie qu'aucun pool SQL ne l'est, sinon `db-open`). Après l'échange : relance (PC) ou
 * rechargement de la WebView (iPhone). Navigateur de développement et autres systèmes : null (aucune action proposée).
 * En développement, un e2e peut poser `globalThis.__ctStartupRecovery` (faux) avant le chargement de la page.
 */
export function openStartupRecovery(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other', api?: TauriBackupApi): BackupService | null {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctStartupRecovery?: BackupService }).__ctStartupRecovery;
    if (override) return override;
  }
  if (runtime !== 'tauri' || os === 'other') return null;
  const closed = { select: () => Promise.resolve([]), close: () => Promise.resolve() };
  return createTauriBackup({ db: closed, ...(api ? { api } : {}), ...(os === 'ios' ? { restart: reloadApp } : {}), reveal: false });
}
