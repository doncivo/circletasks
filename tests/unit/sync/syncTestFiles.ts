import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Y-TECH-02 (consigne d'Ali ; revue, suggestion 11) : fichiers de test de la synchro couverts par les garde-fous `forgetHygiene` et
 * `resetHygiene` (aucune attente par sondage, aucun délai ni horloge réels, aucun nouvel essai, aucun test désactivé) :
 * `tests/unit/sync/**` et `src/features/sync/**`, en chemins relatifs à la racine. Les garde-fous eux-mêmes, qui citent les motifs
 * interdits, sont exclus.
 */
const root = join(__dirname, '../../..');

function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) out.push(...testFilesUnder(path));
    else if (/\.test\.tsx?$/.test(name) && !name.endsWith('Hygiene.test.ts')) out.push(path);
  }
  return out.sort();
}

export const SYNC_TEST_FILES: readonly string[] = [...testFilesUnder('tests/unit/sync'), ...testFilesUnder('src/features/sync')];
