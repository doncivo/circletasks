import type { MigrationBackup } from '../db/migrationBackup';
import type { SqlDriver } from '../db/driver';
import { detectRuntime, type Runtime } from './runtime';

/**
 * Point unique de sélection du driver SQLite (ADR 0002).
 * - App Tauri (PC, iPhone) : tauri-plugin-sql ;
 * - navigateur de développement et Playwright : SQLite Wasm en mémoire.
 * Les imports sont dynamiques : chaque build ne charge que son driver.
 */
export async function openDatabase(runtime: Runtime = detectRuntime()): Promise<SqlDriver> {
  if (runtime === 'tauri') {
    const { openTauriSqlDriver } = await import('./tauri/sqlDriver');
    return openTauriSqlDriver();
  }
  // Constante remplacée à la compilation par Vite : dans un build Tauri, la branche
  // Wasm devient du code mort et le .wasm n'est pas embarqué dans l'installeur.
  if (import.meta.env.TAURI_ENV_PLATFORM) {
    throw new Error('Driver SQLite Wasm indisponible dans un build Tauri');
  }
  const { openSqliteWasmDriver } = await import('../db/drivers/sqliteWasm');
  return openSqliteWasmDriver();
}

/**
 * Port de sauvegarde avant migration pour le driver ouvert (D-03 critères 8 et 9).
 * - Tauri : copie cohérente dans `backups/` (commande Rust) ;
 * - navigateur de dev (SQLite Wasm en mémoire, vide à chaque rechargement) : SAUTÉE, il n'y a
 *   rien à protéger ; la sauvegarde réelle est couverte par `cargo test` (ADR 0002, avenant).
 */
export async function createMigrationBackup(db: SqlDriver): Promise<MigrationBackup | undefined> {
  if (db.kind !== 'tauri-sqlite') return undefined;
  const { createTauriMigrationBackup } = await import('./tauri/migrationBackup');
  return createTauriMigrationBackup(db);
}
