import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = ([r, g, b]: [number, number, number]): number => {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const mixWhite = (hex: string, percent: number): string => {
  const mixed = rgb(hex).map((c) => Math.round(c + (255 - c) * (percent / 100)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

type Theme = Record<string, string>;
const PAIRS: readonly (readonly [string, string])[] = [
  ['--ct-color-text', '--ct-color-bg'],
  ['--ct-color-text', '--ct-color-surface-input'],
  ['--ct-color-text-secondary', '--ct-color-bg'],
  ['--ct-color-accent', '--ct-color-bg'],
  ['--ct-color-accent-on', '--ct-color-accent'],
  ['--ct-color-danger', '--ct-color-danger-bg'],
  ['--ct-color-achieved-text', '--ct-color-achieved-bg'],
  ['--ct-color-missed-text', '--ct-color-missed-bg'],
  ['--ct-color-event-text', '--ct-color-event-bg'],
  ['--ct-color-event-local-text', '--ct-color-event-local-bg'],
  ['--ct-color-today-badge', '--ct-color-bg'],
];
/** Éléments graphiques (icône d'objectif, maquettes) : 3:1 (WCAG 1.4.11). */
const GRAPHICS: readonly (readonly [string, string])[] = [['--ct-color-goal', '--ct-color-bg']];

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
