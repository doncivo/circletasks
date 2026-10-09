import Database from '@tauri-apps/plugin-sql';
import type { SqlDriver, SqlRow } from '../../db/driver';
import { DbStepError, JournalModeError } from '../../db/errorText';
import { createSerializedDriver, type SerializedDriverOptions } from '../../db/serializedDriver';
import { detectOs } from '../runtime';

/**
 * Récupération d'une restauration interrompue impossible au démarrage de l'iPhone (P-04-iOS, ADR 0009 avenant lot F B3) : aucune base n'est
 * ouverte ni créée ; l'écran d'erreur persistant affiche le code (« Restauration interrompue : fermez puis rouvrez CircleTasks »).
 */
export class StartupRecoveryError extends Error {
  override readonly name = 'StartupRecoveryError';
  constructor(readonly code: string) {
    super(`startup-recovery: ${code}`);
  }
}

/** Porte de démarrage sans réponse (statut illisible, `setup` trop long) : passager, « Réessayer » (rechargement) peut réussir. */
export class StartupGateTimeoutError extends Error {
  override readonly name = 'StartupGateTimeoutError';
  constructor(readonly code: 'status-unavailable' | 'startup-timeout') {
    super(`startup-gate: ${code}`);
  }
}

/** Issue de la porte de démarrage (commande Rust `backup_startup_status`). */
export type StartupStatus = { readonly state: 'ready' | 'pending' } | { readonly state: 'failed'; readonly code: string };

export interface StartupGateOptions {
  readonly status?: () => Promise<StartupStatus>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly intervalMs?: number;
  /** Attente maximale de la fin du `setup` de Rust (au-delà : `startup-timeout`, le chien de garde de l'ouverture prend le relais). */
  readonly timeoutMs?: number;
}

/**
 * iPhone : attend que Rust ait récupéré une restauration interrompue et enregistré le plugin SQL AVANT `Database.load` (la WebView existe
 * avant le `setup` sur iOS). `failed` : `StartupRecoveryError` ; statut illisible ou délai dépassé : `StartupGateTimeoutError` ; jamais une
 * base vide créée.
 */
export async function awaitStartupGate(options: StartupGateOptions = {}): Promise<void> {
  const status = options.status ?? (async () => (await import('@tauri-apps/api/core')).invoke<StartupStatus>('backup_startup_status'));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? 50;
  const attempts = Math.ceil((options.timeoutMs ?? 10_000) / interval);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    let current: StartupStatus;
    try {
      current = await status();
    } catch {
      throw new StartupGateTimeoutError('status-unavailable');
    }
    if (current.state === 'ready') return;
    if (current.state === 'failed') throw new StartupRecoveryError(current.code);
    await sleep(interval);
  }
  throw new StartupGateTimeoutError('startup-timeout');
}

/** Fichier de base dans le dossier de configuration de l'app (géré par tauri-plugin-sql). */
export const TAURI_DB_URL = 'sqlite:circletasks.db';

/**
 * Driver de production (PC et iPhone) : tauri-plugin-sql, SQLite via sqlx côté Rust.
 * Les appels sont sérialisés par `createSerializedDriver`, et le pool sqlx du plugin est limité à UNE connexion
 * (src-tauri/vendor/tauri-plugin-sql, open_sqlite_pool) : sans cela, la connexion d'un appel n'est rendue au pool que par une
 * tâche asynchrone, l'appel suivant en ouvre une 2e, et BEGIN IMMEDIATE / écriture / COMMIT se verrouillent (code 5, ADR 0002).
 * Un échec porte son étape (`DbStepError`) : Database.load, ou PRAGMA initiaux (diagnostic sous app.dbError).
 */
export async function openTauriSqlDriver(
  url: string = TAURI_DB_URL,
  options: SerializedDriverOptions = {},
): Promise<SqlDriver> {
  let db: Database;
  try {
    if (detectOs() === 'ios') await awaitStartupGate();
    db = await Database.load(url);
  } catch (error) {
    throw new DbStepError('load', error);
  }
  try {
    await db.execute('PRAGMA foreign_keys = ON');
    // Le pool Rust ouvre déjà en WAL (src-tauri/vendor/tauri-plugin-sql) ; on le vérifie : SQLite répond « delete » au lieu d'échouer
    // quand le WAL est impossible, et la base resterait en journal de retour arrière sans qu'aucune erreur ne le dise.
    const mode = await db.select<Array<{ journal_mode?: unknown }>>('PRAGMA journal_mode = WAL');
    const raw = mode[0]?.journal_mode;
    const effective = typeof raw === 'string' ? raw.toLowerCase() : null;
    if (effective !== 'wal') throw new JournalModeError(effective);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw new DbStepError('pragma', error);
  }

  return createSerializedDriver('tauri-sqlite', {
    execute: async (sql, params) => {
      const result = await db.execute(sql, [...params]);
      return { rowsAffected: result.rowsAffected, lastInsertId: result.lastInsertId ?? null };
    },
    select: async (sql, params) => db.select<SqlRow[]>(sql, [...params]),
    close: async () => {
      await db.close();
    },
  }, options);
}
