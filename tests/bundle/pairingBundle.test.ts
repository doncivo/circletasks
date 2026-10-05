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

describe('bundle de la fenêtre pairing (pairing.html)', () => {
  let outDir = '';
  const chunks = new Map<string, ChunkInfo>();

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'ct-pairing-'));
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
      await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', mode: 'production', build: { outDir, emptyOutDir: true, sourcemap: false }, plugins: [graph] });
    } finally {
      if (previous.debug === undefined) delete process.env['TAURI_ENV_DEBUG'];
      else process.env['TAURI_ENV_DEBUG'] = previous.debug;
      if (previous.node === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous.node;
    }
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
});
