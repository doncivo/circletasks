import { getLocale } from './index';
import { syncCarryReportEn } from './en.syncCarryReport';
import { syncCarryReportFr } from './fr.syncCarryReport';

/**
 * Textes du compte rendu du changement d’époque (Y-TECH-05), à part du catalogue principal (bundle de départ) ; importé seulement par des
 * modules chargés à la demande. L’anglais est servi quand la langue courante est `en`.
 */
export type SyncCarryReportTextKey = keyof typeof syncCarryReportFr;

/**
 * Cause d'un échec d'enregistrement du compte rendu, lisible par famille (stockage plein, base refusée, autre), le code entre parenthèses
 * (revue S3). Le code reste celui du journal technique : jamais un libellé de l'erreur.
 */
export function carryFailureCause(code: string): string {
  const family = /FULL|IOERR/i.test(code) ? 'failedFull' : /^SQLITE_|^Db/i.test(code) ? 'failedRefused' : 'failedOther';
  return tCarry('failedCause', { family: tCarry(family), code });
}

export function tCarry(key: SyncCarryReportTextKey, params?: Readonly<Record<string, string | number>>): string {
  const text: string = (getLocale() === 'en' ? syncCarryReportEn : syncCarryReportFr)[key];
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name]))) : text;
}
