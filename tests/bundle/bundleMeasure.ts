import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Mesure du bundle de départ (BUNDLE-01, phase 1) : fonctions pures partagées par `startBundle.test.ts`, `bundleMeasure.test.ts` (arbres
 * synthétiques, sans build) et le script `measureStart.ts` (relevé à l'octet entre deux commits). Le build livré n'est pas touché : la
 * mesure travaille sur une copie en mémoire des fichiers produits.
 */

export interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

export type Manifest = Record<string, ManifestChunk>;

/** Fichiers d'un dossier de sortie : chemin POSIX relatif au dossier -> contenu. */
export type BuildFiles = ReadonlyMap<string, Buffer>;

export interface ChunkSize {
  readonly file: string;
  readonly gzip: number;
}

export interface StartMeasure {
  readonly total: number;
  readonly chunks: readonly ChunkSize[];
}

/** Blocs statiques atteints depuis l'entrée du manifeste, entrée comprise (graphe du manifeste, jamais les noms). */
export function startChunks(manifest: Manifest, entry = 'index.html'): ManifestChunk[] {
  if (manifest[entry]?.isEntry !== true) throw new Error(`entrée ${entry} absente du manifeste`);
  const seen = new Set<string>();
  const queue: string[] = [entry];
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

/** Lit tout le dossier de sortie en mémoire (chemins POSIX relatifs). */
export function readBuildFiles(outDir: string): BuildFiles {
  const files = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(outDir, path).split('\\').join('/'), readFileSync(path));
    }
  };
  walk(outDir);
  return files;
}

/** Nom de fichier haché par Vite : `<nom logique>-<hachage de 8 caractères>.<extension(s)>` (`main-CmzLGqC9.js`, `tokens-1-N9vs7B.css`, `x-abc.js.map`). */
export const HASHED_NAME = /^(.+?)-([A-Za-z0-9_-]{8})(\.[A-Za-z0-9.]+)$/;

export type HashAlphabet = 'hex' | 'base64url';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Premier caractère des hachages de Vite 8 / Rolldown : B, C ou D dans 79 % des cas (191 noms sur 243 du build du 2026-10-18), le reste uniforme. */
const FIRST_CHAR_SKEW = ['B', 'C', 'D'];

/**
 * Pseudo-hachage déterministe : empreinte SHA-256 du nom logique et du rang, rendue dans l'alphabet et à la longueur du hachage remplacé.
 * Même entropie apparente qu'un vrai hachage (une constante compresserait mieux et relèverait le plafond de fait ; un aléa uniforme
 * compresse moins bien que les vrais hachages, dont le premier caractère est très biaisé : +137 octets mesurés, d'où le modèle du premier
 * caractère) ; même entrée, même sortie, quel que soit le reste du build.
 */
export function pseudoHash(logicalName: string, rank: number, length: number, alphabet: HashAlphabet): string {
  const digest = createHash('sha256').update(`${logicalName}#${String(rank)}`).digest();
  if (alphabet === 'hex') return digest.toString('hex').slice(0, length);
  const rest = digest.toString('base64url').slice(1, length);
  const roll = digest[0] as number;
  const skewed = Math.floor(((roll / 256) * FIRST_CHAR_SKEW.length) / 0.79);
  const first = skewed < FIRST_CHAR_SKEW.length ? (FIRST_CHAR_SKEW[skewed] as string) : ([...BASE64URL].filter((c) => !FIRST_CHAR_SKEW.includes(c))[(digest[1] as number) % 61] as string);
  return first + rest;
}

interface HashedFile {
  readonly path: string;
  readonly base: string;
  readonly logicalBase: string;
  readonly hash: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expression qui reconnaît n'importe lequel des noms donnés, les plus longs d'abord (`x-h.js.map` avant `x-h.js`). */
function anyOf(names: readonly string[]): RegExp {
  return new RegExp([...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
}

/**
 * Table de remplacement des noms hachés : nom de fichier réel -> nom au pseudo-hachage. Les fichiers de même nom logique (deux blocs
 * `index-*.js`) sont départagés par leur contenu « logique » (noms hachés effacés), stable d'un build à l'autre tant que le code ne change
 * pas ; le rang trié entre dans le pseudo-hachage, si bien que deux fichiers ne partagent jamais le même nom.
 */
export function hashedNameTable(files: BuildFiles): ReadonlyMap<string, string> {
  const hashed: HashedFile[] = [];
  for (const path of files.keys()) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const match = HASHED_NAME.exec(base);
    if (match) hashed.push({ path, base, logicalBase: `${match[1] as string}${match[3] as string}`, hash: match[2] as string });
  }
  if (hashed.length === 0) return new Map();
  const alphabet: HashAlphabet = hashed.every((file) => /^[0-9a-f]+$/.test(file.hash)) ? 'hex' : 'base64url';
  const erase = anyOf(hashed.map((file) => file.base));
  const logicalBaseOf = new Map(hashed.map((file) => [file.base, file.logicalBase]));
  const logicalContent = (file: HashedFile): string => (files.get(file.path) as Buffer).toString('latin1').replace(erase, (name) => logicalBaseOf.get(name) as string);
  const byLogical = new Map<string, HashedFile[]>();
  for (const file of hashed) {
    const group = byLogical.get(file.logicalBase) ?? [];
    group.push(file);
    byLogical.set(file.logicalBase, group);
  }
  const table = new Map<string, string>();
  const taken = new Set<string>();
  for (const [logicalBase, group] of byLogical) {
    const ranked = group
      .map((file) => ({ file, content: logicalContent(file) }))
      .sort((a, b) => (a.content < b.content ? -1 : a.content > b.content ? 1 : a.file.hash < b.file.hash ? -1 : 1));
    ranked.forEach(({ file }, rank) => {
      const dot = logicalBase.indexOf('.');
      const pseudo = `${logicalBase.slice(0, dot)}-${pseudoHash(logicalBase, rank, file.hash.length, alphabet)}${logicalBase.slice(dot)}`;
      if (taken.has(pseudo)) throw new Error(`pseudo-hachage en double : ${pseudo}`);
      taken.add(pseudo);
      table.set(file.base, pseudo);
    });
  }
  return table;
}

export interface MeasureOptions {
  /** Remplace, dans le contenu mesuré, chaque nom haché par son nom au pseudo-hachage (critère 2). Faux : mesure brute. */
  readonly normalizeHashes?: boolean;
}

/** Mesure : gzip de chaque bloc, tel que le build l'a écrit (brute) ou après normalisation des noms hachés. Les noms rendus restent les vrais. */
export function measureStart(files: BuildFiles, chunkFiles: readonly string[], options: MeasureOptions = {}): StartMeasure {
  const table = options.normalizeHashes === true ? hashedNameTable(files) : null;
  const pattern = table && table.size > 0 ? anyOf([...table.keys()]) : null;
  const chunks = chunkFiles.map((file) => {
    const content = files.get(file);
    if (!content) throw new Error(`bloc ${file} absent du dossier de sortie`);
    const measured = pattern ? Buffer.from(content.toString('latin1').replace(pattern, (name) => (table as ReadonlyMap<string, string>).get(name) as string), 'latin1') : content;
    return { file, gzip: gzipSync(measured).length };
  });
  return { total: chunks.reduce((sum, item) => sum + item.gzip, 0), chunks };
}
