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

/** Mesure brute : gzip de chaque bloc tel que le build l'a écrit. */
export function measureStart(files: BuildFiles, chunkFiles: readonly string[]): StartMeasure {
  const chunks = chunkFiles.map((file) => {
    const content = files.get(file);
    if (!content) throw new Error(`bloc ${file} absent du dossier de sortie`);
    return { file, gzip: gzipSync(content).length };
  });
  return { total: chunks.reduce((sum, item) => sum + item.gzip, 0), chunks };
}
