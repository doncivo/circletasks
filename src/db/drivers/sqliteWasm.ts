import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDriver, SqlParams, SqlRow } from '../driver';
import { createSerializedDriver, type SerializedDriverOptions } from '../serializedDriver';

/**
 * Driver de développement et de test (ADR 0002) : SQLite officiel compilé en
 * WebAssembly, base en mémoire. Tourne dans Vitest (Node) et dans le navigateur
 * (npm run dev, Playwright). FTS5 et JSON inclus, comme le SQLite du plugin Tauri.
 * Jamais utilisé dans l'app Tauri (sélection dans src/platform/database.ts).
 */

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Db = InstanceType<Sqlite3['oo1']['DB']>;
type Stmt = ReturnType<Db['prepare']>;

/** Plafond des instructions gardées (moins récemment utilisée évincée et finalisée). */
export const PREPARED_STATEMENTS_MAX = 256;

/** Le module WebAssembly est compilé une seule fois par processus ; chaque base reste indépendante. */
let sqlite3Promise: Promise<Sqlite3> | null = null;
const dbOf = new WeakMap<SqlDriver, Db>();
const preparedOf = new WeakMap<SqlDriver, ReadonlyMap<string, unknown>>();
const preparesOf = new WeakMap<SqlDriver, { readonly prepares: number }>();

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
  // Bornée (LRU) : des dépôts construisent leur SQL (`IN (?, …)`, `SET …`) et le tas Wasm ne rétrécit jamais.
  const prepared = new Map<string, Stmt>();
  const stats = { prepares: 0 };
  const run = <T>(sql: string, params: SqlParams, consume: (stmt: Stmt) => T): T => {
    let stmt = prepared.get(sql);
    if (stmt === undefined) {
      // Évincer avant de préparer : si la finalisation échoue, la nouvelle instruction n'est pas encore créée, donc jamais perdue.
      if (prepared.size >= PREPARED_STATEMENTS_MAX) {
        const [oldest] = prepared.keys();
        if (oldest !== undefined) {
          const evicted = prepared.get(oldest);
          prepared.delete(oldest);
          evicted?.finalize();
        }
      }
      stmt = db.prepare(sql);
      stats.prepares += 1;
    } else prepared.delete(sql);
    prepared.set(sql, stmt); // le plus récemment utilisé en dernier
    try {
      if (params.length > 0) stmt.bind(params);
      return consume(stmt);
    } finally {
      // Après un `step` en échec, `reset` relance la même erreur (même classe, même code, même message que `db.exec`) : elle remplace
      // celle du `try` et reste la bonne ; l'instruction est bien remise à zéro. À ne pas « corriger ».
      stmt.reset(true);
    }
  };
  const driver = createSerializedDriver('sqlite-wasm', {
    execute: async (sql, params) => {
      if (!isSingleStatement(sql)) db.exec({ sql, bind: [...params] });
      else run(sql, params, (stmt) => { while (stmt.step()); });
      return {
        rowsAffected: Number(db.changes()),
        lastInsertId: Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer as number)) || null,
      };
    },
    select: async (sql, params) => {
      if (!isSingleStatement(sql)) return db.selectObjects(sql, [...params]) as SqlRow[];
      // Colonnes lues après chaque `step` : SQLite ne reprépare une instruction gardée (schéma changé) qu'au `step`.
      return run(sql, params, (stmt) => {
        const rows: SqlRow[] = [];
        while (stmt.step()) rows.push(stmt.get(Object.create(null) as Record<string, never>) as unknown as SqlRow);
        return rows;
      });
    },
    close: async () => {
      try {
        for (const stmt of prepared.values()) stmt.finalize();
      } finally {
        prepared.clear();
        db.close();
      }
    },
  }, options);
  dbOf.set(driver, db);
  preparedOf.set(driver, prepared);
  preparesOf.set(driver, stats);
  return driver;
}

/** Nombre d'instructions préparées gardées (une par texte SQL distinct) : preuve, sans chronomètre, qu'un texte répété n'est pas recompilé. */
export const preparedStatementCount = (driver: SqlDriver): number => preparedOf.get(driver)?.size ?? 0;

/** Nombre de préparations réelles par le cache (une par échec du cache) : un texte récent réutilisé ne l'augmente pas. */
export const preparationCount = (driver: SqlDriver): number => preparesOf.get(driver)?.prepares ?? 0;

/** Instructions encore ouvertes dans SQLite (parcours de `sqlite3_next_stmt`) : égal à la taille du cache si toute évincée est finalisée. */
export async function openStatementCount(driver: SqlDriver): Promise<number> {
  const db = dbOf.get(driver);
  if (db === undefined) throw new Error('Pilote SQLite Wasm inconnu');
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  let n = 0;
  for (let p = sqlite3.capi.sqlite3_next_stmt(db.pointer as number, 0); p; p = sqlite3.capi.sqlite3_next_stmt(db.pointer as number, p)) n += 1;
  return n;
}

/**
 * Une seule instruction de lecture ou d'écriture de données, sans point-virgule au milieu : seule forme gardée préparée. Un `;` dans un
 * littéral, ou un commentaire en tête, envoie au chemin non gardé : résultat juste, seulement plus lent.
 */
const isSingleStatement = (sql: string): boolean => /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql) && !/;\s*\S/.test(sql);

/** Image binaire de la base (à passer à `openSqliteWasmDriver`) ; hors transaction. */
export async function exportSqliteWasmImage(driver: SqlDriver): Promise<Uint8Array> {
  const db = dbOf.get(driver);
  if (db === undefined) throw new Error('Pilote SQLite Wasm inconnu');
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  return sqlite3.capi.sqlite3_js_db_export(db.pointer as number);
}
