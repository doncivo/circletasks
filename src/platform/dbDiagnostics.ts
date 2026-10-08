import { describeError } from '../db/errorText';
import { detectOs, detectRuntime, type Runtime } from './runtime';

/** URL de la base de l'app installée (tauri-plugin-sql), recopiée ici pour ne pas charger le driver Tauri dans le diagnostic. */
export const DB_URL = 'sqlite:circletasks.db';

/** Réponse de la commande Rust `db_diagnostics` (src-tauri/src/backup.rs). */
export interface DbPathDiagnostics {
  readonly configDir: string | null;
  readonly configDirError: string | null;
  readonly dirExists: boolean;
  readonly dbPath: string | null;
  readonly fileExists: boolean;
  readonly fileBytes: number | null;
  readonly walExists: boolean;
}

/** Environnement et chemins résolus, joints au diagnostic d'échec de démarrage (0.2.1). */
export interface DbEnvironment {
  readonly runtime: Runtime;
  readonly os: string;
  /** Plateforme du build Tauri (constante Vite) ; absente hors build Tauri. */
  readonly buildPlatform: string | null;
  readonly appVersion: string | null;
  readonly paths: DbPathDiagnostics | null;
  /** Échec de la commande `db_diagnostics` (texte exact), null si elle a répondu ou n'a pas été appelée. */
  readonly pathsError: string | null;
}

/**
 * Lit l'environnement pour le diagnostic. Hors app installée (navigateur de dev, Vitest) : aucune commande appelée. Ne rejette jamais :
 * un échec est rendu dans `pathsError`.
 */
export async function readDbEnvironment(runtime: Runtime = detectRuntime()): Promise<DbEnvironment> {
  const base = { runtime, os: detectOs(), buildPlatform: import.meta.env.TAURI_ENV_PLATFORM ?? null };
  if (runtime !== 'tauri') return { ...base, appVersion: null, paths: null, pathsError: null };
  const appVersion = await import('@tauri-apps/api/app').then((app) => app.getVersion()).catch(() => null);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return { ...base, appVersion, paths: await invoke<DbPathDiagnostics>('db_diagnostics'), pathsError: null };
  } catch (error) {
    return { ...base, appVersion, paths: null, pathsError: describeError(error) };
  }
}
