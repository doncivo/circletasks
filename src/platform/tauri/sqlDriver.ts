import Database from '@tauri-apps/plugin-sql';
import type { SqlDriver, SqlRow } from '../../db/driver';
import { createSerializedDriver, type SerializedDriverOptions } from '../../db/serializedDriver';

/** Fichier de base dans le dossier de configuration de l'app (géré par tauri-plugin-sql). */
export const TAURI_DB_URL = 'sqlite:circletasks.db';

/**
 * Driver de production (PC et iPhone) : tauri-plugin-sql, SQLite via sqlx côté Rust.
 * Les appels sont sérialisés par `createSerializedDriver` : une seule connexion du
 * pool sqlx est alors utilisée, ce qui rend BEGIN / COMMIT fiables (ADR 0002).
 */
export async function openTauriSqlDriver(
  url: string = TAURI_DB_URL,
  options: SerializedDriverOptions = {},
): Promise<SqlDriver> {
  const db = await Database.load(url);
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute('PRAGMA journal_mode = WAL');

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
