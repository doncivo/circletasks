import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDriver, SqlRow } from '../driver';
import { createSerializedDriver, type SerializedDriverOptions } from '../serializedDriver';

/**
 * Driver de développement et de test (ADR 0002) : SQLite officiel compilé en
 * WebAssembly, base en mémoire. Tourne dans Vitest (Node) et dans le navigateur
 * (npm run dev, Playwright). FTS5 et JSON inclus, comme le SQLite du plugin Tauri.
 * Jamais utilisé dans l'app Tauri (sélection dans src/platform/database.ts).
 */
export async function openSqliteWasmDriver(options: SerializedDriverOptions = {}): Promise<SqlDriver> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec('PRAGMA foreign_keys = ON');

  return createSerializedDriver('sqlite-wasm', {
    execute: async (sql, params) => {
      db.exec({ sql, bind: [...params] });
      return {
        rowsAffected: Number(db.changes()),
        lastInsertId: Number(db.selectValue('SELECT last_insert_rowid()') ?? 0) || null,
      };
    },
    select: async (sql, params) => db.selectObjects(sql, [...params]) as SqlRow[],
    close: async () => {
      db.close();
    },
  }, options);
}
