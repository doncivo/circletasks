import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocale, setLocale, t, translate } from './index';

/** PERF-02 : le catalogue anglais est un bloc à la demande ; le français reste la langue de repli. */
describe('chargement à la demande des catalogues', () => {
  afterEach(() => setLocale('fr'));

  it('ensureLocale se résout pour le français (toujours livré) et pour l’anglais', async () => {
    await expect(ensureLocale('fr')).resolves.toBeUndefined();
    await expect(ensureLocale('en')).resolves.toBeUndefined();
  });

  it('une fois l’anglais chargé, setLocale("en") traduit ; le français reste la langue par défaut', async () => {
    await ensureLocale('en');
    const french = t('app.name');
    setLocale('en');
    expect(translate('en', 'app.loading')).not.toBe('');
    expect(t('app.name')).toBeTruthy();
    setLocale('fr');
    expect(t('app.name')).toBe(french);
  });
});
