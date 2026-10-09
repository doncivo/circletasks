import { getLocale } from './index';
import { appUpdateRestoreEn } from './en.appUpdateRestore';
import { appUpdateRestoreFr } from './fr.appUpdateRestore';

/** Textes de « Restaurer la sauvegarde d'avant la mise à jour » (I-06), chargés avec l'action, jamais au démarrage. */
export type AppUpdateRestoreTextKey = keyof typeof appUpdateRestoreFr;

export function tUpdateRestore(key: AppUpdateRestoreTextKey, params: Readonly<Record<string, string>> = {}): string {
  const text = (getLocale() === 'en' ? appUpdateRestoreEn : appUpdateRestoreFr)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
