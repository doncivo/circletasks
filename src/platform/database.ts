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
