import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../../src/db/drivers/sqliteWasm';
import { migrations } from '../../../../src/db/migrations';
import { migrate, type Migration, type MigrateReport } from '../../../../src/db/migrator';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS } from '../../../../src/platform/calendars';
import { createUnavailableBackup } from '../../../../src/platform/backup';
import { createUnavailableFiles } from '../../../../src/platform/files';
import { useAppStore } from '../../../../src/features/app/appStore';
import { bootstrapApp, reintegrateAfterMigration } from '../../../../src/features/app/bootstrap';
import type { Hlc } from '../../../../src/domain/types';
import { DbError } from '../../../../src/db/driver';
import { createMemorySyncPlatform } from '../../../../src/platform/sync/memory';
import { parseReintegrationFailure, REINTEGRATION_FAILURE_META } from '../../../../src/domain/sync/compat';
import { isTroublePhase, statusLine } from '../../../../src/features/sync/syncText';

/**
 * Crochet de fin du migrateur et démarrage (Y-07 critère 6, D3) : `afterApply` appelé à chaque `migrate()`, même sans migration en
 * attente ; `bootstrapApp` réintègre les champs devenus connus avant de construire l'app ; un échec n'empêche pas le démarrage.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T1 = '11111111-1111-4111-8111-111111111111';
const PRO = '00000000-0000-4000-8000-000000000001';
const h = (ms: number): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${A}` as Hlc;
const common = { desktop: null, focusWindow: null, files: createUnavailableFiles(), calendars: createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS), backups: createUnavailableBackup(), syncPlatform: null } as const;

const m = (version: number): Migration => ({ version, name: `t${String(version)}`, statements: [`CREATE TABLE t${String(version)} (id INTEGER)`] });

async function seededDb(): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations);
  await db.execute(
    `INSERT INTO task (id, space_id, project_id, title, note, date, time, status, done_at, sort_order, carried_over, recurrence_id, series_index, goal_id, icon, someday, source, external_id, series_template, external_event_id, created_at, deleted_at, updated_at, device_id, hlc)
     VALUES (?, ?, NULL, 'Ancien titre', '', '2026-10-05', NULL, 'todo', NULL, 1, 0, NULL, NULL, NULL, NULL, 0, 'local', NULL, NULL, NULL, '2026-10-05T08:00:00.000Z', NULL, '2026-10-05T08:00:00.000Z', ?, ?)`,
    [T1, PRO, A, h(0)],
  );
  await db.execute('DELETE FROM sync_outbox');
  await db.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', ?, 'title', ?, ?, NULL, 99)", [T1, JSON.stringify('Titre de la version suivante'), h(60_000)]);
  return db;
}

describe('crochet afterApply du migrateur (Y-07 critère 6)', () => {
  it('appelé après les migrations en attente, puis à chaque appel même sans migration (D3), avec le rapport', async () => {
    const db = await openSqliteWasmDriver();
    const calls: MigrateReport[] = [];
    const afterApply = async (driver: SqlDriver, report: MigrateReport) => {
      expect(driver).toBe(db);
      expect(await driver.select('SELECT name FROM sqlite_master WHERE name = ?', [`t${String(report.currentVersion)}`])).toHaveLength(1);
      calls.push(report);
    };
    await migrate(db, [m(1), m(2)], { afterApply });
    await migrate(db, [m(1), m(2)], { afterApply });
    await migrate(db, [m(1), m(2), m(3)], { afterApply });
    expect(calls).toEqual([
      { applied: [1, 2], currentVersion: 2 },
      { applied: [], currentVersion: 2 },
      { applied: [3], currentVersion: 3 },
    ]);
    await db.close();
  });

  it('une erreur du crochet fait échouer migrate() ; les migrations appliquées le restent', async () => {
    const db = await openSqliteWasmDriver();
    await expect(migrate(db, [m(1)], { afterApply: () => Promise.reject(new Error('crochet')) })).rejects.toThrow('crochet');
    expect(await db.select('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
    await db.close();
  });

  it('jamais appelé si migrate() échoue avant (migration inconnue en base)', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1), m(2)]);
    const afterApply = vi.fn(() => Promise.resolve());
    await expect(migrate(db, [m(1)], { afterApply })).rejects.toThrow();
    expect(afterApply).not.toHaveBeenCalled();
    await db.close();
  });
});

describe('démarrage (bootstrap.ts, Y-07 critère 6)', () => {
  beforeEach(() => useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null }));
  afterEach(() => vi.restoreAllMocks());

  it('un champ gardé devenu connu est réintégré au démarrage, sans entrée de file ; garde vide', async () => {
    const db = await seededDb();
    const container = await bootstrapApp({ ...common, open: () => Promise.resolve(db) });
    expect(container).toBeDefined();
    expect(await db.select('SELECT title, hlc FROM task WHERE id = ?', [T1])).toEqual([{ title: 'Titre de la version suivante', hlc: h(60_000) }]);
    expect(await db.select('SELECT * FROM sync_unknown')).toEqual([]);
    expect(await db.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await db.select('SELECT * FROM sync_guard')).toEqual([]);
  });

  it('échec de la réintégration : l’app démarre quand même, les champs restent, le journal ne porte aucune valeur', async () => {
    const db = await seededDb();
    const failing: SqlDriver = {
      ...db,
      execute: (sql, params) => db.execute(sql, params),
      select: (sql, params) => db.select(sql, params),
      transaction: (fn) => db.transaction((tx) => fn({ select: (sql, params) => tx.select(sql, params), execute: (sql, params) => (sql.includes('UPDATE task') ? Promise.reject(new Error('Titre de la version suivante')) : tx.execute(sql, params)) })),
      close: () => db.close(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = await bootstrapApp({ ...common, open: () => Promise.resolve(failing) });
    expect(container).toBeDefined();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    expect(await db.select('SELECT field FROM sync_unknown')).toEqual([{ field: 'title' }]);
    expect(await db.select('SELECT title FROM task')).toEqual([{ title: 'Ancien titre' }]);
    expect(await db.select('SELECT * FROM sync_guard')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('Titre de la version suivante');
  });

  it('revue 2, point 1 : échec global (transaction refusée) : reintegrationFailure enregistré, affiché dans Réglages (synchro non configurée), l’app démarre', async () => {
    const db = await seededDb();
    // Deux champs gardés, dont un encore inconnu : un échec global ne sait pas lesquels sont réintégrables, il compte toutes les lignes.
    await db.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', ?, 'futur', '1', ?, NULL, 99)", [T1, h(60_000)]);
    let fail = true;
    const failing: SqlDriver = {
      ...db,
      execute: (sql, params) => db.execute(sql, params),
      select: (sql, params) => db.select(sql, params),
      transaction: (fn) => (fail ? Promise.reject(new DbError('busy', 'base occupée')) : db.transaction(fn)),
      close: () => db.close(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = await bootstrapApp({ ...common, open: () => Promise.resolve(failing), syncPlatform: createMemorySyncPlatform() });
    fail = false;
    expect(container).toBeDefined();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    const failure = parseReintegrationFailure(await db.select<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [REINTEGRATION_FAILURE_META]).then((r) => r[0]?.value ?? null));
    expect(failure).toMatchObject({ fields: 2, tables: [], errors: ['DbError'] });
    expect(warn).toHaveBeenCalled();
    // Synchro non configurée (revue 2, point 4) : la ligne de Réglages montre quand même l'échec.
    await container?.sync?.syncNow('manual');
    const status = container?.sync?.status();
    expect(status?.phase).toBe('not-configured');
    expect(status?.reintegrationFailure).toMatchObject({ fields: 2 });
    expect(status && statusLine(status, Date.now())).toBe('2 éléments reçus d’une version plus récente n’ont pas pu être intégrés');
    expect(status && isTroublePhase(status)).toBe(true);
  });

  it('échec global dont l’enregistrement échoue aussi : l’app démarre quand même', async () => {
    const db = await seededDb();
    const failing: SqlDriver = {
      ...db,
      execute: (sql, params) => (sql.includes('sync_meta') ? Promise.reject(new DbError('busy', 'base occupée')) : db.execute(sql, params)),
      select: (sql, params) => db.select(sql, params),
      transaction: () => Promise.reject(new DbError('busy', 'base occupée')),
      close: () => db.close(),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await reintegrateAfterMigration(failing)).toBeNull();
    expect(await db.select('SELECT * FROM sync_meta WHERE key = ?', [REINTEGRATION_FAILURE_META])).toEqual([]);
  });

  it('reintegrateAfterMigration renvoie le rapport (base vide : rien à faire)', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    expect(await reintegrateAfterMigration(db)).toEqual({ reintegrated: 0, superseded: 0, remaining: 0 });
    await db.close();
  });
});
