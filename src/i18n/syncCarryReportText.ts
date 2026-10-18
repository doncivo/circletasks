import { getLocale } from './index';
import { syncCarryReportEn } from './en.syncCarryReport';
import { syncCarryReportFr } from './fr.syncCarryReport';

/**
 * Textes du compte rendu du changement d’époque (Y-TECH-05), à part du catalogue principal (bundle de départ) ; importé seulement par des
 * modules chargés à la demande. L’anglais est servi quand la langue courante est `en`.
 */
export type SyncCarryReportTextKey = keyof typeof syncCarryReportFr;

export function tCarry(key: SyncCarryReportTextKey, params?: Readonly<Record<string, string | number>>): string {
  const text: string = (getLocale() === 'en' ? syncCarryReportEn : syncCarryReportFr)[key];
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name]))) : text;
}
