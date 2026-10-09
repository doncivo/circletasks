import { getLocale } from './index';
import { backupRestoreEn } from './en.backupRestore';
import { backupRestoreFr } from './fr.backupRestore';

/**
 * Textes de la feuille des sauvegardes et de « Reprendre la synchronisation » (P-04-iOS), à part du catalogue principal pour le bundle de
 * départ (PRD 8) ; même forme en anglais (`backupRestoreText.test.ts`).
 */
export type BackupRestoreTextKey = keyof typeof backupRestoreFr;

export function tBackupRestore(key: BackupRestoreTextKey): string {
  return (getLocale() === 'en' ? backupRestoreEn : backupRestoreFr)[key];
}
