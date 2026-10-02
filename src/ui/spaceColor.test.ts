import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spaceTextColor } from './spaceColor';

describe('spaceTextColor (thème sombre AA)', () => {
  it('mélange la couleur de l’espace avec du blanc selon --ct-space-white', () => {
    expect(spaceTextColor('#2f6b7a')).toBe('color-mix(in srgb, #2f6b7a, #ffffff var(--ct-space-white, 0%))');
  });

  it('les jetons sombres éclaircissent les espaces et le badge AUJOURD’HUI, le clair n’y touche pas', () => {
    const css = readFileSync(join(__dirname, 'theme/tokens.css'), 'utf-8');
    expect(css.match(/--ct-space-white: 0%;/g)).toHaveLength(2);
    expect(css.match(/--ct-space-white: 55%;/g)).toHaveLength(2);
    expect(css.match(/--ct-color-today-badge: #8fc4ea;/g)).toHaveLength(2);
  });

  it('contraste AA (≥ 4,5) sur le fond sombre pour Pro, Perso et le badge', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const mix = (hex: string, white: number): string =>
      '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - white) + 255 * white).toString(16).padStart(2, '0')).join('');
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bg = '#1c1630';
    for (const color of ['#2f6b7a', '#b5483b', '#8fc4ea']) {
      const shown = color === '#8fc4ea' ? color : mix(color, 0.55);
      expect(ratio(shown, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
