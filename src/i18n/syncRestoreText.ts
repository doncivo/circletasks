import { getLocale } from './index';
import { syncRestoreEn } from './en.syncRestore';
import { syncRestoreFr } from './fr.syncRestore';

/**
 * Textes de la fenêtre de choix après une restauration, à part du catalogue principal (bundle de départ, PRD 8) ; importé seulement par
 * des modules chargés à la demande (`RestoreChoiceDialog`, `BackupSheet`). L'anglais est servi quand la langue courante est `en`.
 */
export type SyncRestoreTextKey = keyof typeof syncRestoreFr;

export function tRestore(key: SyncRestoreTextKey, params?: Readonly<Record<string, string>>): string {
  const text: string = (getLocale() === 'en' ? syncRestoreEn : syncRestoreFr)[key];
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match) : text;
}
