import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import type { SqlDriver } from '../../db/driver';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { findUpdateBackup, type MigrationBackup } from '../../db/migrationBackup';
import { migrations } from '../../db/migrations';
import { migrate, type Migration } from '../../db/migrator';
import { t } from '../../i18n';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import type { BackupFailureReason } from '../../platform/backup';
import type { DbEnvironment } from '../../platform/dbDiagnostics';
import { useAppStore } from './appStore';
import { bootstrapDatabase } from './bootstrap';
import { DbFailureDetails, failureAlertKey } from './DbFailureDetails';
import { updateRestoreFailureText, type UpdateRestoreOutcome } from './updateRestore';

/**
 * I-06 QA : « tout échec durable est visible dans l'app, avec une action » : les vrais états d'échec produits par `bootstrapDatabase`
 * (migration, sauvegarde impossible, base plus récente, ouverture impossible) rendus par l'écran d'échec ; la sauvegarde proposée est bien
 * celle que le port a rendue ; une restauration en échec peut être relancée.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const LAST = migrations.at(-1)?.version ?? 0;
const ENV: DbEnvironment = { runtime: 'tauri', os: 'ios', buildPlatform: 'ios', appVersion: '0.3.0', paths: null, pathsError: null };
const readEnvironment = () => Promise.resolve(ENV);
const clock = createManualClock('2026-10-09T08:00:00.000Z');
const pad = (n: number): string => String(n).padStart(4, '0');
const BROKEN: Migration = { version: LAST + 1, name: 'test_i06_qa_broken', statements: ['INSTRUCTION INVALIDE'] };
const ADDITIVE: Migration = { version: LAST + 1, name: 'test_i06_qa_additive', statements: ['ALTER TABLE task ADD COLUMN i06_qa TEXT'] };

function keepOpen(db: SqlDriver): SqlDriver {
  return { kind: db.kind, execute: (s, p) => db.execute(s, p), select: (s, p) => db.select(s, p), transaction: (fn) => db.transaction(fn), close: () => Promise.resolve() };
}

function backupPort(options: { fail?: boolean } = {}) {
  const names: string[] = [];
  const port: MigrationBackup = {
    backup(request) {
      if (options.fail) return Promise.reject(new Error('disque plein'));
      const name = `circletasks-pre-migration-v${pad(request.fromVersion)}-to-v${pad(request.toVersion)}-${request.stamp}.db`;
      names.push(name);
      return Promise.resolve({ name });
    },
    findPrevious: (target) => Promise.resolve(findUpdateBackup(names, target)),
  };
  return { names, factory: () => Promise.resolve(port) };
}

async function dbAtN(): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations);
  return db;
}

beforeEach(() => {
  useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null, dbBackupFailed: false });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('navigator', { ...navigator, userAgent: IPHONE });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('états d’échec réels : un message qui dit quoi faire, Copier le détail, Réessayer', () => {
  type Case = { name: string; run: () => Promise<void>; alert: string; restore: boolean };
  const cases: Case[] = [
    {
      name: 'migration en échec',
      run: async () => void (await bootstrapDatabase(() => dbAtN().then(keepOpen), { clock, backup: backupPort().factory, migrations: [...migrations, BROKEN], appVersion: '0.3.0' })),
      alert: t('app.dbError'),
      restore: true,
    },
    {
      name: 'sauvegarde d’avant la mise à jour impossible',
      run: async () => void (await bootstrapDatabase(() => dbAtN().then(keepOpen), { clock, backup: backupPort({ fail: true }).factory, migrations: [...migrations, ADDITIVE], appVersion: '0.3.0' })),
      alert: t('app.dbBackupError'),
      restore: false,
    },
    {
      name: 'base plus récente que l’app',
      run: async () => {
        const db = await dbAtN();
        await migrate(db, [...migrations, ADDITIVE]);
        await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backupPort().factory, migrations, appVersion: '0.2.3' });
      },
      alert: t('app.update.schemaNewer'),
      restore: false,
    },
    {
      name: 'ouverture de la base impossible',
      run: async () => void (await bootstrapDatabase(() => Promise.reject(new Error('fichier verrouillé')), { clock, appVersion: '0.3.0' })),
      alert: t('app.dbError'),
      restore: false,
    },
  ];

  it.each(cases)('$name', async ({ run, alert, restore }) => {
    await run();
    const state = useAppStore.getState();
    expect(state.dbStatus).toBe('error');
    expect(state.dbFailure).not.toBeNull();
    const failure = state.dbFailure;
    if (!failure) return;
    // Le message de l'écran est celui attendu, jamais vide ni le message technique brut.
    const key = failureAlertKey(failure, state.dbBackupFailed);
    expect(t(key)).toBe(alert);
    expect(t(key)).not.toMatch(/inconnue de cette version|schema_migrations|SQLITE/i);
    render(<DbFailureDetails failure={failure} readEnvironment={readEnvironment} canRestore />);
    expect(screen.getByRole('button', { name: t('app.diag.retry') })).toBeEnabled();
    expect(screen.getByRole('button', { name: t('app.diag.copy') })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('db-failure-detail').textContent).toContain(t('app.update.appVersionLine', { version: failure.appVersion ?? '' })));
    if (restore) expect(await screen.findByRole('button', { name: tUpdateRestore('restore') })).toBeEnabled();
    else expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
    // Le diagnostic ne contient jamais de donnée de l'utilisateur.
    expect(screen.getByTestId('db-failure-detail').textContent).not.toMatch(/Rapport|Courses/);
  });

  it('même migration en échec deux fois : nouvelle sauvegarde au second essai (revue I1), la restauration proposée porte le nom de la dernière, pas un chemin', async () => {
    const backups = backupPort();
    const db = await dbAtN();
    await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, BROKEN], appVersion: '0.3.0' });
    useAppStore.setState({ dbStatus: 'idle', dbFailure: null });
    clock.advance(60_000);
    await bootstrapDatabase(() => Promise.resolve(keepOpen(db)), { clock, backup: backups.factory, migrations: [...migrations, BROKEN], appVersion: '0.3.0' });
    expect(backups.names).toHaveLength(2);
    const failure = useAppStore.getState().dbFailure;
    expect(failure?.updateBackup).toEqual({ name: backups.names[1] });
    expect(backups.names[1]).not.toBe(backups.names[0]);
    expect(failure?.updateBackup?.name).not.toMatch(/[\\/]/);
  });
});

describe('restauration depuis l’écran d’échec, de bout en bout avec la vraie sauvegarde du démarrage', () => {
  async function failed() {
    const backups = backupPort();
    await bootstrapDatabase(() => dbAtN().then(keepOpen), { clock, backup: backups.factory, migrations: [...migrations, BROKEN], appVersion: '0.3.0' });
    const failure = useAppStore.getState().dbFailure;
    if (!failure) throw new Error('échec attendu');
    return { failure, names: backups.names };
  }

  it('Restaurer demande la sauvegarde faite par ce démarrage (le nom rendu par le port de sauvegarde)', async () => {
    const { failure, names } = await failed();
    const restore = vi.fn((_name: string) => Promise.resolve({ ok: true } as UpdateRestoreOutcome));
    render(<DbFailureDetails failure={failure} readEnvironment={readEnvironment} canRestore restore={restore} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(names[0]);
  });

  it('échec de la restauration puis nouvel essai réussi : le message d’erreur reste lisible, l’action est relançable, l’annonce de progression revient', async () => {
    const { failure, names } = await failed();
    const restore = vi
      .fn<(name: string) => Promise<UpdateRestoreOutcome>>()
      .mockResolvedValueOnce({ ok: false, message: t('backup.errorIo'), code: 'io' })
      .mockResolvedValueOnce({ ok: true });
    render(<DbFailureDetails failure={failure} readEnvironment={readEnvironment} canRestore restore={restore} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('backup.errorCode', { code: 'io' }));
    expect(screen.getByRole('button', { name: tUpdateRestore('restore') })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(restore).toHaveBeenNthCalledWith(2, names[0]);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('le service de restauration qui lève une exception (au lieu de rendre un échec) : message d’erreur affiché, jamais de silence', async () => {
    const { failure } = await failed();
    const restore = vi.fn(() => Promise.reject(new Error('plantage du plugin')));
    render(<DbFailureDetails failure={failure} readEnvironment={readEnvironment} canRestore restore={restore as never} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(tUpdateRestore('restoreFailed', { reason: t('backup.errorIo') }));
    expect(screen.getByRole('button', { name: t('app.diag.copy') })).toBeInTheDocument();
  });
});

describe('restauration depuis l’écran d’échec : chaque raison d’échec de P-04 a son texte', () => {
  // Exhaustif à la compilation : une raison ajoutée à BackupFailureReason (par exemple par une fusion de main) manque ici, et au typage.
  const REASONS = {
    corrupt: true,
    'newer-schema': true,
    'not-found': true,
    io: true,
    'rollback-failed': true,
    'restore-pending': true,
    'restore-unconfirmed': true,
    'bad-name': true,
    unavailable: true,
    'sync-busy': true,
    busy: true,
    'db-open': true,
  } satisfies Record<BackupFailureReason, true>;

  it.each(Object.keys(REASONS) as BackupFailureReason[])('raison %s : un texte lisible, jamais « undefined » ni une clé brute', (reason) => {
    for (const closed of [false, true]) {
      const text = updateRestoreFailureText(reason, closed);
      expect(typeof text, `${reason}/${String(closed)}`).toBe('string');
      expect(text.trim().length).toBeGreaterThan(10);
      expect(text).not.toMatch(/undefined|^backup.|{w+}/);
    }
  });
});
