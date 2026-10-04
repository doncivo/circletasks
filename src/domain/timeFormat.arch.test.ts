import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P-03 critère 7 : un seul formateur du domaine (`formatTime`, src/domain/timeFormat.ts) produit toute heure affichée. Le test échoue
 * s'il reste un `toLocaleTimeString`, un format d'heure Intl ou une heure brute rendue telle quelle dans un composant.
 */
function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesOf(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/testKit/.test(name) ? [path] : [];
  });
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Calcul de fuseau (T-11) : lit les composantes horaires d'un instant, n'affiche rien. */
const ALLOWED_INTL = new Set(['domain/timeFormat.ts', 'domain/timeZone.ts']);

describe('Formateur d’heure unique (P-03 critère 7)', () => {
  const files = sourcesOf(SRC).map((file) => ({ file, name: relative(SRC, file).split(sep).join('/') }));

  it('aucun toLocaleTimeString, hour12, hourCycle ni timeStyle (options Intl) hors du module de format', () => {
    expect(files.length).toBeGreaterThan(200);
    for (const { file, name } of files) {
      if (ALLOWED_INTL.has(name)) continue;
      expect(readFileSync(file, 'utf8'), name).not.toMatch(/toLocaleTimeString|hour12:|hourCycle:|timeStyle:|hour:\s*['"](?:2-digit|numeric)['"]/);
    }
  });

  it('aucune heure brute (.time, startTime, endTime) rendue telle quelle dans un composant', () => {
    for (const { file, name } of files.filter((f) => f.name.endsWith('.tsx'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        expect(line, `${name}:${String(index + 1)}`).not.toMatch(/\{\s*[\w.?]*(?:\.time|\.startTime|\.endTime|[tT]ime)\s*\}\s*<\//);
      });
    }
  });
});
