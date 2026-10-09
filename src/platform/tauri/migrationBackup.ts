import { invoke } from '@tauri-apps/api/core';
import type { SqlDriver } from '../../db/driver';
import { backupNameOf, findUpdateBackup, type MigrationBackup } from '../../db/migrationBackup';

export const BACKUP_COMMAND = 'backup_database_before_migration';

interface BackupResult {
  readonly path: string | null;
}

/**
 * Sauvegarde Tauri : point de contrôle WAL (TRUNCATE) sur l'unique connexion (busy = 0 exigé),
 * puis commande Rust qui fait `VACUUM INTO` vers `<dossier de données>/backups/`
 * (src-tauri/src/backup.rs). Toute erreur est propagée, y compris « aucun fichier créé » :
 * le migrateur n'applique alors rien. Le chemin rendu par Rust est réduit à son NOM (I-06).
 *
 * I-06 : `findPrevious` relit la liste des sauvegardes (`list_backups`, capabilities `backups` et `backups-ios`) ; une liste illisible
 * rejette : l'orchestration fait alors une nouvelle sauvegarde et le journalise.
 */
export function createTauriMigrationBackup(db: SqlDriver): MigrationBackup {
  return {
    backup: async ({ fromVersion, toVersion, stamp }) => {
      const [checkpoint] = await db.select('PRAGMA wal_checkpoint(TRUNCATE)');
      if (checkpoint?.['busy'] !== 0) throw new Error('Point de contrôle WAL incomplet (base occupée)');
      const result = await invoke<BackupResult>(BACKUP_COMMAND, { fromVersion, toVersion, stamp });
      if (!result.path) throw new Error('Aucun fichier de sauvegarde créé');
      return { name: backupNameOf(result.path) };
    },
    // Liste illisible : rejet, rattrapé par l'orchestration (nouvelle sauvegarde, journal `pre-migration-list-unreadable`).
    findPrevious: async (target) => {
      const listing = await invoke<{ entries?: readonly { name?: unknown }[] }>('list_backups');
      const names = (listing.entries ?? []).flatMap((entry) => (typeof entry.name === 'string' ? [entry.name] : []));
      return findUpdateBackup(names, target);
    },
  };
}
