import { afterEach, describe, expect, it } from 'vitest';
import { logsEn } from './en.logs';
import { logsFr } from './fr.logs';
import { DEFAULT_LOCALE, setLocale } from './index';
import { tLogs, type LogsTextKey } from './logsText';

/** Catalogue de l'écran Logs (I-04), à part du catalogue principal pour le bundle de départ : mêmes clés et mêmes paramètres en anglais. */
describe('textes de l’écran Logs', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('en.logs.ts a exactement les clés de fr.logs.ts, avec les mêmes paramètres', () => {
    expect(Object.keys(logsEn).sort()).toEqual(Object.keys(logsFr).sort());
    const params = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(logsFr) as LogsTextKey[]) expect(params(logsEn[key]), key).toEqual(params(logsFr[key]));
  });

  it('suit la langue courante et interpole', () => {
    expect(tLogs('errorCode', { code: 'io' })).toBe('Code : io');
    setLocale('en');
    expect(tLogs('errorCode', { code: 'io' })).toBe('Code: io');
    expect(tLogs('repeated', {})).toBe('×{count}');
  });
});
