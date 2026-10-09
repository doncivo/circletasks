import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { SqlDriver } from '../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../src/db/drivers/sqliteWasm';
import { findUpdateBackup, type MigrationBackup, type MigrationBackupRequest } from '../../../src/db/migrationBackup';
import { migrations } from '../../../src/db/migrations';
import { migrate, type Migration } from '../../../src/db/migrator';
import { useAppStore } from '../../../src/features/app/appStore';
import { bootstrapDatabase } from '../../../src/features/app/bootstrap';

/**
 * Revue I-06, I1 et M4 : la sauvegarde « Avant mise à jour » n'est réutilisée que pour une chaîne de migrations vraiment interrompue ; une
 * sauvegarde périmée (restauration P-04 plus tard, version N utilisée entre deux essais) n'est jamais présentée comme « l'état d'avant la
 * mise à jour » ; une liste illisible donne une nouvelle sauvegarde et une ligne de journal au code seul.
 */

const LAST = migrations.at(-1)?.version ?? 0;
const pad = (n: number): string => String(n).padStart(4, '0');
const A: Migration = { version: LAST + 1, name: 'test_i06_r_a', statements: ['ALTER TABLE task ADD COLUMN i06_r_a TEXT'] };
const BROKEN_B: Migration = { version: LAST + 2, name: 'test_i06_r_b', statements: ['INSTRUCTION INVALIDE'] };
const FIXED_B: Migration = { version: LAST + 2, name: 'test_i06_r_b', statements: ['CREATE TABLE i06_r_b (id INTEGER)'] };

const keepOpen = (db: SqlDriver): SqlDriver => ({ kind: db.kind, execute: (s, p) => db.execute(s, p), select: (s, p) => db.select(s, p), transaction: (fn) => db.transaction(fn), close: () => Promise.resolve() });

/** Port de sauvegarde dont la liste contient aussi les sauvegardes « du monde » (quotidiennes, copies pre-restore). */
function port(extra: string[], listFails = false) {
  const made: MigrationBackupRequest[] = [];
  const names = [...extra];
  const value: MigrationBackup = {
    backup(request) {
      made.push(request);
      const name = `circletasks-pre-migration-v${pad(request.fromVersion)}-to-v${pad(request.toVersion)}-${request.stamp}.db`;
      names.push(name);
      return Promise.resolve({ name });
    },
    findPrevious: (target) => (listFails ? Promise.reject(new Error('liste illisible')) : Promise.resolve(findUpdateBackup(names, target))),
  };
  return { made, names, factory: () => Promise.resolve(value) };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null, dbBackupFailed: false });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('revue I1 : jamais une sauvegarde périmée présentée comme « avant la mise à jour »', () => {
  it('restauration P-04 d’une ancienne quotidienne des semaines après une mise à jour réussie : nouvelle sauvegarde avant de remigrer', async () => {
    const clock = createManualClock('2026-10-01T08:00:00.000Z');
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    const backups = port([]);
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A] })).toBeDefined();
    expect(backups.made).toHaveLength(1);
    // Trois semaines plus tard : restauration P-04 d'une quotidienne au schéma N (copie pre-restore du jour) ; la base revient à N.
    clock.advance(20 * 86_400_000);
    const restored = await openSqliteWasmDriver();
    await migrate(restored, migrations);
    backups.names.push('circletasks-daily-20260928.db', 'circletasks-pre-restore-20261021T080000Z.db');
    clock.advance(3_600_000);
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(restored)), { clock, backup: backups.factory, migrations: [...migrations, A] })).toBeDefined();
    expect(backups.made).toHaveLength(2);
    expect(backups.made[1]).toMatchObject({ fromVersion: LAST, toVersion: LAST + 1, stamp: '20261021T090000Z' });
  });

  it('N+1 en échec à mi-chaîne, N+1 partiel utilisé des jours, N+1 corrigée : nouvelle sauvegarde, jamais l’ancienne', async () => {
    const clock = createManualClock('2026-10-09T08:00:00.000Z');
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    const backups = port([]);
    // Premier essai : A validée, B en échec ; sauvegarde vN-to-vN+2 du 9.
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A, BROKEN_B] })).toBeUndefined();
    expect(useAppStore.getState().dbFailure?.updateBackup?.name).toBe(backups.names[0]);
    // L'app a servi les jours suivants (quotidiennes du 10 et du 11) ; puis la version corrigée.
    backups.names.push('circletasks-daily-20261010.db', 'circletasks-daily-20261011.db');
    clock.advance(3 * 86_400_000);
    useAppStore.setState({ dbStatus: 'idle', dbFailure: null });
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A, FIXED_B] })).toBeDefined();
    expect(backups.made).toHaveLength(2);
    expect(backups.made[1]).toMatchObject({ fromVersion: LAST + 1, toVersion: LAST + 2, stamp: '20261012T080000Z' });
  });

  it('chaîne vraiment interrompue (aucune utilisation entre-temps) : la sauvegarde du premier essai est réutilisée', async () => {
    const clock = createManualClock('2026-10-09T08:00:00.000Z');
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    const backups = port([]);
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A, BROKEN_B] })).toBeUndefined();
    clock.advance(60_000);
    useAppStore.setState({ dbStatus: 'idle', dbFailure: null });
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A, FIXED_B] })).toBeDefined();
    expect(backups.made).toHaveLength(1);
  });
});

describe('revue M4 : liste des sauvegardes illisible', () => {
  it('nouvelle sauvegarde avant de migrer et une ligne de journal « pre-migration-list-unreadable » (code seul)', async () => {
    const clock = createManualClock('2026-10-09T08:00:00.000Z');
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    const backups = port([], true);
    expect(await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, A] })).toBeDefined();
    expect(backups.made).toHaveLength(1);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[desktop:db] pre-migration-list-unreadable');
  });
});
