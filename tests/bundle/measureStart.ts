import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureStart, readBuildFiles, startChunks, type Manifest } from './bundleMeasure.ts';

/**
 * Relevé à l'octet du bundle de départ (BUNDLE-01, critères 6, 7, 11, 12) : même calcul que `startBundle.test.ts`, sur un dossier de
 * sortie déjà construit (`vite build --outDir <dossier> --manifest`, NODE_ENV=production, TAURI_ENV_DEBUG et VITE_CT_E2E_HOOKS vides).
 * Usage : `node tests/bundle/measureStart.ts <dossier>` : mesure brute, mesure normalisée, écart, blocs, marge.
 */
const LIMIT_BYTES = 350 * 1024;
const outDir = process.argv[2];
if (!outDir) throw new Error('usage : node tests/bundle/measureStart.ts <dossier de sortie>');
const manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Manifest;
const files = readBuildFiles(outDir);
const chunks = startChunks(manifest)
  .map((chunk) => chunk.file)
  .filter((file) => file.endsWith('.js'));
const raw = measureStart(files, chunks);
const normalized = measureStart(files, chunks, { normalizeHashes: true });
process.stdout.write(
  [
    `blocs de départ : ${String(chunks.length)}`,
    `mesure brute : ${String(raw.total)}`,
    `mesure normalisée : ${String(normalized.total)}`,
    `écart normalisée - brute : ${String(normalized.total - raw.total)}`,
    `marge (plafond ${String(LIMIT_BYTES)}) : ${String(LIMIT_BYTES - normalized.total)}`,
    '',
  ].join('\n'),
);
