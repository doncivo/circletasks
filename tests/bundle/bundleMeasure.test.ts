import { describe, expect, it } from 'vitest';
import { HASHED_NAME, hashedNameTable, measureStart, pseudoHash, type BuildFiles } from './bundleMeasure';

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
    // La mesure brute, elle, bouge (c'est le bruit constaté sur UI-FIX-01) : le cas de test n'est pas vide.
    expect(measureStart(a.files, a.start).total).not.toBe(measureStart(b.files, b.start).total);
    const measureA = measureStart(a.files, a.start, { normalizeHashes: true });
    const measureB = measureStart(b.files, b.start, { normalizeHashes: true });
    expect(measureA.total, `mesure A ${String(measureA.total)} octets, mesure B ${String(measureB.total)} octets`).toBe(measureB.total);
    // Le détail garde les vrais noms de fichiers.
    expect(measureA.chunks.map((chunk) => chunk.file)).toEqual(a.start);
  });

  it('un vrai changement de code est toujours vu', () => {
    const a = syntheticBuild(1);
    const changed = new Map(a.files);
    const [main] = a.start;
    changed.set(main as string, Buffer.from(`${(a.files.get(main as string) as Buffer).toString('utf8')}export const added=1;\n`, 'utf8'));
    expect(measureStart(changed, a.start, { normalizeHashes: true }).total).toBeGreaterThan(measureStart(a.files, a.start, { normalizeHashes: true }).total);
  });

  it('pseudo-hachage : déterministe, même longueur, même alphabet que le hachage remplacé', () => {
    expect(pseudoHash('main.js', 0, 8, 'base64url')).toBe(pseudoHash('main.js', 0, 8, 'base64url'));
    expect(pseudoHash('main.js', 0, 8, 'base64url')).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(pseudoHash('main.js', 0, 8, 'hex')).toMatch(/^[0-9a-f]{8}$/);
    expect(pseudoHash('main.js', 0, 8, 'base64url')).not.toBe(pseudoHash('core.js', 0, 8, 'base64url'));
    const { files } = syntheticBuild(1);
    const table = hashedNameTable(files);
    for (const [real, pseudo] of table) {
      expect(pseudo.length).toBe(real.length);
      expect(pseudo).toMatch(HASHED_NAME);
      expect(pseudo.replace(HASHED_NAME, '$1$3')).toBe(real.replace(HASHED_NAME, '$1$3'));
    }
    expect(table.size).toBe(files.size - 1);
  });

  it('deux fichiers de même nom logique reçoivent deux pseudo-hachages différents, attribués par le contenu et non par le hachage', () => {
    const files = new Map<string, Buffer>([
      ['assets/index-AAAAAAAA.js', Buffer.from('export const a=1;', 'utf8')],
      ['assets/index-BBBBBBBB.js', Buffer.from('export const b=2;', 'utf8')],
    ]);
    const swapped = new Map<string, Buffer>([
      ['assets/index-BBBBBBBB.js', Buffer.from('export const a=1;', 'utf8')],
      ['assets/index-AAAAAAAA.js', Buffer.from('export const b=2;', 'utf8')],
    ]);
    const table = hashedNameTable(files);
    const tableSwapped = hashedNameTable(swapped);
    expect(table.get('index-AAAAAAAA.js')).not.toBe(table.get('index-BBBBBBBB.js'));
    expect(tableSwapped.get('index-BBBBBBBB.js')).toBe(table.get('index-AAAAAAAA.js'));
    expect(tableSwapped.get('index-AAAAAAAA.js')).toBe(table.get('index-BBBBBBBB.js'));
  });

  it('les fichiers sans hachage (index.html, theme-init.js, /ocr/) ne sont pas touchés', () => {
    const files = new Map<string, Buffer>([
      ['index.html', Buffer.from('<html></html>', 'utf8')],
      ['theme-init.js', Buffer.from('document.body;', 'utf8')],
      ['ocr/worker.min.js', Buffer.from('x', 'utf8')],
      ['assets/focus-end--pmzso8T.wav', Buffer.from([0, 1, 2])],
    ]);
    expect([...hashedNameTable(files).keys()]).toEqual(['focus-end--pmzso8T.wav']);
  });
});
