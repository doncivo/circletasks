import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../domain/clock';
import { sampleMigrations } from '../../tests/fixtures/migrations/sample';
import type { SqlDriver } from './driver';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import {
  MigrationError,
  ensureMigrationsTable,
  migrate,
  migrationChecksum,
  readAppliedMigrations,
  validateMigrations,
  type Migration,
} from './migrator';
import { migrations as appMigrations } from './migrations';

describe('lanceur de migrations', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée schema_migrations et applique les migrations dans l’ordre', async () => {
    const clock = createManualClock('2026-10-01T08:00:00.000Z');
    const report = await migrate(db, sampleMigrations, { clock });

    expect(report).toEqual({ applied: [1, 2], currentVersion: 2 });
    const rows = await readAppliedMigrations(db);
    expect(rows.map((r) => [r.version, r.name, r.applied_at])).toEqual([
      [1, 'demo_note', '2026-10-01T08:00:00.000Z'],
      [2, 'demo_note_search', '2026-10-01T08:00:00.000Z'],
    ]);
    // La table virtuelle FTS5 de la migration 2 existe (prérequis M14).
    await db.execute('INSERT INTO demo_note_fts (body) VALUES (?)', ['Réunion d’équipe']);
    const hits = await db.select('SELECT body FROM demo_note_fts WHERE demo_note_fts MATCH ?', ['reunion']);
    expect(hits).toHaveLength(1);
  });

  it('est rejouable : un second passage n’applique rien', async () => {
    await migrate(db, sampleMigrations);
    const beforeApply = vi.fn(async () => undefined);
    const report = await migrate(db, sampleMigrations, { beforeApply });
    expect(report.applied).toEqual([]);
    expect(beforeApply).not.toHaveBeenCalled();
  });

  it('applique seulement les nouvelles versions et prévient avant (sauvegarde)', async () => {
    await migrate(db, sampleMigrations.slice(0, 1));
    const beforeApply = vi.fn(async (_pending: readonly Migration[]) => undefined);
    const report = await migrate(db, sampleMigrations, { beforeApply });
    expect(report.applied).toEqual([2]);
    expect(beforeApply).toHaveBeenCalledOnce();
    expect(beforeApply.mock.calls[0]?.[0].map((m) => m.version)).toEqual([2]);
  });

  it('annule toute la migration si une instruction échoue', async () => {
    const broken: Migration[] = [
      { version: 1, name: 'ok_puis_ko', statements: ['CREATE TABLE a (x TEXT)', 'CREATE TABLE ??? invalide'] },
    ];
    await expect(migrate(db, broken)).rejects.toMatchObject({ name: 'DbError', code: 'syntax' });
    const tables = await db.select("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'");
    expect(tables).toEqual([]);
    expect(await readAppliedMigrations(db)).toEqual([]);
  });

  it('refuse une migration modifiée après application', async () => {
    await migrate(db, sampleMigrations.slice(0, 1));
    const first = sampleMigrations[0];
    if (!first) throw new Error('fixture manquante');
    const altered: Migration[] = [{ ...first, statements: ['CREATE TABLE autre (id TEXT)'] }];
    await expect(migrate(db, altered)).rejects.toThrow(MigrationError);
  });

  it('refuse une base plus récente que le code', async () => {
    await migrate(db, sampleMigrations);
    await expect(migrate(db, sampleMigrations.slice(0, 1))).rejects.toThrow(/inconnue/);
  });

  it('ensureMigrationsTable est idempotent et readAppliedMigrations ne crée rien', async () => {
    await expect(readAppliedMigrations(db)).rejects.toMatchObject({ code: 'syntax' });
    await ensureMigrationsTable(db);
    await ensureMigrationsTable(db);
    expect(await readAppliedMigrations(db)).toEqual([]);
  });

  it('valide la liste déclarée', () => {
    expect(() => validateMigrations([{ version: 0, name: 'x', statements: ['SELECT 1'] }])).toThrow(MigrationError);
    expect(() =>
      validateMigrations([
        { version: 2, name: 'b', statements: ['SELECT 1'] },
        { version: 1, name: 'a', statements: ['SELECT 1'] },
      ]),
    ).toThrow(/croissantes/);
    expect(() => validateMigrations([{ version: 1, name: 'vide', statements: [] }])).toThrow(/vide/);
  });

  it('calcule une somme de contrôle stable', () => {
    const m: Migration = { version: 1, name: 'x', statements: ['SELECT 1'] };
    expect(migrationChecksum(m)).toBe(migrationChecksum({ ...m }));
    expect(migrationChecksum(m)).toMatch(/^[0-9a-f]{8}$/);
    expect(migrationChecksum(m)).not.toBe(migrationChecksum({ ...m, statements: ['SELECT 2'] }));
  });

  it('le registre de l’app est valide et s’applique sur une base vide', async () => {
    expect(() => validateMigrations(appMigrations)).not.toThrow();
    const report = await migrate(db, appMigrations);
    expect(report.applied).toHaveLength(appMigrations.length);
  });
});
