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
const preparedOf = new WeakMap<SqlDriver, ReadonlyMap<string, unknown>>();

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

  // Instructions préparées gardées par texte SQL : SQLite recompile à chaque préparation les programmes de tous les déclencheurs de la
  // table (une `UPDATE task` coûtait ~2,4 ms, pour 0,5 ms à l'insertion), et un report de 501 lignes en préparait des dizaines de milliers.
  const prepared = new Map<string, ReturnType<Db['prepare']>>();
  const run = <T>(sql: string, params: readonly unknown[], consume: (stmt: ReturnType<Db['prepare']>) => T): T => {
    const cached = prepared.get(sql);
    const stmt = cached ?? db.prepare(sql);
    if (cached === undefined) prepared.set(sql, stmt);
    try {
      if (params.length > 0) stmt.bind([...params] as never);
      return consume(stmt);
    } finally {
      stmt.reset(true);
    }
  };
  const driver = createSerializedDriver('sqlite-wasm', {
    execute: async (sql, params) => {
      if (!isSingleStatement(sql)) db.exec({ sql, bind: [...params] });
      else run(sql, params, (stmt) => { while (stmt.step()); });
      return {
        rowsAffected: Number(db.changes()),
        lastInsertId: Number(db.selectValue('SELECT last_insert_rowid()') ?? 0) || null,
      };
    },
    select: async (sql, params) => {
      if (!isSingleStatement(sql)) return db.selectObjects(sql, [...params]) as SqlRow[];
      return run(sql, params, (stmt) => {
        const names = stmt.getColumnNames([]);
        const rows: SqlRow[] = [];
        while (stmt.step()) {
          const values = stmt.get([]);
          const row = Object.create(null) as SqlRow;
          names.forEach((name, i) => {
            row[name] = values[i] as SqlRow[string];
          });
          rows.push(row);
        }
        return rows;
      });
    },
    close: async () => {
      for (const stmt of prepared.values()) stmt.finalize();
      prepared.clear();
      db.close();
    },
  }, options);
  dbOf.set(driver, db);
  preparedOf.set(driver, prepared);
  return driver;
}

/** Nombre d'instructions préparées gardées (une par texte SQL distinct) : preuve, sans chronomètre, qu'un texte répété n'est pas recompilé. */
export const preparedStatementCount = (driver: SqlDriver): number => preparedOf.get(driver)?.size ?? 0;

/** Une seule instruction de lecture ou d'écriture de données, sans point-virgule au milieu : seule forme gardée préparée. */
const isSingleStatement = (sql: string): boolean => /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql) && !/;\s*\S/.test(sql);

/** Image binaire de la base (à passer à `openSqliteWasmDriver`) ; hors transaction. */
export async function exportSqliteWasmImage(driver: SqlDriver): Promise<Uint8Array> {
  const db = dbOf.get(driver);
  if (db === undefined) throw new Error('Pilote SQLite Wasm inconnu');
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  return sqlite3.capi.sqlite3_js_db_export(db.pointer as number);
}
