import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { DEFAULT_LOCALE, getLocale, setLocale, t, translate, type MessageKey } from './index';

function keysOf(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keysOf(v as object, `${prefix}${k}.`),
  );
}

describe('i18n', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('le français est la langue par défaut', () => {
    expect(getLocale()).toBe('fr');
    expect(t('app.name')).toBe('CircleTasks');
    expect(t('app.loading')).toBe('Chargement…');
  });

  it('change de langue', () => {
    setLocale('en');
    expect(t('app.loading')).toBe('Loading…');
  });

  it('interpole les paramètres', () => {
    expect(t('app.version', { version: '0.1.0' })).toBe('Version 0.1.0');
    expect(translate('en', 'app.version', { version: 2 })).toBe('Version 2');
  });

  it('laisse visible un paramètre manquant et une clé inconnue', () => {
    const loose = translate as (locale: 'fr', key: string, params?: Record<string, string>) => string;
    expect(loose('fr', 'app.version', {})).toBe('Version {version}');
    expect(loose('fr', 'inconnu.cle')).toBe('inconnu.cle');
    expect(loose('fr', 'app')).toBe('app');
  });

  it('en.ts a exactement les mêmes clés que fr.ts', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(fr).sort());
  });

  it('les paramètres sont identiques dans chaque langue', () => {
    const params = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of keysOf(fr) as MessageKey[]) {
      const frText = translate('fr', key as 'app.name');
      const enText = translate('en', key as 'app.name');
      expect(params(enText), key).toEqual(params(frText));
    }
  });
});
