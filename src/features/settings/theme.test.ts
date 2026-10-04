import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, applyWindowTheme, parseThemeChoice, resolveTheme, systemTheme, THEME_STORAGE_KEY } from './theme';

// Environnement Node : un faux élément racine et un faux stockage suffisent.
function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
  } as unknown as HTMLElement & { attrs: Map<string, string> };
}

describe('thème (P-02)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('choix explicite : attribut data-theme et miroir local pour le premier affichage (critères 2 et 4)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { setItem: (k: string, v: string) => void store.set(k, v) } });
    const root = fakeRoot();
    applyTheme('dark', root);
    expect(root.attrs.get('data-theme')).toBe('dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
    applyTheme('light', root);
    expect(root.attrs.get('data-theme')).toBe('light');
  });

  it('« Système » retire l’attribut : les jetons suivent prefers-color-scheme (critère 3)', () => {
    vi.stubGlobal('window', { localStorage: { setItem: () => undefined } });
    const root = fakeRoot();
    applyTheme('dark', root);
    applyTheme('system', root);
    expect(root.attrs.has('data-theme')).toBe(false);
  });

  it('un stockage local indisponible ne casse pas le changement de thème', () => {
    vi.stubGlobal('window', {
      localStorage: {
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    const root = fakeRoot();
    expect(() => applyTheme('dark', root)).not.toThrow();
    expect(root.attrs.get('data-theme')).toBe('dark');
  });

  it('résout « système » selon la préférence du système', () => {
    expect(systemTheme({ matches: true })).toBe('dark');
    expect(systemTheme({ matches: false })).toBe('light');
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('une valeur inconnue (version future) vaut « système »', () => {
    expect(parseThemeChoice('sepia')).toBe('system');
    expect(parseThemeChoice(undefined)).toBe('system');
    expect(parseThemeChoice('dark')).toBe('dark');
  });

  it('barre de titre : transmet le thème, null pour « système », et ignore toute erreur (critère 6)', async () => {
    const calls: unknown[] = [];
    await applyWindowTheme('dark', { setTheme: (theme) => Promise.resolve(void calls.push(theme)) });
    await applyWindowTheme('system', { setTheme: (theme) => Promise.resolve(void calls.push(theme)) });
    expect(calls).toEqual(['dark', null]);
    await expect(applyWindowTheme('light', { setTheme: () => Promise.reject(new Error('refusé')) })).resolves.toBeUndefined();
    await expect(applyWindowTheme('light', null)).resolves.toBeUndefined();
  });
});
