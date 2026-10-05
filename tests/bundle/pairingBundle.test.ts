import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Bundle minimal de la fenêtre de la clé (`pairing.html`, Y-06 critères 1, 2 et 17 ; ADR 0011 section 2.1, audits B4 et B6).
 *
 * Un vrai build de production (configuration de l'app, `vite.config.ts`) vers un dossier temporaire ; un greffon relève, pour chaque
 * bloc produit, **tous** les modules qu'il contient. Le graphe de `pairing.html` est parcouru en entier : bloc d'entrée, imports
 * statiques, imports dynamiques, blocs partagés avec les autres pages, et scripts et feuilles cités par la page elle-même. Chaque
 * module rencontré doit figurer dans la liste blanche ; un module hors liste fait échouer le test.
 *
 * Hors de `npm run test` : lancé par `npm run test:bundle` (configuration vitest.bundle.config.ts).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Modules autorisés dans le graphe de `pairing.html` (chemins relatifs au dépôt). */
const ALLOWED_FILES = new Set([
  // Page et fenêtre.
  'pairing.html',
  'src/features/sync/pairing-window/main.tsx',
  'src/features/sync/pairing-window/PairingView.tsx',
  'src/features/sync/pairing-window/RecoveryKeyEntry.tsx',
  'src/features/sync/pairing-window/pairingPlatform.ts',
  'src/features/sync/pairing-window/pairingText.ts',
  'src/features/sync/pairing-window/pairing.css',
  // Textes `sync.pairing` seulement (D6).
  'src/i18n/fr.syncPairing.ts',
  'src/i18n/en.syncPairing.ts',
  // Contrat de plateforme réduit : `tauriSync` (seule porte vers `invoke`), ses types, le format (codes d'erreur, bornes).
  'src/platform/sync/tauriSync.ts',
  'src/platform/sync/types.ts',
  'src/domain/sync/format.ts',
  'src/domain/sync/limits.ts',
  // Composants existants, sans dépendance : bouton, piège de focus, jetons du thème et polices embarquées (CSS seulement).
  'src/ui/Button.tsx',
  'src/ui/Button.css',
  'src/ui/useFocusTrap.ts',
  'src/ui/theme/tokens.css',
  'src/ui/theme/fonts.css',
  // Cœur d'`invoke` de Tauri, seul module de @tauri-apps/api, et son aide de compilation.
  'node_modules/@tauri-apps/api/core.js',
  'node_modules/@tauri-apps/api/external/tslib/tslib.es6.js',
]);

/** Paquets autorisés en entier : React et le dessinateur de QR. */
const ALLOWED_PACKAGES = ['node_modules/react/', 'node_modules/react-dom/', 'node_modules/scheduler/', 'node_modules/qrcode-generator/'];

/** Aides internes de Vite / Rolldown (préchargement, interopérabilité CommonJS de React). */
const ALLOWED_VIRTUAL = [/^vite\/(preload-helper|modulepreload-polyfill)/, /^rolldown\/runtime/, /commonjsHelpers/];

/** Jamais dans la fenêtre de la clé, quel que soit le chemin. */
const FORBIDDEN = [/zustand/, /src\/db\//, /repositor/i, /sqlite/i, /@tauri-apps\/plugin-/, /src\/platform\/sync\/memory\.ts/, /src\/sync\//, /src\/features\/app\//, /src\/i18n\/(index|fr|en)\.ts$/];

interface ChunkInfo {
  readonly fileName: string;
  readonly isEntry: boolean;
  readonly facade: string | null;
  readonly modules: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  /** Code rendu de chaque module du bloc (chemin normalisé -> source après compilation). */
  readonly sources: ReadonlyMap<string, string>;
}

/** Chemin de module normalisé : relatif au dépôt, barres obliques, sans requête ; module virtuel sans son préfixe `\0`. */
function normalize(id: string): string {
  const clean = id.replace(/^\0/, '').replace(/\?.*$/, '');
  if (!/^[a-zA-Z]:[\\/]|^\//.test(clean)) return clean;
  return relative(root, clean).replace(/\\/g, '/');
}

function allowed(module: string): boolean {
  if (ALLOWED_FILES.has(module)) return true;
  if (ALLOWED_PACKAGES.some((prefix) => module.startsWith(prefix))) return true;
  return ALLOWED_VIRTUAL.some((pattern) => pattern.test(module));
}

/** Build de production de l'app dans `outDir` ; relève le graphe des blocs (et leurs sources) dans `chunks`. `extra` : greffon de l'essai. */
async function buildProduction(outDir: string, chunks: Map<string, ChunkInfo>, extra: readonly Plugin[] = []): Promise<void> {
  const graph: Plugin = {
    name: 'ct-pairing-graph',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks.set(output.fileName, {
          fileName: output.fileName,
          isEntry: output.isEntry,
          facade: output.facadeModuleId ? normalize(output.facadeModuleId) : null,
          modules: output.moduleIds.map(normalize),
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          sources: new Map(Object.entries(output.modules).map(([id, info]) => [normalize(id), info.code ?? ''])),
        });
      }
    },
  };
  // Build de production : Vitest pose NODE_ENV=test, qui ferait de `import.meta.env.DEV` une vérité (branches de développement
  // gardées dans le bundle). On mesure ce que l'app installée charge.
  const previous = { debug: process.env['TAURI_ENV_DEBUG'], node: process.env['NODE_ENV'] };
  process.env['TAURI_ENV_DEBUG'] = '';
  process.env['NODE_ENV'] = 'production';
  try {
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', mode: 'production', build: { outDir, emptyOutDir: true, sourcemap: false }, plugins: [graph, ...extra] });
  } finally {
    if (previous.debug === undefined) delete process.env['TAURI_ENV_DEBUG'];
    else process.env['TAURI_ENV_DEBUG'] = previous.debug;
    if (previous.node === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous.node;
  }
}

/** Blocs atteints depuis une page : imports statiques et dynamiques, récursivement, plus les scripts cités par la page. */
function reachableFrom(outDir: string, chunks: ReadonlyMap<string, ChunkInfo>, page: string): ChunkInfo[] {
  const entry = [...chunks.values()].find((chunk) => chunk.isEntry && chunk.facade === page);
  if (!entry) throw new Error(`bloc d'entrée de ${page} absent`);
  const html = readFileSync(join(outDir, page), 'utf8');
  const cited = [...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((m) => m[1] as string).filter((file) => chunks.has(file));
  const queue = [entry.fileName, ...cited];
  const seen = new Set<string>();
  const result: ChunkInfo[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = chunks.get(file);
    if (!chunk) throw new Error(`bloc ${file} absent`);
    result.push(chunk);
    queue.push(...chunk.imports, ...chunk.dynamicImports);
  }
  return result;
}

/** Modules du graphe d'une page hors liste blanche, ou interdits : ce que le test du bundle doit trouver vide. */
function violations(modules: readonly string[]): string[] {
  return [...modules.filter((module) => !allowed(module)), ...modules.filter((module) => FORBIDDEN.some((pattern) => pattern.test(module)))];
}

describe('bundle de la fenêtre pairing (pairing.html)', () => {
  let outDir = '';
  const chunks = new Map<string, ChunkInfo>();

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'ct-pairing-'));
    await buildProduction(outDir, chunks);
  });

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  function entryOf(page: string): ChunkInfo {
    const entry = [...chunks.values()].find((chunk) => chunk.isEntry && chunk.facade === page);
    if (!entry) throw new Error(`bloc d'entrée de ${page} absent`);
    return entry;
  }

  /** Blocs atteints depuis une page : imports statiques et dynamiques, récursivement, plus les scripts cités par la page. */
  function reachable(page: string): ChunkInfo[] {
    const html = readFileSync(join(outDir, page), 'utf8');
    const cited = [...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((m) => m[1] as string).filter((file) => chunks.has(file));
    const queue = [entryOf(page).fileName, ...cited];
    const seen = new Set<string>();
    const result: ChunkInfo[] = [];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const chunk = chunks.get(file);
      if (!chunk) throw new Error(`bloc ${file} absent`);
      result.push(chunk);
      queue.push(...chunk.imports, ...chunk.dynamicImports);
    }
    return result;
  }

  const modulesOf = (page: string): string[] => [...new Set(reachable(page).flatMap((chunk) => chunk.modules))].sort();

  it('critère 1 : pairing.html est la troisième page du build, avec son marqueur', () => {
    const page = join(outDir, 'pairing.html');
    expect(existsSync(page)).toBe(true);
    expect(readFileSync(page, 'utf8')).toContain('data-ct-page="pairing"');
    for (const other of ['index.html', 'capture.html']) expect(readFileSync(join(outDir, other), 'utf8')).not.toContain('data-ct-page="pairing"');
  });

  it('critère 2 : tout le graphe de pairing.html est dans la liste blanche', () => {
    const modules = modulesOf('pairing.html');
    // eslint-disable-next-line no-console -- liste relevée à la main par la revue de sécurité
    console.info(`[pairing] ${String(modules.length)} modules :\n  ${modules.join('\n  ')}`);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((module) => !allowed(module))).toEqual([]);
    expect(modules.filter((module) => FORBIDDEN.some((pattern) => pattern.test(module)))).toEqual([]);
    expect(modules).toContain('src/features/sync/pairing-window/main.tsx');
    expect(modules.some((module) => module.startsWith('node_modules/qrcode-generator/'))).toBe(true);
  });

  it('critère 2 : la page ne charge que son bloc, ses blocs partagés et theme-init.js', () => {
    const html = readFileSync(join(outDir, 'pairing.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] as string);
    const files = new Set(reachable('pairing.html').map((chunk) => `/${chunk.fileName}`));
    expect(scripts.filter((src) => src !== '/theme-init.js' && !files.has(src))).toEqual([]);
    expect(scripts).toContain('/theme-init.js');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
    const theme = readFileSync(join(root, 'public', 'theme-init.js'), 'utf8');
    expect(theme).not.toMatch(/\bimport\b|fetch|XMLHttpRequest|__TAURI/);
  });

  it('critère 2 : qrcode-generator est absent du bundle principal et du bundle capture', () => {
    for (const page of ['index.html', 'capture.html']) {
      expect(modulesOf(page).filter((module) => module.includes('qrcode-generator'))).toEqual([]);
    }
  });

  it('critère 17 : la fenêtre pairing passe par tauriSync, sans la plateforme mémoire en production', () => {
    const modules = modulesOf('pairing.html');
    expect(modules).toContain('src/platform/sync/tauriSync.ts');
    expect(modules).not.toContain('src/platform/sync/memory.ts');
    expect(modules).not.toContain('src/platform/sync/index.ts');
  });

  it('critère 2 (QA) : le code de la fenêtre n’a accès ni au stockage, ni au réseau, ni aux messages, ni à la console', () => {
    const own = reachable('pairing.html').flatMap((chunk) => [...chunk.sources].filter(([module]) => module.startsWith('src/') || module === 'pairing.html'));
    expect(own.length).toBeGreaterThan(5);
    const banned = /\b(localStorage|sessionStorage|indexedDB|BroadcastChannel|sendBeacon|XMLHttpRequest|WebSocket|EventSource|postMessage|__ctSync|createMemorySyncPlatform)\b|document\.cookie|\bfetch\s*\(|console\.\w+|history\.(push|replace)State|location\.(hash|search|assign|replace)/;
    expect(own.filter(([, code]) => banned.test(code)).map(([module, code]) => `${module} : ${banned.exec(code)?.[0] ?? ''}`)).toEqual([]);
  });

  it('critère 2 (QA) : le test de liste blanche échoue bien quand un module hors liste entre dans le graphe (essai en négatif)', async () => {
    // Même build, avec un greffon qui fait importer Zustand par le point d'entrée de la fenêtre (le fichier source n'est pas touché).
    const mutated = mkdtempSync(join(tmpdir(), 'ct-pairing-neg-'));
    const mutatedChunks = new Map<string, ChunkInfo>();
    const inject: Plugin = {
      name: 'ct-inject-store',
      enforce: 'pre',
      transform(code, id) {
        return normalize(id) === 'src/features/sync/pairing-window/main.tsx' ? { code: `import { createStore as ctNegStore } from 'zustand/vanilla';
globalThis.ctNeg = ctNegStore;
${code}`, map: null } : null;
      },
    };
    try {
      await buildProduction(mutated, mutatedChunks, [inject]);
      const modules = [...new Set(reachableFrom(mutated, mutatedChunks, 'pairing.html').flatMap((chunk) => chunk.modules))];
      expect(violations(modules).some((module) => module.includes('zustand'))).toBe(true);
      // Et la vérification sur le vrai build reste vide.
      expect(violations(modulesOf('pairing.html'))).toEqual([]);
    } finally {
      rmSync(mutated, { recursive: true, force: true });
    }
  });
});
