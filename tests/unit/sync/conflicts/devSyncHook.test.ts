import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Y-04 critère 12 : la plateforme de synchro adossée au simulateur (`globalThis.__ctSync`) n'est installée qu'en développement. La seule
 * affectation de `__ctSync` dans `src/` est dans `src/platform/sync/index.ts`, à l'intérieur du bloc `if (import.meta.env.DEV) { … }`
 * (Vite retire ce bloc d'un build, et avec lui le client du simulateur).
 */

const ROOT = join(__dirname, '..', '..', '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Affectations de `__ctSync` (`x.__ctSync = …`, `__ctSync ??= …`), hors comparaisons. */
const ASSIGNMENT = /__ctSync\s*(\?\?|\|\||&&)?=(?!=)/g;

/** Position de l'accolade fermante qui répond à celle de `open`. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

describe('__ctSync en développement seulement (critère 12)', () => {
  it('une seule affectation dans src/, sous `if (import.meta.env.DEV)`', () => {
    const found: { file: string; index: number; text: string }[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(ASSIGNMENT)) found.push({ file: relative(ROOT, file).replaceAll('\\', '/'), index: match.index, text });
    }
    expect(found.map((f) => f.file)).toEqual(['platform/sync/index.ts']);
    const [only] = found;
    if (!only) return;
    const guard = only.text.lastIndexOf('if (import.meta.env.DEV) {', only.index);
    expect(guard).toBeGreaterThanOrEqual(0);
    const end = matchingBrace(only.text, only.text.indexOf('{', guard));
    expect(only.index).toBeLessThan(end);
  });
});
