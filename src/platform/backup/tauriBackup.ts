import { relaunchApp } from '../relaunch';
import { BackupError, type BackupFailureReason, type BackupKind, type BackupListing, type BackupService } from './types';

/** Commandes Rust (`src-tauri/src/backup.rs`, capability `backups.json`), injectables pour les tests. */
export interface TauriBackupApi {
  list(): Promise<{ directory: string; entries: readonly RawBackupEntry[] }>;
  daily(day: string, replace: boolean): Promise<{ created: boolean }>;
  check(name: string): Promise<number>;
  restore(name: string, stamp: string): Promise<unknown>;
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

/** Aucun paramètre venant de l'interface sauf le jour, le remplacement, un NOM de sauvegarde et l'horodatage ; la version de schéma est une constante de Rust. */
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
    async check(name) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('check_backup', { name });
    },
    async restore(name, stamp) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('restore_backup', { name, stamp });
    },
    async reveal() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_backups_folder');
    },
    relaunch: relaunchApp,
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
  readonly api?: TauriBackupApi;
}

/**
 * PC Windows : sauvegarde quotidienne (point de contrôle WAL puis `VACUUM INTO` côté Rust, hors du fil de l'interface), liste, restauration.
 * Restauration : la version est vérifiée AVANT de fermer la base (un fichier refusé ne coûte rien), puis la base est fermée, Rust fait la
 * copie de sécurité et l'échange atomique, et l'app redémarre. Si l'échange échoue après la fermeture, Rust a remis l'ancien fichier en
 * place ; `databaseClosed` signale qu'il faut redémarrer pour rouvrir la base.
 *
 * Le point de contrôle WAL (`wal_checkpoint(TRUNCATE)`) est au mieux : son résultat (`busy`) n'est pas exigé, car `VACUUM INTO` lit le WAL et la
 * copie reste cohérente même si la base est occupée ; il ne sert qu'à garder le fichier principal à jour. (La sauvegarde AVANT migration, elle,
 * exige `busy = 0` : voir `platform/tauri/migrationBackup.ts`.)
 */
export function createTauriBackup(options: TauriBackupOptions): BackupService {
  const api = options.api ?? loadTauriBackupApi();
  const checkpoint = (): Promise<unknown> => options.db.select('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
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
        await checkpoint();
        const result = await api.daily(day, replace);
        return { created: result.created };
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error });
      }
    },
    async restore({ name, stamp }) {
      try {
        await api.check(name);
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error });
      }
      try {
        await checkpoint();
        await options.db.close();
      } catch (error) {
        throw new BackupError('io', { cause: error });
      }
      try {
        await api.restore(name, stamp);
      } catch (error) {
        throw new BackupError(reasonOf(error), { cause: error, databaseClosed: true });
      }
    },
    restart: () => api.relaunch(),
    reveal: () => api.reveal(),
  };
}
