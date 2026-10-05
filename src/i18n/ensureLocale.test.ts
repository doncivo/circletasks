import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PERF-02, ADR 0003 (avenant) : le catalogue anglais est un bloc à la demande. Chaque test repart d'un module neuf
 * (`vi.resetModules()`), donc sans le catalogue que le fichier d'amorçage des tests pose d'emblée.
 */
describe('chargement à la demande des catalogues', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock('./en'));

  it('texte français tant que le chargement n’est pas fini, puis anglais, réellement différent', async () => {
    const i18n = await import('./index');
    const french = i18n.t('app.screenRetry');
    expect(french).toBe('Réessayer');
    i18n.setLocale('en');
    // Chargement lancé par setLocale, pas encore fini : repli français, getLocale() vaut déjà « en ».
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('app.screenRetry')).toBe(french);
    await i18n.ensureLocale('en');
    expect(i18n.t('app.screenRetry')).toBe('Retry');
    expect(i18n.t('app.screenRetry')).not.toBe(french);
  });

  it('un seul chargement en cours par langue ; le français ne charge rien', async () => {
    const i18n = await import('./index');
    const first = i18n.ensureLocale('en');
    const second = i18n.ensureLocale('en');
    expect(second).toBe(first);
    await first;
    await expect(i18n.ensureLocale('en')).resolves.toBeUndefined();
    await expect(i18n.ensureLocale('fr')).resolves.toBeUndefined();
  });

  it('un chargeur qui échoue : repli français, erreur journalisée, jamais de rejet, nouvel essai possible', async () => {
    vi.doMock('./en', () => {
      throw new Error('bloc illisible');
    });
    const i18n = await import('./index');
    const reporter = vi.fn();
    i18n.setCatalogFailureReporter(reporter);
    i18n.setLocale('en');
    await expect(i18n.ensureLocale('en')).resolves.toBeUndefined();
    expect(reporter).toHaveBeenCalledWith('en', expect.any(Error));
    expect(i18n.t('app.screenRetry')).toBe('Réessayer');
    // Le bloc redevient lisible : l'appel suivant recharge.
    vi.doUnmock('./en');
    await i18n.ensureLocale('en');
    expect(i18n.t('app.screenRetry')).toBe('Retry');
  });
});
