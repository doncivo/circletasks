import { invoke } from '@tauri-apps/api/core';
import type { SqlDriver } from '../../db/driver';
import type { MigrationBackup } from '../../db/migrationBackup';

export const BACKUP_COMMAND = 'backup_database_before_migration';

/**
 * Sauvegarde Tauri : point de contrôle WAL (TRUNCATE) sur l'unique connexion, puis commande Rust
 * qui copie circletasks.db vers `<dossier de données>/backups/` (src-tauri/src/backup.rs).
 * Toute erreur (checkpoint ou copie) est propagée : le migrateur n'applique alors rien.
 */
export function createTauriMigrationBackup(db: SqlDriver): MigrationBackup {
  return {
    backup: async ({ fromVersion, toVersion, stamp }) => {
      await db.select('PRAGMA wal_checkpoint(TRUNCATE)');
      await invoke(BACKUP_COMMAND, { fromVersion, toVersion, stamp });
    },
  };
}
