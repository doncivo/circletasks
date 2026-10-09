import { systemClock, type Clock } from '../domain/clock';
import { describeError } from './errorText';
import type { MigrateOptions } from './migrator';

/**
 * Sauvegarde automatique avant migration (D-03 critères 8 et 9, PRD section 7, ADR 0002 avenant).
 * Le port est implémenté par la plateforme (src/platform/tauri/migrationBackup.ts) ; ce module
 * ne contient que l'orchestration, testable sans Tauri.
 *
 * I-06 (ADR 0007 avenant I-06 point 6) : la sauvegarde « Avant mise à jour » est UNIQUE pour une cible : une sauvegarde
 * `circletasks-pre-migration-vAAAA-to-vBBBB-…` avec BBBB = cible et AAAA ≤ version courante (mise à jour interrompue puis reprise, ou
 * nouvel essai après une restauration) est réutilisée au lieu d'en faire une autre. Liste illisible : nouvelle sauvegarde (un doublon vaut
 * mieux qu'aucune).
 */
export interface MigrationBackupRequest {
  /** Version de schéma de la base avant migration (>= 1 : une base neuve n'est jamais sauvegardée). */
  readonly fromVersion: number;
  /** Version visée après les migrations en attente. */
  readonly toVersion: number;
  /** Horodatage UTC compact AAAAMMJJTHHMMSSZ (nom du fichier). */
  readonly stamp: string;
}

/** Sauvegarde faite ou retrouvée : NOM du fichier dans le dossier des sauvegardes, jamais un chemin. */
export interface MigrationBackupResult {
  readonly name: string;
}

export interface MigrationBackup {
  /**
   * Écrit une copie cohérente de la base ; rejette si la copie est impossible. Rend `{ name }` (nom du fichier) ; une valeur d'une autre forme
   * (faux de test d'avant I-06) vaut « nom inconnu » : la migration continue, sans restauration proposée.
   */
  backup(request: MigrationBackupRequest): Promise<unknown>;
  /** Sauvegarde déjà faite pour cette cible (voir l'en-tête) ; null si aucune ou si la liste est illisible. */
  findPrevious?(target: { readonly fromVersion: number; readonly toVersion: number }): Promise<MigrationBackupResult | null>;
}

/** La sauvegarde a échoué : les migrations n'ont PAS été appliquées (message i18n : app.dbBackupError). */
export class MigrationBackupError extends Error {
  override readonly name = 'MigrationBackupError';
}

/** `2026-10-02T10:15:00.000Z` -> `20261002T101500Z`. */
export function backupStamp(clock: Clock): string {
  return new Date(clock.nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const PRE_MIGRATION_NAME = /^circletasks-pre-migration-v(\d{4})-to-v(\d{4})-(\d{8}T\d{6}Z)\.db$/;

const PRE_RESTORE_NAME = /^circletasks-pre-restore-(\d{8}T\d{6}Z)\.db$/;
const DAILY_NAME = /^circletasks-daily-(\d{8})\.db$/;

/**
 * Parmi des noms de sauvegardes, la sauvegarde « Avant mise à jour » à RÉUTILISER pour la cible, ou null (nouvelle sauvegarde). Pur : la
 * plateforme fournit les noms. Revue I-06 (I1) : réutilisée seulement pour une chaîne de migrations vraiment interrompue :
 * - même cible (BBBB = `toVersion`) et départ STRICTEMENT inférieur à la version courante (AAAA < `fromVersion` : au moins une migration
 *   de la chaîne a été validée depuis, l'app n'a donc pas pu servir entre-temps) ; la plus récente ;
 * - et aucune autre sauvegarde plus récente qu'elle : copie de sécurité d'une restauration (`pre-restore`), autre « Avant mise à jour »,
 *   ou sauvegarde quotidienne d'un jour postérieur (l'app a servi depuis : la candidate n'est plus l'état d'avant la mise à jour).
 * Sinon (même migration ratée puis relancée, restauration P-04 d'une ancienne version, version N utilisée entre deux essais) : null.
 */
export function findUpdateBackup(names: readonly string[], target: { readonly fromVersion: number; readonly toVersion: number }): MigrationBackupResult | null {
  let best: { name: string; stamp: string } | null = null;
  for (const name of names) {
    const match = PRE_MIGRATION_NAME.exec(name);
    if (!match) continue;
    const [, from = '', to = '', stamp = ''] = match;
    if (Number(to) !== target.toVersion || Number(from) >= target.fromVersion) continue;
    if (best === null || stamp > best.stamp) best = { name, stamp };
  }
  if (best === null) return null;
  const candidate = best;
  const newer = names.some((name) => {
    if (name === candidate.name) return false;
    const stamp = PRE_MIGRATION_NAME.exec(name)?.[3] ?? PRE_RESTORE_NAME.exec(name)?.[1];
    if (stamp !== undefined) return stamp > candidate.stamp;
    const day = DAILY_NAME.exec(name)?.[1];
    return day !== undefined && day > candidate.stamp.slice(0, 8);
  });
  return newer ? null : { name: candidate.name };
}

/** Résultat de `backup` qui porte un nom de fichier. */
function isBackupResult(value: unknown): value is MigrationBackupResult {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string' && (value as { name: string }).name !== '';
}

/** Dernier élément d'un chemin rendu par la plateforme (le nom seul est gardé et affiché). */
export function backupNameOf(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).pop() ?? pathOrName;
}

/**
 * Crochet `beforeApply` du migrateur. Sans port (navigateur de dev, SQLite Wasm en mémoire :
 * rien à protéger) : aucune sauvegarde. Base neuve (fromVersion 0) : aucune sauvegarde.
 * `onBackup` reçoit la sauvegarde faite ou réutilisée (écran d'échec : « Restaurer la sauvegarde d'avant la mise à jour »).
 */
export function createBackupBeforeMigration(
  port: MigrationBackup | undefined,
  clock: Clock = systemClock,
  onBackup: (backup: MigrationBackupResult & { readonly reused: boolean }) => void = () => undefined,
  /** Revue I-06 (M4) : liste des sauvegardes illisible (nouvelle sauvegarde faite) ; journalisé par l'appelant (code seul). */
  onListUnreadable: () => void = () => undefined,
): NonNullable<MigrateOptions['beforeApply']> {
  return async (pending, info) => {
    if (!port || info.fromVersion < 1) return;
    const last = pending.at(-1);
    if (!last) return;
    const target = { fromVersion: info.fromVersion, toVersion: last.version };
    const previous = port.findPrevious
      ? await port.findPrevious(target).catch(() => {
          onListUnreadable();
          return null;
        })
      : null;
    if (previous) {
      onBackup({ name: previous.name, reused: true });
      return;
    }
    let result: unknown;
    try {
      result = await port.backup({ ...target, stamp: backupStamp(clock) });
    } catch (error) {
      throw new MigrationBackupError(`Sauvegarde avant migration impossible : ${describeError(error)}`, { cause: error });
    }
    if (isBackupResult(result)) onBackup({ name: result.name, reused: false });
  };
}
