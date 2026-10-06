import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P-02 critère 5 : les écrans n'emploient que les jetons de couleur, donc suivent le thème. Une couleur hexadécimale en dur n'est
 * admise que dans une déclaration de jeton (`--nom: #…`, redéfinie en sombre), un repli de `var()` ou la liste ci-dessous
 * (surfaces blanches / encre fixes des composants, voir leur commentaire).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function cssOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssOf(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/**
 * Composants dont une couleur est fixe dans les deux thèmes (curseur blanc d'interrupteur, voile de feuille, mélange avec le blanc des pastilles
 * d'espace, fond blanc du QR d'appairage qui doit rester lisible par l'appareil photo et encre noire de la feuille imprimée de la clé).
 */
const FIXED_UI = new Set([
  'ui/EditControls.css',
  'ui/Sheet.css',
  'ui/Switch.css',
  'ui/SpaceSegmented.css',
  'ui/DropdownSelect.css',
  'features/tasks/TrashScreen.css',
  'features/sync/pairing-window/pairing.css',
]);

describe('aucune couleur en dur dans les écrans (P-02 critère 5)', () => {
  const files = cssOf(SRC).map((file) => ({ file, name: relative(SRC, file).split(sep).join('/') }));

  it('les feuilles de style ne déclarent des couleurs hexadécimales que sous forme de jetons', () => {
    expect(files.length).toBeGreaterThan(40);
    for (const { file, name } of files) {
      if (name === 'ui/theme/tokens.css' || FIXED_UI.has(name)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!HEX.test(line)) return;
          const code = line.trim();
          const isToken = /^--[\w-]+:/.test(code) || code.startsWith('/*') || code.startsWith('*');
          expect(isToken, `${name}:${String(index + 1)} : ${code}`).toBe(true);
        });
    }
  });

  it('chaque jeton défini en dur hors de tokens.css a sa variante sombre', () => {
    for (const { file, name } of files) {
      if (name === 'ui/theme/tokens.css') continue;
      const css = readFileSync(file, 'utf8');
      const tokens = [...css.matchAll(/^\s*(--[\w-]+):\s*#[0-9a-fA-F]{3,8}/gm)].map((m) => m[1] ?? '');
      if (tokens.length === 0) continue;
      expect(css, name).toMatch(/data-theme='dark'/);
      expect(css, name).toMatch(/prefers-color-scheme: dark/);
    }
  });
});
