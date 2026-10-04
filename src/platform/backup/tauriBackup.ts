import { BackupError, type BackupFailureReason, type BackupKind, type BackupListing, type BackupService } from './types';

/** Commandes Rust (`src-tauri/src/backup.rs`, capability `backups.json`), injectables pour les tests. */
export interface TauriBackupApi {
  list(): Promise<{ directory: string; entries: readonly RawBackupEntry[] }>;
  daily(day: string, replace: boolean): Promise<{ created: boolean }>;
  check(name: string, appSchemaVersion: number): Promise<number>;
  restore(name: string, stamp: string, appSchemaVersion: number): Promise<unknown>;
  reveal(): Promise<void>;
  relaunch(): Promise<void>;
}

export interface RawBackupEntry {
  readonly name: string;
  readonly kind: BackupKind;
  readonly stamp: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly tasks: number | null;
  readonly schemaVersion: number | null;
}

export function loadTauriBackupApi(): TauriBackupApi {
  return {
    async list() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('list_backups');
    },
    async daily(day, replace) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('daily_backup', { day, replace });
    },
    async check(name, appSchemaVersion) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('check_backup', { name, appSchemaVersion });
    },
    async restore(name, stamp, appSchemaVersion) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('restore_backup', { name, stamp, appSchemaVersion });
    },
    async reveal() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_backups_folder');
    },
    async relaunch() {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

const KNOWN_REASONS: readonly BackupFailureReason[] = ['corrupt', 'newer-schema', 'not-found', 'rollback-failed'];

/** Erreur Rust `{ code, message }` -> raison stable ; tout le reste vaut `io`. */
export function reasonOf(error: unknown): BackupFailureReason {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return KNOWN_REASONS.find((reason) => reason === code) ?? 'io';
}

export interface TauriBackupOptions {
  /** Connexion unique de l'app : point de contrôle WAL avant une copie, fermée avant une restauration. */
  readonly db: { select(sql: string): Promise<unknown>; close(): Promise<void> };
  /** Plus haute version de schéma connue de cette app : une sauvegarde plus récente est refusée. */
  readonly appSchemaVersion: number;
  readonly api?: TauriBackupApi;
}

/**
 * PC Windows : sauvegarde quotidienne (point de contrôle WAL puis `VACUUM INTO` côté Rust, hors du fil de l'interface), liste, restauration.
 * Restauration : la version est vérifiée AVANT de fermer la base (un fichier refusé ne coûte rien), puis la base est fermée, Rust fait la
 * copie de sécurité et l'échange atomique, et l'app redémarre. Si l'échange échoue après la fermeture, Rust a remis l'ancien fichier en
 * place ; `databaseClosed` signale qu'il faut redémarrer pour rouvrir la base.
 */
export function createTauriBackup(options: TauriBackupOptions): BackupService {
  const api = options.api ?? loadTauriBackupApi();
  return {
    available: () => true,
    async list(): Promise<BackupListing> {
      try {
        const listing = await api.list();
        return { directory: listing.directory, versions: listing.entries };
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error });
      }
    },
    async createDaily({ day, replace }) {
      try {
        // Point de contrôle : le fichier principal est à jour ; la copie reste correcte même si la base est occupée (VACUUM INTO lit le WAL).
        await options.db.select('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
        const result = await api.daily(day, replace);
        return { created: result.created };
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error });
      }
    },
    async restore({ name, stamp }) {
      try {
        await api.check(name, options.appSchemaVersion);
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error });
      }
      try {
        await options.db.select('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
        await options.db.close();
      } catch (error) {
        throw new BackupError('io', { cause: error });
      }
      try {
        await api.restore(name, stamp, options.appSchemaVersion);
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error, databaseClosed: true });
      }
    },
    restart: () => api.relaunch(),
    reveal: () => api.reveal(),
  };
}
