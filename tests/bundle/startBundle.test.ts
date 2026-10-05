import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Taille du bundle de départ (PRD 8, démarrage rapide) : `npm run build` vers un dossier temporaire avec le manifeste de Vite, puis somme
 * gzip du JavaScript chargé AVANT toute interaction, c'est-à-dire le bloc d'entrée de `index.html` et tous ses imports STATIQUES,
 * récursivement. Les blocs sont repérés par le graphe du manifeste, jamais par leur nom (Rollup nomme automatiquement les blocs partagés,
 * par exemple « tokens », et ces noms peuvent changer). Les imports dynamiques (Recharts du rapport, tesseract.js, etc.) et les
 * ressources copiées telles quelles (/ocr/) n'en font pas partie. Seuil : 350 Ko gzip.
 *
 * Hors de `npm run test` : lancé par `npm run test:bundle` (configuration vitest.bundle.config.ts).
 */
const LIMIT_BYTES = 350 * 1024;

interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

describe('bundle de départ (index.html)', () => {
  let outDir = '';
  let manifest: Record<string, ManifestChunk> = {};

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'ct-bundle-'));
    const build = spawnSync('npm', ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir', '--manifest'], { encoding: 'utf8', shell: true, env: { ...process.env, TAURI_ENV_DEBUG: '' } });
    if (build.status !== 0) throw new Error(`npm run build a échoué (code ${String(build.status)}) :\n${build.stdout}\n${build.stderr}`);
    manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
  });

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  /** Blocs statiques atteints depuis l'entrée de `index.html`, entrée comprise. */
  function startChunks(): ManifestChunk[] {
    if (manifest['index.html']?.isEntry !== true) throw new Error('entrée index.html absente du manifeste');
    const seen = new Set<string>();
    const queue: string[] = ['index.html'];
    const result: ManifestChunk[] = [];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = manifest[key];
      if (!chunk) throw new Error(`bloc ${key} absent du manifeste`);
      result.push(chunk);
      queue.push(...(chunk.imports ?? []));
    }
    return result;
  }

  it('le JavaScript de départ pèse moins de 350 Ko en gzip, bloc par bloc affiché', () => {
    const chunks = startChunks().filter((chunk) => chunk.file.endsWith('.js'));
    const sizes = chunks.map((chunk) => ({ file: chunk.file, gzip: gzipSync(readFileSync(join(outDir, chunk.file))).length }));
    const total = sizes.reduce((sum, item) => sum + item.gzip, 0);
    const detail = sizes
      .sort((a, b) => b.gzip - a.gzip)
      .map((item) => `  ${(item.gzip / 1024).toFixed(1).padStart(7)} Ko  ${item.file}`)
      .join('\n');
    // eslint-disable-next-line no-console -- détail relevé à la main : taille gzip de chaque bloc du bundle de départ
    console.info(`[bundle] ${String(sizes.length)} blocs de départ, total ${(total / 1024).toFixed(1)} Ko gzip (seuil ${String(LIMIT_BYTES / 1024)} Ko)\n${detail}`);
    expect(sizes.length).toBeGreaterThan(0);
    expect(total).toBeLessThan(LIMIT_BYTES);
  });

  it('le graphique du rapport (Recharts) est un bloc à la demande, hors du départ', () => {
    const start = new Set(startChunks().map((chunk) => chunk.file));
    const chart = manifest['src/features/stats/CompletionChart.tsx'];
    if (!chart) throw new Error('bloc CompletionChart absent du manifeste');
    expect(start.has(chart.file)).toBe(false);
    expect(Object.values(manifest).some((chunk) => chunk.dynamicImports?.includes('src/features/stats/CompletionChart.tsx'))).toBe(true);
  });
});
