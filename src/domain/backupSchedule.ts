import { todayLocal, type Clock } from './clock';
import type { LocalDate } from './types';

/**
 * Règles de la sauvegarde locale (P-04, PRD sections 7 et 8) : une sauvegarde quotidienne, 14 versions gardées, tri et libellés des
 * versions. Pur : l'instant vient d'une `Clock` injectée, l'écriture des fichiers est faite par `platform/backup`.
 */

/** Nombre de sauvegardes quotidiennes conservées (même valeur que `KEEP_DAILY_BACKUPS` de `src-tauri/src/backup.rs`). */
export const KEEP_DAILY_BACKUPS = 14;

/** Version listée (sous-ensemble de `BackupVersion` de la plateforme, sans dépendance à elle). */
export interface BackupVersionInfo {
  readonly name: string;
  readonly kind: 'daily' | 'pre-migration' | 'pre-restore';
  readonly stamp: string;
  readonly modifiedMs: number;
}

/** Jour local de l'horloge au format du nom de fichier (`AAAAMMJJ`). */
export function backupDay(clock: Clock): string {
  return todayLocal(clock).replaceAll('-', '');
}

/** Horodatage UTC compact `AAAAMMJJTHHMMSSZ` (nom de la copie de sécurité d'une restauration). */
export function backupStamp(clock: Clock): string {
  return new Date(clock.nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** `AAAAMMJJ` -> date civile `AAAA-MM-JJ`. */
export function dayToLocalDate(day: string): LocalDate {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` as LocalDate;
}

/**
 * Faut-il créer la sauvegarde du jour ? Oui tant qu'aucune sauvegarde quotidienne ne porte le jour local de l'horloge : à l'ouverture,
 * au retour de veille et à minuit passé, la première occasion en crée une (critère 1).
 */
export function isDailyBackupDue(versions: readonly BackupVersionInfo[], clock: Clock): boolean {
  const today = backupDay(clock);
  return !versions.some((version) => version.kind === 'daily' && version.stamp === today);
}

/** Plus récentes d'abord (heure réelle du fichier, puis nom). */
export function sortBackupVersions<T extends BackupVersionInfo>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.modifiedMs - a.modifiedMs || b.name.localeCompare(a.name));
}

export type BackupSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'last'; readonly modifiedMs: number; readonly day: 'today' | 'yesterday' | 'other'; readonly count: number };

/**
 * Résumé de la ligne de Réglages : dernière sauvegarde quotidienne (aujourd'hui, hier, ou une date) et nombre de versions quotidiennes.
 * Aucune sauvegarde quotidienne : « Aucune sauvegarde ».
 */
export function summarizeBackups(versions: readonly BackupVersionInfo[], clock: Clock): BackupSummary {
  const daily = sortBackupVersions(versions.filter((version) => version.kind === 'daily'));
  const [last] = daily;
  if (!last) return { kind: 'none' };
  const at = new Date(last.modifiedMs);
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(new Date(clock.nowMs())) - dayStart(at)) / 86_400_000);
  return { kind: 'last', modifiedMs: last.modifiedMs, day: days === 0 ? 'today' : days === 1 ? 'yesterday' : 'other', count: daily.length };
}
