import { isAppVersion } from '../domain/appUpdate';
import { logFailure } from './desktop/log';

/**
 * Version de l'app (I-06, ADR 0007 avenant I-06 point 1) : SEUL lecteur de la version, pour le PC et l'iPhone (synchro publiée, « À propos »,
 * diagnostic d'échec, en-tête de l'export des logs). Aucune commande Rust, aucune capability nouvelle (`getVersion` est couvert par
 * `core:default`).
 *
 * Ordre : `getVersion()` de `@tauri-apps/api/app` (valeur de `tauri.conf.json` compilée dans le binaire), puis la constante de build
 * `__CT_APP_VERSION__` (posée par `vite.config.ts` depuis `tauri.conf.json` : le navigateur de développement et l'e2e `iphone` affichent la
 * vraie version). Une valeur hors X.Y.Z ou égale à `0.0.0` est illisible ; les deux illisibles : `ok: false`, une ligne de journal
 * `app-version-unreadable` (code seul), jamais `0.0.0`.
 */
export type AppVersionRead =
  | { readonly ok: true; readonly version: string; readonly source: 'runtime' | 'build' }
  | { readonly ok: false; readonly version: null };

/** Valeur publiée par la synchro quand la version est illisible (dans le format, `appVersion` est obligatoire) ; affichée « version inconnue ». */
export const UNKNOWN_APP_VERSION = 'unknown';

export interface AppVersionDeps {
  readonly getVersion?: () => Promise<string>;
  readonly buildVersion?: string | undefined;
}

/** Constante de build (vite.config.ts) ; absente si le code tourne hors de Vite. */
function buildConstant(): string | undefined {
  return typeof __CT_APP_VERSION__ === 'string' ? __CT_APP_VERSION__ : undefined;
}

/** Version de build, lue sans attendre (valeur par défaut du conteneur) ; `ok: false` si elle est illisible. */
export function buildAppVersion(buildVersion: string | undefined = buildConstant()): AppVersionRead {
  return isAppVersion(buildVersion) ? { ok: true, version: buildVersion, source: 'build' } : { ok: false, version: null };
}

async function runtimeVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

let memo: Promise<AppVersionRead> | null = null;

async function read(deps: AppVersionDeps): Promise<AppVersionRead> {
  const fromRuntime = await (deps.getVersion ?? runtimeVersion)().catch(() => null);
  if (isAppVersion(fromRuntime)) return { ok: true, version: fromRuntime, source: 'runtime' };
  // `buildVersion: undefined` explicite = aucune constante de build (jamais la valeur par défaut de `buildAppVersion`).
  const candidate = 'buildVersion' in deps ? deps.buildVersion : buildConstant();
  if (isAppVersion(candidate)) return { ok: true, version: candidate, source: 'build' };
  logFailure('app', 'app-version-unreadable');
  return { ok: false, version: null };
}

/**
 * Lit la version (ne rejette jamais). Sans dépendances : mémorisée pour le processus. En développement, un e2e peut poser
 * `globalThis.__ctAppVersion` (chaîne, ou `null` pour simuler une version illisible) avant le chargement de la page.
 */
export function readAppVersion(deps?: AppVersionDeps): Promise<AppVersionRead> {
  if (deps) return read(deps);
  if (import.meta.env.DEV) {
    const holder = globalThis as { __ctAppVersion?: string | null };
    if ('__ctAppVersion' in holder) {
      const forced = holder.__ctAppVersion ?? null;
      return read({ getVersion: () => Promise.reject(new Error('e2e')), buildVersion: forced ?? undefined });
    }
  }
  memo ??= read({});
  return memo;
}

/** Tests : oublie la valeur mémorisée. */
export function resetAppVersionMemo(): void {
  memo = null;
}

/** Valeur publiée par la synchro : la version lue, sinon `unknown` (jamais `0.0.0`). */
export function publishedAppVersion(read: AppVersionRead): string {
  return read.ok ? read.version : UNKNOWN_APP_VERSION;
}
