import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../domain/clock';
import type { SqlDriver, SqlRow } from './driver';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import { backupStamp, createBackupBeforeMigration, MigrationBackupError, type MigrationBackup } from './migrationBackup';
import { migrations } from './migrations';
import { migrate, type Migration } from './migrator';
import { SPACE_PRO_ID } from './seed/defaultSpaces';

const clock = createManualClock('2026-10-02T10:15:00.000Z');

function fakePort() {
  const backup = vi.fn((_request: unknown) => Promise.resolve());
  return { port: { backup } satisfies MigrationBackup, backup };
}

const m = (version: number): Migration => ({
  version,
  name: `m${String(version)}`,
  statements: [`CREATE TABLE t${String(version)} (id INTEGER)`],
});

describe('sauvegarde avant migration : orchestration', () => {
  it('horodatage compact UTC', () => {
    expect(backupStamp(clock)).toBe('20261002T101500Z');
  });

  it('base neuve : aucune sauvegarde', async () => {
    const db = await openSqliteWasmDriver();
    const { port, backup } = fakePort();
    await migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration(port, clock) });
    expect(backup).not.toHaveBeenCalled();
    await db.close();
  });

  it('base existante avec migration en attente : sauvegarde AVANT la migration, avec versions et horodatage', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1), m(2)]);
    const order: string[] = [];
    const port: MigrationBackup = {
      backup: async (req) => {
        order.push(`backup ${String(req.fromVersion)}->${String(req.toVersion)} ${req.stamp}`);
        const rows = await db.select("SELECT name FROM sqlite_master WHERE name = 't3'");
        order.push(`t3 existe pendant la sauvegarde : ${String(rows.length === 1)}`);
      },
    };
    await migrate(db, [m(1), m(2), m(3), m(4)], { beforeApply: createBackupBeforeMigration(port, clock) });
    expect(order).toEqual(['backup 2->4 20261002T101500Z', 't3 existe pendant la sauvegarde : false']);
    expect(await db.select("SELECT name FROM sqlite_master WHERE name = 't4'")).toHaveLength(1);
    await db.close();
  });

  it('base à jour : aucune sauvegarde', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1), m(2)]);
    const { port, backup } = fakePort();
    await migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration(port, clock) });
    expect(backup).not.toHaveBeenCalled();
    await db.close();
  });

  it('échec de sauvegarde : migration NON appliquée, erreur MigrationBackupError', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1)]);
    const port: MigrationBackup = { backup: () => Promise.reject(new Error('disque plein')) };
    await expect(migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration(port, clock) })).rejects.toBeInstanceOf(
      MigrationBackupError,
    );
    expect(await db.select("SELECT name FROM sqlite_master WHERE name = 't2'")).toHaveLength(0);
    expect(await db.select('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
    await db.close();
  });

  it('sans port (navigateur de dev, Wasm) : sauvegarde sautée, migration appliquée', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1)]);
    const report = await migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration(undefined, clock) });
    expect(report.applied).toEqual([2]);
    await db.close();
  });
});

async function dumpAll(db: SqlDriver): Promise<Record<string, SqlRow[]>> {
  const tables = await db.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%' ORDER BY name",
  );
  const dump: Record<string, SqlRow[]> = {};
  for (const { name } of tables) dump[name] = await db.select(`SELECT * FROM "${name}" ORDER BY rowid`);
  return dump;
}

describe('migration rejouée sur une copie d’une base de la version précédente peuplée (PRD section 7)', () => {
  for (const from of [1, 2, 3]) {
    it(`depuis la version ${String(from)} jusqu’à la dernière migration : aucune donnée perdue, rejouable`, async () => {
      const db = await openSqliteWasmDriver();
      await migrate(db, migrations.slice(0, from));
      for (const [i, title] of ['Appeler le médecin', 'Facture électricité', 'Courses'].entries()) {
        await db.execute(
          `INSERT INTO task (id, space_id, title, note, date, status, created_at, updated_at, device_id, hlc)
           VALUES (?, ?, ?, 'note', ?, 'todo', '2026-09-23T08:00:00.000Z', '2026-09-23T08:00:00.000Z', 'd', 'h')`,
          [`task-${String(i)}`, SPACE_PRO_ID, title, `2026-10-0${String(i + 1)}`],
        );
      }
      // « Copie » de la base de la version précédente, prise au moment de la sauvegarde.
      let copy: Record<string, SqlRow[]> | undefined;
      const port: MigrationBackup = {
        backup: async () => {
          copy = await dumpAll(db);
        },
      };
      const report = await migrate(db, migrations, { beforeApply: createBackupBeforeMigration(port, clock) });
      expect(report.applied).toEqual(migrations.slice(from).map((x) => x.version));

      expect(copy).toBeDefined();
      const after = await dumpAll(db);
      for (const [table, rows] of Object.entries(copy ?? {})) {
        if (table === 'schema_migrations') continue;
        expect(after[table]).toHaveLength(rows.length);
        rows.forEach((row, i) => {
          // Les migrations n'ajoutent que des colonnes : toutes les valeurs d'origine sont conservées.
          expect(after[table]?.[i]).toMatchObject(row);
        });
      }
      expect(copy?.['task']).toHaveLength(3);
      expect((await migrate(db, migrations)).applied).toEqual([]);
      await db.close();
    });
  }
});
