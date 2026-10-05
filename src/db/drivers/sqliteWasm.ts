import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDriver, SqlRow } from '../driver';
import { createSerializedDriver, type SerializedDriverOptions } from '../serializedDriver';

/**
 * Driver de développement et de test (ADR 0002) : SQLite officiel compilé en
 * WebAssembly, base en mémoire. Tourne dans Vitest (Node) et dans le navigateur
 * (npm run dev, Playwright). FTS5 et JSON inclus, comme le SQLite du plugin Tauri.
 * Jamais utilisé dans l'app Tauri (sélection dans src/platform/database.ts).
 */

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Db = InstanceType<Sqlite3['oo1']['DB']>;

/** Le module WebAssembly est compilé une seule fois par processus ; chaque base reste indépendante. */
let sqlite3Promise: Promise<Sqlite3> | null = null;
const dbOf = new WeakMap<SqlDriver, Db>();

/**
 * Ouvre une base en mémoire. `image` (obtenue par `exportSqliteWasmImage`) recopie une base déjà migrée au lieu de
 * rejouer les migrations : les tests qui ouvrent beaucoup de bases en profitent.
 */
export async function openSqliteWasmDriver(options: SerializedDriverOptions = {}, image?: Uint8Array): Promise<SqlDriver> {
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  if (image !== undefined) {
    const pointer = sqlite3.wasm.allocFromTypedArray(image);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const code = sqlite3.capi.sqlite3_deserialize(db.pointer as number, 'main', pointer, image.byteLength, image.byteLength, flags);
    db.checkRc(code);
  }
  db.exec('PRAGMA foreign_keys = ON');

  const driver = createSerializedDriver('sqlite-wasm', {
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
  dbOf.set(driver, db);
  return driver;
}

/** Image binaire de la base (à passer à `openSqliteWasmDriver`) ; hors transaction. */
export async function exportSqliteWasmImage(driver: SqlDriver): Promise<Uint8Array> {
  const db = dbOf.get(driver);
  if (db === undefined) throw new Error('Pilote SQLite Wasm inconnu');
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  return sqlite3.capi.sqlite3_js_db_export(db.pointer as number);
}
