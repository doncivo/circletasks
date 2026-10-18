import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOCUS_TOKEN_PAIRS, GRAPHIC_TOKEN_PAIRS, TOKEN_PAIRS, contrast, parseHex } from '../../../tests/unit/theme/cssContrastKit';

/**
 * P-02 critère 5 : contraste AA (4,5:1 pour le texte) des paires de jetons, en clair et en sombre, pastilles d'espace comprises
 * (Pro #2F6B7A et Perso #B5483B éclaircies en sombre par `--ct-space-white`, ES-01).
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf-8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const body = css.slice(open + 1, close);
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
}

const root = block(':root {');
const light = { ...root, ...block(":root[data-theme='light']") };
const dark = { ...root, ...block(":root[data-theme='dark']") };

const rgb = (hex: string): [number, number, number] => {
  const c = parseHex(hex);
  return [c.r, c.g, c.b];
};
const mixWhite = (hex: string, percent: number): string => {
  const mixed = rgb(hex).map((c) => Math.round(c + (255 - c) * (percent / 100)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

type Theme = Record<string, string>;
/** Listes de paires dans `cssContrastKit.ts` (partagées avec l'inventaire de `contrastCss.test.ts`). */
const PAIRS = TOKEN_PAIRS;
const GRAPHICS = GRAPHIC_TOKEN_PAIRS;

describe.each([
  ['clair', light],
  ['sombre', dark],
] as const)('contraste AA, thème %s (P-02 critère 5)', (_name, theme: Theme) => {
  it.each(PAIRS)('%s sur %s ≥ 4,5:1', (fg, bg) => {
    expect(theme[fg], fg).toBeDefined();
    expect(theme[bg], bg).toBeDefined();
    expect(contrast(theme[fg] as string, theme[bg] as string), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GRAPHICS)('%s sur %s ≥ 3:1 (graphique)', (fg, bg) => {
    expect(contrast(theme[fg] as string, theme[bg] as string)).toBeGreaterThanOrEqual(3);
  });

  it('pastilles et textes d’espace Pro et Perso lisibles sur le fond', () => {
    const percent = Number.parseInt(theme['--ct-space-white'] ?? '0', 10);
    for (const base of ['#2f6b7a', '#b5483b']) {
      expect(contrast(mixWhite(base, percent), theme['--ct-color-bg'] as string), base).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/** Écran Focus (F-01 critère 13) : fond violet #2E2150 identique dans les deux thèmes, texte clair AA (4,5:1). */
describe.each([
  ['clair', light],
  ['sombre', dark],
] as const)('contraste AA de l’écran Focus, thème %s', (_name, theme: Theme) => {
  it.each(FOCUS_TOKEN_PAIRS)('%s sur %s ≥ 4,5:1', (fg, bg) => {
    expect(theme[fg], fg).toBeDefined();
    expect(contrast(theme[fg] as string, theme[bg] as string), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('les jetons de Focus ne changent pas avec le thème', () => {
    for (const token of ['--ct-focus-bg', '--ct-focus-arc', '--ct-focus-muted']) expect(theme[token]).toBe(light[token]);
  });
});

describe('thème sombre : cohérence', () => {
  it('le bloc prefers-color-scheme (Système) et data-theme="dark" (choix) portent les mêmes valeurs', () => {
    const media = block(":root:not([data-theme='light']) {");
    const normalize = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => k in block(":root[data-theme='dark']")));
    expect(normalize(media)).toEqual(block(":root[data-theme='dark']"));
  });

  it('chaque jeton redéfini en sombre l’est aussi en clair explicite (aucun repli sur le sombre)', () => {
    const lightKeys = Object.keys(block(":root[data-theme='light']"));
    const missing = Object.keys(block(":root[data-theme='dark']")).filter((k) => !lightKeys.includes(k) && root[k] === undefined);
    expect(missing).toEqual([]);
  });
});
