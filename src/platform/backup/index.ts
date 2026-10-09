import type { SqlDriver } from '../../db/driver';
import { createMemoryBackup, createUnavailableBackup } from './memory';
import { reloadApp } from '../relaunch';
import { createTauriBackup } from './tauriBackup';
import type { BackupService } from './types';

export { createMemoryBackup, createUnavailableBackup, type MemoryBackup, type MemoryBackupOptions } from './memory';
export { createTauriBackup, loadTauriBackupApi, markerOf, reasonOf, type RawBackupEntry, type TauriBackupApi, type TauriBackupOptions } from './tauriBackup';
export {
  BackupError,
  backupFailureOf,
  type BackupFailureReason,
  type BackupKind,
  type BackupListing,
  type BackupService,
  type BackupVersion,
  type DailyBackupRequest,
  type RestoreHooks,
  type RestoreRequest,
  type RestoreResult,
} from './types';

/**
 * Service de sauvegarde de la plateforme courante : PC Windows installé -> commandes Rust, relance ; iPhone (P-04-iOS, ADR 0009 avenant
 * lot F B1-B2) -> mêmes commandes, rechargement de la WebView, sans « Afficher dans le dossier » ; navigateur de développement -> service en
 * mémoire (aucun fichier).
 * En développement, un test de bout en bout peut poser `globalThis.__ctBackups` (faux) avant le chargement de la page.
 */
export function openBackupService(
  runtime: 'tauri' | 'web',
  os: 'windows' | 'ios' | 'other',
  tauri: { readonly db: SqlDriver },
): BackupService {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctBackups?: BackupService }).__ctBackups;
    if (override) return override;
  }
  if (runtime === 'web') return createMemoryBackup();
  if (os === 'windows') return createTauriBackup(tauri);
  if (os === 'ios') return createTauriBackup({ ...tauri, restart: reloadApp, reveal: false });
  return createUnavailableBackup();
}
