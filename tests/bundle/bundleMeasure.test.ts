import { describe, expect, it } from 'vitest';
import { measureStart, type BuildFiles } from './bundleMeasure';

/**
 * BUNDLE-01, phase 1 (critères 1 et 2) : la mesure du départ ne doit pas bouger quand seuls les noms hachés des blocs changent (retouche
 * d'une feuille CSS : environ 85 blocs renommés, leurs renvois dans les tables de préchargement, les imports et les pieds
 * `sourceMappingURL` réécrits, aucune ligne de JavaScript changée). Arbres de fichiers synthétiques, en mémoire, sans build.
 */

const HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CHUNKS = 40;

/** Générateur déterministe (mulberry32) : deux graines, deux jeux de hachages, un seul « code ». */
function hashesFrom(seed: number): () => string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  return () => Array.from({ length: 8 }, () => HASH_ALPHABET[Math.floor(next() * HASH_ALPHABET.length)]).join('');
}

/** Dossier de sortie synthétique : un bloc d'entrée qui renvoie à `CHUNKS` blocs à la demande (JS et CSS), chacun avec sa carte. */
function syntheticBuild(seed: number): { files: BuildFiles; start: string[] } {
  const hash = hashesFrom(seed);
  const files = new Map<string, Buffer>();
  const text = (path: string, content: string): void => void files.set(path, Buffer.from(content, 'utf8'));
  const mainJs = `main-${hash()}.js`;
  const coreJs = `core-${hash()}.js`;
  const preload: string[] = [];
  for (let index = 0; index < CHUNKS; index += 1) {
    const js = `Screen${String(index)}-${hash()}.js`;
    const css = `Screen${String(index)}-${hash()}.css`;
    preload.push(`"assets/${js}","assets/${css}"`);
    text(`assets/${js}`, `import{a as e}from"./${coreJs}";export function S${String(index)}(){return e(${String(index)})}\n//# sourceMappingURL=${js}.map\n`);
    text(`assets/${js}.map`, `{"version":3,"file":"${js}","sources":["../../src/features/x/Screen${String(index)}.tsx"]}`);
    text(`assets/${css}`, `.ct-screen-${String(index)}{display:grid}`);
  }
  text(`assets/${coreJs}`, `export function a(n){return n*2}\n//# sourceMappingURL=${coreJs}.map\n`);
  text(
    `assets/${mainJs}`,
    `import{a as e}from"./${coreJs}";const t=[${preload.join(',')}];export function m(){return e(t.length)}\n//# sourceMappingURL=${mainJs}.map\n`,
  );
  text('index.html', `<script type="module" src="/assets/${mainJs}"></script>`);
  return { files, start: [`assets/${mainJs}`, `assets/${coreJs}`] };
}

describe('mesure du bundle de départ : insensible aux noms hachés', () => {
  it('même JavaScript, hachages différents (retouche CSS) : même mesure à l’octet', () => {
    const a = syntheticBuild(1);
    const b = syntheticBuild(2);
    const measureA = measureStart(a.files, a.start);
    const measureB = measureStart(b.files, b.start);
    expect(measureA.total, `mesure A ${String(measureA.total)} octets, mesure B ${String(measureB.total)} octets`).toBe(measureB.total);
  });
});
