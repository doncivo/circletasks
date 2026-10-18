import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/domain/clock';
import type { SqlDriver, SqlExecutor, SqlParams } from '../../src/db/driver';
import { openSqliteWasmDriver } from '../../src/db/drivers/sqliteWasm';
import { migrate } from '../../src/db/migrator';
import { migrations } from '../../src/db/migrations';

/**
 * SEC-01 critère 11 : fichier de référence des instructions SQL que le front envoie réellement au plugin SQL pour ouvrir la base
 * (table de suivi, toutes les migrations, tables, index, déclencheurs, table virtuelle fts5). Le test Rust
 * `src-tauri/tests/desktop/sql_closed.rs` les rejoue sur un pool avec l'autorisateur actif : un refus de l'une d'elles (nouvelle
 * migration utilisant un pragma, une fonction ou un module refusés) fait échouer la CI. Le fichier est GÉNÉRÉ, jamais écrit à la main :
 * ce test échoue s'il est périmé ; `CT_UPDATE_SQL_REFERENCE=1 npx vitest run tests/unit/sqlFrontReference.test.ts` le régénère.
 */
const REFERENCE = resolve(import.meta.dirname, '../../src-tauri/tests/fixtures/front-sql.json');

interface Recorded {
  readonly kind: 'execute' | 'select';
  readonly sql: string;
  readonly params: SqlParams;
}

function recording(driver: SqlDriver, log: Recorded[]): SqlDriver {
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    execute: (sql, params) => {
      log.push({ kind: 'execute', sql, params: params ?? [] });
      return executor.execute(sql, params);
    },
    select: (sql, params) => {
      log.push({ kind: 'select', sql, params: params ?? [] });
      return executor.select(sql, params);
    },
  });
  return {
    ...wrap(driver),
    kind: driver.kind,
    transaction: (fn) => driver.transaction((tx) => fn(wrap(tx))),
    close: () => driver.close(),
  };
}

describe('SEC-01 : instructions du front rejouées par le test Rust du plugin SQL fermé', () => {
  it('le fichier de référence correspond aux migrations actuelles', async () => {
    const driver = await openSqliteWasmDriver();
    const log: Recorded[] = [];
    await migrate(recording(driver, log), migrations, { clock: createManualClock('2026-10-01T08:00:00.000Z') });
    await driver.close();
    const text = `${JSON.stringify({ statements: log }, null, 1)}\n`;
    if (process.env['CT_UPDATE_SQL_REFERENCE'] === '1') writeFileSync(REFERENCE, text);
    expect(readFileSync(REFERENCE, 'utf8')).toBe(text);
    // Garde-fou : la référence contient bien la table virtuelle fts5 et chaque migration.
    expect(text).toContain('USING fts5');
    expect(log.filter((entry) => entry.sql.startsWith('INSERT INTO schema_migrations'))).toHaveLength(migrations.length);
  });
});
