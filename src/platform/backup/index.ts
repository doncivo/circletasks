import type { SqlDriver } from '../../db/driver';
import { createMemoryBackup, createUnavailableBackup } from './memory';
import { createTauriBackup } from './tauriBackup';
import type { BackupService } from './types';

export { createMemoryBackup, createUnavailableBackup, type MemoryBackup, type MemoryBackupOptions } from './memory';
export { createTauriBackup, loadTauriBackupApi, reasonOf, type RawBackupEntry, type TauriBackupApi, type TauriBackupOptions } from './tauriBackup';
export {
  BackupError,
  backupFailureOf,
  type BackupFailureReason,
  type BackupKind,
  type BackupListing,
  type BackupService,
  type BackupVersion,
  type DailyBackupRequest,
  type RestoreRequest,
} from './types';

/**
 * Service de sauvegarde de la plateforme courante : PC Windows installé -> commandes Rust ; iPhone -> indisponible (les commandes ne lui
 * sont pas ouvertes à l'ordre 3, voir ADR 0009 avenant) ; navigateur de développement -> service en mémoire (aucun fichier).
 * En développement, un test de bout en bout peut poser `globalThis.__ctBackups` (faux) avant le chargement de la page.
 */
export function openBackupService(
  runtime: 'tauri' | 'web',
  os: 'windows' | 'ios' | 'other',
  tauri: { readonly db: SqlDriver; readonly appSchemaVersion: number },
): BackupService {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctBackups?: BackupService }).__ctBackups;
    if (override) return override;
  }
  if (runtime === 'web') return createMemoryBackup();
  return os === 'windows' ? createTauriBackup(tauri) : createUnavailableBackup();
}
