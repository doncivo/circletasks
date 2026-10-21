import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../../db/driver';
import { exportSqliteWasmImage, openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import type { MigrationBackup } from '../../db/migrationBackup';
import { migrations } from '../../db/migrations';
import type { MigrateOptions, MigrateReport } from '../../db/migrator';
import * as migrator from '../../db/migrator';
import { createManualClock } from '../../domain/clock';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import { openStartupRecovery } from '../../platform/backup/recovery';
import { useAppStore } from './appStore';
import { bootstrapDatabase } from './bootstrap';
import { DbFailureDetails } from './DbFailureDetails';
import { restoreUpdateBackup } from './updateRestore';
// @ts-expect-error instrumentation .mjs réservée aux builds A9
import { afterApplyFault, pauseAfterCommit } from '../../../scripts/ios/prepare-a9.mjs';

const fault = { mode: 'afterapply', completedHooks: 0 };
const actual = { migrate: migrator.migrate };
const clock = createManualClock('2026-10-21T16:30:00.000Z');
const BACKUP = 'circletasks-pre-migration-v0018-to-v0019-20261021T163000Z.db';
const CANARY = 'a9000000-0000-4000-8000-000000000019';
const DEVICE = 'a9000000-0000-4000-8000-000000000001';
const drivers: SqlDriver[] = [];
const preserveForInspection = (db: SqlDriver): SqlDriver => ({ ...db, close: () => Promise.resolve() });
const version = async (db: SqlDriver) => (await db.select<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations'))[0]?.version;

async function baseline() {
  const db = await openSqliteWasmDriver();
  drivers.push(db);
  await actual.migrate(db, migrations.slice(0, 18));
  await db.execute("INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, '00000000-0000-4000-8000-000000000001', 'A9 conserver cette tâche', '2026-10-21T16:00:00.000Z', '2026-10-21T16:00:00.000Z', ?, ?)", [CANARY, DEVICE, `000000000000001-0000-${DEVICE}`]);
  return db;
}

beforeEach(() => {
  vi.spyOn(migrator, 'migrate').mockImplementation((db: SqlDriver, list: typeof migrations, options: MigrateOptions = {}) => actual.migrate(db, list, {
    ...options,
    afterApply: async (driver: SqlDriver, report: MigrateReport) => {
      if (fault.mode === 'interruption') await pauseAfterCommit(driver, report);
      await options.afterApply?.(driver, report);
      fault.completedHooks += 1;
      if (fault.mode === 'afterapply') await afterApplyFault(driver, report);
      if (fault.mode === 'interruption') localStorage.setItem('ct.a9.interruption', 'completed');
    },
  }));
  localStorage.clear();
  fault.mode = 'afterapply';
  fault.completedHooks = 0;
  useAppStore.setState({ dbStatus: 'idle', dbFailure: null, dbBackupFailed: false });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  cleanup();
  for (const db of drivers.splice(0)) await db.close().catch(() => undefined);
  vi.restoreAllMocks();
});

describe('I-06 A9 : vrai schéma 18 vers 19, faute après commit', () => {
  it('exception : base en 19, ancien lecteur refusé, action de restauration rend la vraie image 18 puis la reprise termine en 19 sans perte', async () => {
    let db = await baseline();
    let image: Uint8Array | undefined;
    const backup: MigrationBackup = { backup: async () => { image = await exportSqliteWasmImage(db); return { name: BACKUP }; } };
    expect(await bootstrapDatabase(() => Promise.resolve(preserveForInspection(db)), { clock, backup: () => Promise.resolve(backup), appVersion: '1.0.0' })).toBeUndefined();
    expect(await version(db)).toBe(19);
    expect(fault.completedHooks).toBe(1);
    const failure = useAppStore.getState().dbFailure;
    expect(failure).toMatchObject({ step: 'afterApply', schemaVersion: 19, appSchemaVersion: 19, errorName: 'A9AfterApplyCommitted19', updateBackup: { name: BACKUP } });
    const before = createHash('sha256').update(await exportSqliteWasmImage(db)).digest('hex');
    await expect(actual.migrate(db, migrations.slice(0, 18))).rejects.toMatchObject({ name: 'SchemaNewerThanApp' });
    expect(createHash('sha256').update(await exportSqliteWasmImage(db)).digest('hex')).toBe(before);
    let restoredVersion: number | undefined;
    const recovery = openStartupRecovery('tauri', 'windows', {
      rollback: async (name) => {
        expect(name).toBe(BACKUP);
        expect(image).toBeDefined();
        db = await openSqliteWasmDriver({}, image);
        drivers.push(db);
        restoredVersion = await version(db);
        expect(await db.select("SELECT name FROM sqlite_master WHERE name = 'epoch_carry_report'")).toEqual([]);
      },
      relaunch: () => Promise.resolve(),
    });
    if (!failure) throw new Error('A9 failure expected');
    render(<DbFailureDetails failure={failure} canRestore readEnvironment={() => Promise.resolve({ runtime: 'tauri', os: 'ios', buildPlatform: 'ios', appVersion: '1.0.0', paths: null, pathsError: null })} restore={(name) => restoreUpdateBackup(name, clock, recovery)} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    await waitFor(() => expect(restoredVersion).toBe(18));
    // Le code du callback est inchangé ; seule la panne de laboratoire a été consommée.
    expect(await bootstrapDatabase(() => Promise.resolve(preserveForInspection(db)), { clock, backup: () => Promise.resolve(backup) })).toBeDefined();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    expect(await version(db)).toBe(19);
    expect(await db.select('SELECT id, title FROM task')).toEqual([{ id: CANARY, title: 'A9 conserver cette tâche' }]);
    expect(await db.select('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('arrêt après commit avant afterApply : nouvelle connexion sur image persistée, aucune migration rejouée, traitement repris et données intactes', async () => {
    const first = await baseline();
    await first.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', ?, 'apple_list_id', '\"A9 après reprise\"', ?, NULL, 18)", [CANARY, `000000000000009-0000-${DEVICE}`]);
    fault.mode = 'interruption';
    // Ce processus reste suspendu dans la barrière. La preuve physique tuera le vrai processus iOS.
    void bootstrapDatabase(() => Promise.resolve(preserveForInspection(first)), { clock });
    await waitFor(() => expect(localStorage.getItem('ct.a9.interruption')).toBe('paused'));
    expect(await version(first)).toBe(19);
    expect(fault.completedHooks).toBe(0);
    expect(await first.select('SELECT apple_list_id FROM task')).toEqual([{ apple_list_id: null }]);
    expect(await first.select('SELECT field FROM sync_unknown')).toEqual([{ field: 'apple_list_id' }]);
    const disk = await exportSqliteWasmImage(first);
    const restarted = await openSqliteWasmDriver({}, disk);
    drivers.push(restarted);
    const backup = vi.fn(() => Promise.reject(new Error('no migration pending, no backup needed')));
    expect(await bootstrapDatabase(() => Promise.resolve(preserveForInspection(restarted)), { clock, backup: () => Promise.resolve({ backup }) })).toBeDefined();
    expect(backup).not.toHaveBeenCalled();
    expect(fault.completedHooks).toBe(1);
    expect(localStorage.getItem('ct.a9.interruption')).toBe('completed');
    expect(useAppStore.getState().dbStatus).toBe('ready');
    expect(await restarted.select('SELECT id, title FROM task')).toEqual([{ id: CANARY, title: 'A9 conserver cette tâche' }]);
    expect(await restarted.select('SELECT apple_list_id FROM task')).toEqual([{ apple_list_id: 'A9 après reprise' }]);
    expect(await restarted.select('SELECT * FROM sync_unknown')).toEqual([]);
    expect(await restarted.select('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 19')).toEqual([{ count: 1 }]);
    expect(await restarted.select('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });
});
