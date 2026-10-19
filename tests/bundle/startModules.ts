import { dirname, relative, resolve } from 'node:path';

/**
 * Garde par liste blanche des modules du départ (BUNDLE-01, phase 3) : fonctions pures. Le build réel, la lecture des cartes de source et
 * la lecture ou l'écriture de `tests/bundle/start-modules.json` sont dans `startBundle.test.ts`.
 *
 * La liste est le mécanisme principal (tout module nouveau dans le départ est refusé, nommé, avec la consigne) ; le plafond en octets reste le
 * dernier juge. Elle ne s'étend que par un commit explicite : une entrée de `ajouts` avec l'ID de la story et une raison de 20 caractères.
 */
export const START_MODULES_FILE = 'tests/bundle/start-modules.json';
export const MIN_REASON_LENGTH = 20;
/** ID de story du backlog : `T-04`, `Y-FIX-02`, `BUNDLE-01`, `P-04-iOS`, `CAP-IOS-01`. */
export const STORY_ID = /^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-\d{2}(-[A-Za-z0-9]+)?$/;

export interface StartModulesGroup {
  readonly raison: string;
  readonly prefixes?: readonly string[];
  readonly fichiers?: readonly string[];
}

export interface StartModulesAddition {
  readonly fichier: string;
  readonly story: string;
  readonly raison: string;
}

export interface StartModulesList {
  readonly version: 1;
  readonly groupes: readonly StartModulesGroup[];
  readonly ajouts: readonly StartModulesAddition[];
}

export interface Comparison {
  readonly entered: readonly string[];
  readonly left: readonly string[];
  readonly unusedPrefixes: readonly string[];
}

const posix = (path: string): string => path.split('\\').join('/');

/** Chemin d'une source de carte : relatif à la racine du dépôt, POSIX ; `node_modules/` à partir de la première occurrence. */
export function normalizeSource(mapPath: string, source: string, root: string): string {
  const path = posix(relative(root, resolve(dirname(mapPath), source)));
  const index = path.indexOf('node_modules/');
  return index >= 0 ? path.slice(index) : path;
}

function listedFiles(list: StartModulesList): string[] {
  return [...list.groupes.flatMap((group) => group.fichiers ?? []), ...list.ajouts.map((addition) => addition.fichier)];
}

function listedPrefixes(list: StartModulesList): string[] {
  return list.groupes.flatMap((group) => group.prefixes ?? []);
}

export function compareStartModules(actual: ReadonlySet<string>, list: StartModulesList): Comparison {
  const files = new Set(listedFiles(list));
  const prefixes = listedPrefixes(list);
  const covered = (file: string): boolean => files.has(file) || prefixes.some((prefix) => file.startsWith(prefix));
  return {
    entered: [...actual].filter((file) => !covered(file)).sort(),
    left: [...files].filter((file) => !actual.has(file)).sort(),
    unusedPrefixes: prefixes.filter((prefix) => ![...actual].some((file) => file.startsWith(prefix))).sort(),
  };
}

const kilo = (bytes: number): string => `${(bytes / 1024).toFixed(1).replace('.', ',')} Ko`;

/** Messages en français, un par écart ; vide quand la liste est exacte. */
export function describeComparison(result: Comparison, sizeOf: (file: string) => number | null): string[] {
  return [
    ...result.entered.map((file) => {
      const size = sizeOf(file);
      return `Module entré dans le départ : ${file} (source ${size === null ? 'de taille inconnue' : kilo(size)}) : le rendre à la demande (\`lazyScreen\`, import par fichier, jamais par barrel), ou l’ajouter à \`ajouts\` de ${START_MODULES_FILE} avec l’ID de la story et la raison.`;
    }),
    ...result.left.map((file) => `Module sorti du départ : ${file} : retirer la ligne de ${START_MODULES_FILE}.`),
    ...result.unusedPrefixes.map((prefix) => `Module sorti du départ : ${prefix} (préfixe sans aucun module) : retirer la ligne de ${START_MODULES_FILE}.`),
  ];
}

/** Forme de la liste (critère 22) : raisons, tri, doublons, fichiers existants, ajouts avec ID de story et raison. */
export function validateList(list: StartModulesList, exists: (file: string) => boolean): string[] {
  const problems: string[] = [];
  list.groupes.forEach((group, index) => {
    const label = `groupe ${String(index + 1)}`;
    if (group.raison.trim() === '') problems.push(`${label} : raison vide`);
    const files = group.fichiers ?? [];
    for (let i = 1; i < files.length; i += 1) {
      const previous = files[i - 1] as string;
      const current = files[i] as string;
      if (previous > current) {
        problems.push(`${label} : fichiers non triés (${previous} avant ${current})`);
        break;
      }
    }
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file)) problems.push(`${label} : doublon ${file}`);
      seen.add(file);
    }
    for (const file of seen) if (!exists(file)) problems.push(`${file} : fichier absent du dépôt`);
  });
  for (const addition of list.ajouts) {
    if (!exists(addition.fichier)) problems.push(`${addition.fichier} : fichier absent du dépôt`);
    if (addition.story === '') problems.push(`ajout ${addition.fichier} : ID de story manquant`);
    else if (!STORY_ID.test(addition.story)) problems.push(`ajout ${addition.fichier} : ID de story invalide (« ${addition.story} »)`);
    if (addition.raison.trim().length < MIN_REASON_LENGTH) problems.push(`ajout ${addition.fichier} : raison de ${String(MIN_REASON_LENGTH)} caractères au moins obligatoire`);
  }
  return problems;
}

/**
 * Mise à jour contrôlée (`UPDATE_START_MODULES=1`, critère 24) : retire les modules sortis et les préfixes sans module, garde chaque raison,
 * range les modules entrés dans `ajouts` avec une story et une raison vides (la liste reste rouge jusqu'à leur saisie).
 */
export function updatedList(list: StartModulesList, actual: ReadonlySet<string>): StartModulesList {
  const comparison = compareStartModules(actual, list);
  const gone = new Set([...comparison.left, ...comparison.unusedPrefixes]);
  const groupes = list.groupes
    .map((group) => {
      const fichiers = (group.fichiers ?? []).filter((file) => !gone.has(file));
      const prefixes = (group.prefixes ?? []).filter((prefix) => !gone.has(prefix));
      return { raison: group.raison, ...(prefixes.length > 0 ? { prefixes } : {}), ...(fichiers.length > 0 ? { fichiers } : {}) };
    })
    .filter((group) => (group.fichiers?.length ?? 0) > 0 || (group.prefixes?.length ?? 0) > 0);
  const ajouts = [...list.ajouts.filter((addition) => !gone.has(addition.fichier)), ...comparison.entered.map((fichier) => ({ fichier, story: '', raison: '' }))];
  return { version: 1, groupes, ajouts };
}

/** Rangement de la liste initiale (générée une seule fois, après les paliers) : par raison, du départ vers les paquets tiers. */
const INITIAL_GROUPS: ReadonlyArray<{ readonly raison: string; readonly match: (file: string) => boolean }> = [
  { raison: 'coquille, démarrage et premier rendu d’Aujourd’hui (App, main, features/app, features/today)', match: (f) => /^src\/(App\.tsx|main\.tsx|features\/(app|today)\/)/.test(f) },
  { raison: 'composants de base et thème (src/ui)', match: (f) => f.startsWith('src/ui/') },
  { raison: 'textes français du départ (src/i18n ; les catalogues à part sont chargés avec leur écran)', match: (f) => f.startsWith('src/i18n/') },
  { raison: 'domaine : règles métier pures (src/domain)', match: (f) => f.startsWith('src/domain/') },
  { raison: 'base SQLite, migrations et dépôts (src/db ; migrations : palier 3, après la 1.0)', match: (f) => f.startsWith('src/db/') },
  { raison: 'plateforme (src/platform)', match: (f) => f.startsWith('src/platform/') },
  { raison: 'moteur de synchro (src/sync ; sortira au palier 4, après la 1.0)', match: (f) => f.startsWith('src/sync/') },
  { raison: 'features encore dans le départ : magasins d’état, raccourcis, sources d’Aujourd’hui, feuille d’ajout, éditeur d’événement, intégrations démarrées après le premier rendu', match: (f) => f.startsWith('src/features/') },
  { raison: 'autres fichiers du dépôt dans le départ', match: () => true },
];

export function initialList(actual: ReadonlySet<string>): StartModulesList {
  const files = [...actual].filter((file) => !file.startsWith('node_modules/')).sort();
  const packages = new Set(
    [...actual]
      .filter((file) => file.startsWith('node_modules/'))
      .map((file) => {
        const parts = file.split('/');
        return `${parts.slice(0, parts[1]?.startsWith('@') ? 3 : 2).join('/')}/`;
      }),
  );
  const remaining = new Set(files);
  const groupes: StartModulesGroup[] = [];
  for (const { raison, match } of INITIAL_GROUPS) {
    const fichiers = [...remaining].filter(match);
    if (fichiers.length === 0) continue;
    for (const file of fichiers) remaining.delete(file);
    groupes.push({ raison, fichiers });
  }
  if (packages.size > 0) groupes.push({ raison: 'paquets tiers du départ (react, react-dom, scheduler, zustand, lucide-react, @tauri-apps)', prefixes: [...packages].sort() });
  return { version: 1, groupes, ajouts: [] };
}
