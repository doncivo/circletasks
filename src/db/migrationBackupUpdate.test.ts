import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../domain/clock';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import { backupNameOf, createBackupBeforeMigration, findUpdateBackup, MigrationBackupError, type MigrationBackup } from './migrationBackup';
import { migrate, type Migration } from './migrator';

/** I-06 (ADR 0007 avenant I-06 point 6) : sauvegarde « Avant mise à jour » unique, réutilisée à la reprise ; nom rendu à l'écran d'échec. */

const clock = createManualClock('2026-10-09T08:00:00.000Z');
const m = (version: number): Migration => ({ version, name: `m${String(version)}`, statements: [`CREATE TABLE t${String(version)} (id INTEGER)`] });

describe('findUpdateBackup', () => {
  const names = [
    'circletasks-pre-migration-v0017-to-v0019-20261009T080000Z.db',
    'circletasks-pre-migration-v0017-to-v0019-20261010T080000Z.db',
    'circletasks-pre-migration-v0016-to-v0017-20261001T080000Z.db',
    'circletasks-daily-20261009.db',
    'circletasks-pre-restore-20261009T090000Z.db',
    'autre-fichier.db',
  ];

  it('chaîne vraiment interrompue (départ strictement inférieur à la version courante, rien de plus récent) : la plus récente est réutilisée', () => {
    expect(findUpdateBackup(names, { fromVersion: 18, toVersion: 19 })).toEqual({ name: 'circletasks-pre-migration-v0017-to-v0019-20261010T080000Z.db' });
    expect(findUpdateBackup(names, { fromVersion: 18, toVersion: 20 })).toBeNull();
    expect(findUpdateBackup([], { fromVersion: 18, toVersion: 19 })).toBeNull();
  });

  it('revue I1 : même départ que la version courante (migration ratée puis relancée, rien de validé) : nouvelle sauvegarde', () => {
    expect(findUpdateBackup(names, { fromVersion: 17, toVersion: 19 })).toBeNull();
    expect(findUpdateBackup(names, { fromVersion: 16, toVersion: 19 })).toBeNull();
  });

  it('revue I1 : restauration P-04 d’une ancienne quotidienne des semaines après une mise à jour réussie : nouvelle sauvegarde', () => {
    // Mise à jour 18 -> 19 réussie le 1er octobre ; le 20, restauration de la quotidienne du 28 septembre (schéma 18, copie pre-restore du 20).
    const list = ['circletasks-pre-migration-v0018-to-v0019-20261001T080000Z.db', 'circletasks-daily-20260928.db', 'circletasks-pre-restore-20261020T090000Z.db'];
    expect(findUpdateBackup(list, { fromVersion: 18, toVersion: 19 })).toBeNull();
    // Même avec une chaîne qui paraîtrait interrompue (départ 17), la copie pre-restore plus récente l'emporte.
    expect(findUpdateBackup(['circletasks-pre-migration-v0017-to-v0019-20261001T080000Z.db', 'circletasks-pre-restore-20261020T090000Z.db'], { fromVersion: 18, toVersion: 19 })).toBeNull();
  });

  it('revue I1 : N+1 en échec, N utilisée des jours (sauvegardes quotidiennes postérieures), N+1 corrigée : nouvelle sauvegarde, pas l’ancienne', () => {
    const list = ['circletasks-pre-migration-v0017-to-v0019-20261009T080000Z.db', 'circletasks-daily-20261010.db', 'circletasks-daily-20261011.db'];
    expect(findUpdateBackup(list, { fromVersion: 18, toVersion: 19 })).toBeNull();
    // La quotidienne du jour même (faite avant la mise à jour) ne compte pas comme plus récente.
    expect(findUpdateBackup(['circletasks-pre-migration-v0017-to-v0019-20261009T080000Z.db', 'circletasks-daily-20261009.db'], { fromVersion: 18, toVersion: 19 })).toEqual({ name: 'circletasks-pre-migration-v0017-to-v0019-20261009T080000Z.db' });
    // Une autre « Avant mise à jour » plus récente (autre cible) : l'app a servi depuis.
    expect(findUpdateBackup(['circletasks-pre-migration-v0017-to-v0019-20261009T080000Z.db', 'circletasks-pre-migration-v0018-to-v0020-20261012T080000Z.db'], { fromVersion: 18, toVersion: 19 })).toBeNull();
  });

  it('backupNameOf : nom seul, jamais le chemin (Windows et iPhone)', () => {
    expect(backupNameOf('C:\\Users\\x\\AppData\\Roaming\\fr.circletasks.planner\\backups\\a.db')).toBe('a.db');
    expect(backupNameOf('/var/mobile/Containers/Data/Application/X/Library/backups/b.db')).toBe('b.db');
    expect(backupNameOf('c.db')).toBe('c.db');
  });
});

describe('createBackupBeforeMigration : nom et réutilisation', () => {
  it('nouvelle sauvegarde : son nom est remis à onBackup ; sauvegarde déjà là pour la cible : réutilisée, aucune copie', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1)]);
    const seen: { name: string; reused: boolean }[] = [];
    const backup = vi.fn(() => Promise.resolve({ name: 'circletasks-pre-migration-v0001-to-v0003-20261009T080000Z.db' }));
    const port: MigrationBackup = { backup, findPrevious: () => Promise.resolve(null) };
    await expect(migrate(db, [m(1), m(2), m(3)].slice(0, 2), { beforeApply: createBackupBeforeMigration(port, clock, (b) => seen.push(b)) })).resolves.toBeDefined();
    expect(seen).toEqual([{ name: 'circletasks-pre-migration-v0001-to-v0003-20261009T080000Z.db', reused: false }]);

    const reuse = vi.fn(() => Promise.resolve({ name: 'x.db' }));
    const found: MigrationBackup = { backup: reuse, findPrevious: () => Promise.resolve({ name: 'circletasks-pre-migration-v0001-to-v0003-20261009T080000Z.db' }) };
    await migrate(db, [m(1), m(2), m(3)], { beforeApply: createBackupBeforeMigration(found, clock, (b) => seen.push(b)) });
    expect(reuse).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ name: 'circletasks-pre-migration-v0001-to-v0003-20261009T080000Z.db', reused: true });
    await db.close();
  });

  it('liste illisible : nouvelle sauvegarde (un doublon vaut mieux qu’aucune) et signalement (revue M4) ; échec de la copie : MigrationBackupError, rien de migré', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1)]);
    const backup = vi.fn(() => Promise.resolve({ name: 'n.db' }));
    const unreadable = vi.fn();
    await migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration({ backup, findPrevious: () => Promise.reject(new Error('liste illisible')) }, clock, () => undefined, unreadable) });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(unreadable).toHaveBeenCalledTimes(1);
    const failing: MigrationBackup = { backup: () => Promise.reject(new Error('disque plein')), findPrevious: () => Promise.resolve(null) };
    await expect(migrate(db, [m(1), m(2), m(3)], { beforeApply: createBackupBeforeMigration(failing, clock) })).rejects.toBeInstanceOf(MigrationBackupError);
    expect(await db.select('SELECT version FROM schema_migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }]);
    await db.close();
  });

  it('port d’avant I-06 (rien rendu) : migration faite, aucun nom (pas de restauration proposée)', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, [m(1)]);
    const seen: unknown[] = [];
    await migrate(db, [m(1), m(2)], { beforeApply: createBackupBeforeMigration({ backup: () => Promise.resolve() }, clock, (b) => seen.push(b)) });
    expect(seen).toEqual([]);
    await db.close();
  });
});
