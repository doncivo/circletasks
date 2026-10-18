import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareStartModules, describeComparison, normalizeSource, updatedList, validateList, type StartModulesList } from './startModules';

/**
 * BUNDLE-01, phase 3 (critères 19, 20, 22, 24) : garde par liste blanche des modules du départ, fonctions pures sur des listes synthétiques.
 * La lecture des cartes de source et le build réel sont dans `startBundle.test.ts`.
 */
const LIST: StartModulesList = {
  version: 1,
  groupes: [
    { raison: 'coquille et premier rendu d’Aujourd’hui', fichiers: ['src/App.tsx', 'src/features/today/TodayScreen.tsx', 'src/main.tsx'] },
    { raison: 'paquets tiers', prefixes: ['node_modules/react-dom/', 'node_modules/react/'] },
  ],
  ajouts: [{ fichier: 'src/features/app/AppStatusBanner.tsx', story: 'A-09', raison: 'bandeau « Hors ligne » visible dès le premier rendu' }],
};

const START = new Set(['src/App.tsx', 'src/features/today/TodayScreen.tsx', 'src/main.tsx', 'src/features/app/AppStatusBanner.tsx', 'node_modules/react/index.js', 'node_modules/react-dom/client.js']);

describe('garde par liste blanche des modules du départ', () => {
  it('liste conforme : rien à signaler', () => {
    const result = compareStartModules(START, LIST);
    expect(result).toEqual({ entered: [], left: [], unusedPrefixes: [] });
    expect(describeComparison(result, () => null)).toEqual([]);
  });

  it('module entré : nommé, avec la taille de sa source et la consigne', () => {
    const actual = new Set([...START, 'src/features/x/Y.tsx']);
    const result = compareStartModules(actual, LIST);
    expect(result.entered).toEqual(['src/features/x/Y.tsx']);
    expect(describeComparison(result, (file) => (file === 'src/features/x/Y.tsx' ? 6_246 : null))).toEqual([
      'Module entré dans le départ : src/features/x/Y.tsx (source 6,1 Ko) : le rendre à la demande (`lazyScreen`, import par fichier, jamais par barrel), ou l’ajouter à `ajouts` de tests/bundle/start-modules.json avec l’ID de la story et la raison.',
    ]);
  });

  it('module sorti : nommé, avec la consigne de retirer la ligne (la liste reste exacte)', () => {
    const actual = new Set([...START].filter((file) => file !== 'src/main.tsx'));
    const result = compareStartModules(actual, LIST);
    expect(result.left).toEqual(['src/main.tsx']);
    expect(describeComparison(result, () => null)).toEqual(['Module sorti du départ : src/main.tsx : retirer la ligne de tests/bundle/start-modules.json.']);
  });

  it('paquet tiers : couvert par son préfixe ; un préfixe sans module est signalé comme sorti', () => {
    const actual = new Set([...START, 'node_modules/react-dom/cjs/react-dom.production.js']);
    expect(compareStartModules(actual, LIST).entered).toEqual([]);
    const withoutReact = new Set([...START].filter((file) => !file.startsWith('node_modules/react/')));
    const result = compareStartModules(withoutReact, LIST);
    expect(result.unusedPrefixes).toEqual(['node_modules/react/']);
    expect(describeComparison(result, () => null)).toEqual(['Module sorti du départ : node_modules/react/ (préfixe sans aucun module) : retirer la ligne de tests/bundle/start-modules.json.']);
  });

  it('chemins normalisés : relatifs à la racine, POSIX, node_modules à partir de la première occurrence', () => {
    const root = resolve('/', 'depot');
    const map = resolve('/', 'tmp', 'out', 'assets', 'main-abc.js.map');
    expect(normalizeSource(map, '../../../../depot/src/App.tsx', root)).toBe('src/App.tsx');
    expect(normalizeSource(map, '../../../../depot/node_modules/react/index.js', root)).toBe('node_modules/react/index.js');
    expect(normalizeSource(join(root, 'dist', 'assets', 'x.js.map'), join('..', '..', 'src', 'a', 'b.ts'), root)).toBe('src/a/b.ts');
  });

  it('forme de la liste : raisons, tri, doublons, fichiers existants, ajouts avec story et raison de 20 caractères', () => {
    const exists = (file: string): boolean => file !== 'src/absent.ts';
    expect(validateList(LIST, exists)).toEqual([]);
    const broken: StartModulesList = {
      version: 1,
      groupes: [
        { raison: '', fichiers: ['src/main.tsx', 'src/App.tsx', 'src/App.tsx'] },
        { raison: 'absent', fichiers: ['src/absent.ts'] },
      ],
      ajouts: [
        { fichier: 'src/x.ts', story: '', raison: '' },
        { fichier: 'src/y.ts', story: 'pas-un-id', raison: 'trop court' },
      ],
    };
    expect(validateList(broken, exists)).toEqual([
      'groupe 1 : raison vide',
      'groupe 1 : fichiers non triés (src/main.tsx avant src/App.tsx)',
      'groupe 1 : doublon src/App.tsx',
      'src/absent.ts : fichier absent du dépôt',
      'ajout src/x.ts : ID de story manquant',
      'ajout src/x.ts : raison de 20 caractères au moins obligatoire',
      'ajout src/y.ts : ID de story invalide (« pas-un-id »)',
      'ajout src/y.ts : raison de 20 caractères au moins obligatoire',
    ]);
  });

  it('mise à jour contrôlée : retire les modules sortis, garde les raisons, range les entrés dans ajouts avec une raison vide', () => {
    const actual = new Set([...START].filter((file) => file !== 'src/main.tsx').concat('src/features/x/Y.tsx'));
    const next = updatedList(LIST, actual);
    expect(next.groupes[0]).toEqual({ raison: 'coquille et premier rendu d’Aujourd’hui', fichiers: ['src/App.tsx', 'src/features/today/TodayScreen.tsx'] });
    expect(next.groupes[1]).toEqual(LIST.groupes[1]);
    expect(next.ajouts).toEqual([...LIST.ajouts, { fichier: 'src/features/x/Y.tsx', story: '', raison: '' }]);
    // La liste réécrite reste rouge tant que l'ID et la raison manquent (critère 24).
    expect(validateList(next, () => true)).toEqual(['ajout src/features/x/Y.tsx : ID de story manquant', 'ajout src/features/x/Y.tsx : raison de 20 caractères au moins obligatoire']);
  });
});
