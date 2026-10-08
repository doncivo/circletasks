import Database from '@tauri-apps/plugin-sql';
import type { SqlDriver, SqlRow } from '../../db/driver';
import { DbStepError } from '../../db/errorText';
import { createSerializedDriver, type SerializedDriverOptions } from '../../db/serializedDriver';

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
    db = await Database.load(url);
  } catch (error) {
    throw new DbStepError('load', error);
  }
  try {
    await db.execute('PRAGMA foreign_keys = ON');
    // Le pool Rust ouvre déjà en WAL (src-tauri/vendor/tauri-plugin-sql) ; on le vérifie : SQLite répond « delete » au lieu d'échouer
    // quand le WAL est impossible, et la base resterait en journal de retour arrière sans qu'aucune erreur ne le dise.
    const mode = await db.select<Array<{ journal_mode?: unknown }>>('PRAGMA journal_mode = WAL');
    const effective = String(mode[0]?.journal_mode ?? 'inconnu').toLowerCase();
    if (effective !== 'wal') throw new Error(`mode de journal effectif « ${effective} » au lieu de « wal »`);
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
