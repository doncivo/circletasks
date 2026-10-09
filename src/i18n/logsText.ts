import { getLocale } from './index';
import { logsEn } from './en.logs';
import { logsFr } from './fr.logs';

/**
 * Textes de l'écran Logs et de l'export du journal (I-04) : catalogue à part, chargé avec les écrans de Réglages (jamais dans le bundle de
 * départ, PRD 8 : 350 Ko). Même règles que le catalogue principal (ADR 0003) : français de référence, anglais de même forme
 * (`logsText.test.ts`), paramètres entre accolades.
 */
export type LogsTextKey = keyof typeof logsFr;

export function tLogs(key: LogsTextKey, params?: Readonly<Record<string, string | number>>): string {
  const table: Readonly<Record<LogsTextKey, string>> = getLocale() === 'en' ? logsEn : logsFr;
  const text = table[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
