import { systemClock, type Clock } from '../domain/clock';
import { describeError } from './errorText';
import type { MigrateOptions } from './migrator';

/**
 * Sauvegarde automatique avant migration (D-03 critères 8 et 9, PRD section 7, ADR 0002 avenant).
 * Le port est implémenté par la plateforme (src/platform/tauri/migrationBackup.ts) ; ce module
 * ne contient que l'orchestration, testable sans Tauri.
 */
export interface MigrationBackupRequest {
  /** Version de schéma de la base avant migration (>= 1 : une base neuve n'est jamais sauvegardée). */
  readonly fromVersion: number;
  /** Version visée après les migrations en attente. */
  readonly toVersion: number;
  /** Horodatage UTC compact AAAAMMJJTHHMMSSZ (nom du fichier). */
  readonly stamp: string;
}

export interface MigrationBackup {
  /** Écrit une copie cohérente de la base ; rejette si la copie est impossible. */
  backup(request: MigrationBackupRequest): Promise<void>;
}

/** La sauvegarde a échoué : les migrations n'ont PAS été appliquées (message i18n : app.dbBackupError). */
export class MigrationBackupError extends Error {
  override readonly name = 'MigrationBackupError';
}

/** `2026-10-02T10:15:00.000Z` -> `20261002T101500Z`. */
export function backupStamp(clock: Clock): string {
  return new Date(clock.nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Crochet `beforeApply` du migrateur. Sans port (navigateur de dev, SQLite Wasm en mémoire :
 * rien à protéger) : aucune sauvegarde. Base neuve (fromVersion 0) : aucune sauvegarde.
 */
export function createBackupBeforeMigration(
  port: MigrationBackup | undefined,
  clock: Clock = systemClock,
): NonNullable<MigrateOptions['beforeApply']> {
  return async (pending, info) => {
    if (!port || info.fromVersion < 1) return;
    const last = pending.at(-1);
    if (!last) return;
    try {
      await port.backup({ fromVersion: info.fromVersion, toVersion: last.version, stamp: backupStamp(clock) });
    } catch (error) {
      throw new MigrationBackupError(`Sauvegarde avant migration impossible : ${describeError(error)}`, { cause: error });
    }
  };
}
