import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { DbStepError, JournalModeError, describeError } from '../../db/errorText';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
import { t } from '../../i18n';
import { openDatabase } from '../../platform/database';
import type { DbEnvironment } from '../../platform/dbDiagnostics';
import type { SyncPlatform } from '../../platform/sync/types';
import { useAppStore, type DbFailure } from './appStore';
import { bootstrapApp, bootstrapDatabase } from './bootstrap';
import { DbFailureDetails, formatDbFailure } from './DbFailureDetails';

const reset = () => useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbBackupFailed: false, dbFailure: null });
const failure = () => useAppStore.getState().dbFailure;

describe('0.2.1 diagnostic : étape de l’ouverture qui a échoué', () => {
  beforeEach(() => {
    reset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('Database.load : étape « load » et message exact de Tauri (chaîne rejetée)', async () => {
    await bootstrapDatabase(() => Promise.reject(new DbStepError('load', 'error returned from database: (code: 14) unable to open database file')));
    expect(failure()).toMatchObject({ phase: 'open', step: 'load', errorName: 'string', message: 'error returned from database: (code: 14) unable to open database file' });
    expect(useAppStore.getState().dbErrorDetail).toBe('error returned from database: (code: 14) unable to open database file');
  });

  it('PRAGMA : étape « pragma »', async () => {
    await bootstrapDatabase(() => Promise.reject(new DbStepError('pragma', new Error('database is locked'))));
    expect(failure()).toMatchObject({ step: 'pragma', errorName: 'Error', message: 'database is locked' });
  });

  it('isTauri() faux dans un build Tauri : étape « runtime », dit explicitement', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'ios');
    await bootstrapDatabase(() => openDatabase('web'));
    expect(failure()).toMatchObject({ step: 'runtime' });
    expect(failure()?.message).toContain('isTauri() est faux dans un build Tauri (ios)');
  });

  it('lecture du schéma (ensureMigrationsTable) : étape « schema »', async () => {
    const db = await openSqliteWasmDriver();
    const execute = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((sql, params) => (sql.includes('schema_migrations') ? Promise.reject(new Error('disk I/O error')) : execute(sql, params)));
    await bootstrapDatabase(() => Promise.resolve(db));
    expect(failure()).toMatchObject({ step: 'schema', message: 'disk I/O error' });
  });

  it('sauvegarde avant migration : étape « backup », objet Rust rendu en entier (jamais [object Object])', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 1));
    await bootstrapDatabase(() => Promise.resolve(db), {
      backup: () => Promise.resolve({ backup: () => Promise.reject({ code: 'io', message: 'No space left on device' }) }),
    });
    expect(failure()).toMatchObject({ step: 'backup', errorName: 'MigrationBackupError' });
    expect(failure()?.message).toContain('"message":"No space left on device"');
    expect(useAppStore.getState().dbBackupFailed).toBe(true);
  });

  it('migration N : étape « migration » avec son numéro', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 2));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(new Error('no such column: space_id'))).mockImplementation(transaction);
    await bootstrapDatabase(() => Promise.resolve(db), { backup: () => Promise.resolve(undefined) });
    expect(failure()).toMatchObject({ step: 'migration', migration: 3, message: 'no such column: space_id' });
  });

  it('0.2.2 : un échec base ouverte joint le mode de journal effectif (lu avant la fermeture) ; base non ouverte : absent', async () => {
    const db = await openSqliteWasmDriver();
    const select = db.select.bind(db);
    vi.spyOn(db, 'select').mockImplementation((sql, params) => (sql === 'PRAGMA journal_mode' ? Promise.resolve([{ journal_mode: 'delete' }] as never) : select(sql, params)));
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('database is locked'));
    await bootstrapDatabase(() => Promise.resolve(db), { backup: () => Promise.resolve(undefined) });
    expect(failure()).toMatchObject({ step: 'migration', journalMode: 'delete' });

    reset();
    await bootstrapDatabase(() => Promise.reject(new DbStepError('pragma', new JournalModeError('delete'))));
    expect(failure()).toMatchObject({ step: 'pragma', message: 'journal-mode: expected wal, got delete', journalMode: 'delete' });
    expect(formatDbFailure(failure() as DbFailure, ENV)).toContain(t('app.diag.journalExpected'));

    reset();
    await bootstrapDatabase(() => Promise.reject(new DbStepError('load', 'x')));
    expect(failure()).not.toHaveProperty('journalMode');
  });

  it('chaîne de causes : le message garde la cause', () => {
    expect(describeError(new Error('haut', { cause: new Error('bas') }))).toBe('haut (cause : bas)');
    expect(describeError('x'.repeat(5000))).toHaveLength(4001);
  });
});

describe('0.2.1 diagnostic : démarrage après l’ouverture (app.startError)', () => {
  beforeEach(() => {
    reset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('module en échec nommé, avec Error.name et message', async () => {
    const broken = {
      available: () => {
        throw new TypeError('plugin folder-bookmark absent');
      },
    } as unknown as SyncPlatform;
    const result = await bootstrapApp({ open: openSqliteWasmDriver, desktop: null, focusWindow: null, syncPlatform: broken });
    expect(result).toBeUndefined();
    expect(failure()).toEqual({ phase: 'start', step: 'syncPlatform.available', errorName: 'TypeError', message: 'plugin folder-bookmark absent' });
  });

  it('première étape en échec : étape posée avant l’appel', async () => {
    const result = await bootstrapApp({
      open: openSqliteWasmDriver,
      repositories: () => {
        throw new RangeError('fabrique indisponible');
      },
    });
    expect(result).toBeUndefined();
    expect(failure()).toMatchObject({ phase: 'start', step: 'repositories', errorName: 'RangeError' });
  });
});

const ENV: DbEnvironment = {
  runtime: 'tauri',
  os: 'ios',
  buildPlatform: 'ios',
  appVersion: '0.2.1',
  paths: { configDir: '/var/mobile/X/Library/Application Support/fr.ct', configDirError: null, dirExists: true, dbPath: '/var/mobile/X/Library/Application Support/fr.ct/circletasks.db', fileExists: false, fileBytes: null, walExists: false },
  pathsError: null,
};

const LOAD_FAILURE: DbFailure = { phase: 'open', step: 'load', errorName: 'string', message: 'm1' };
const MIGRATION_FAILURE: DbFailure = { phase: 'open', step: 'migration', migration: 7, errorName: 'Error', message: 'm5' };

const OPEN_CASES: readonly [DbFailure, string][] = [
  [LOAD_FAILURE, t('app.diag.steps.load')],
  [{ phase: 'open', step: 'pragma', errorName: 'Error', message: 'm2' }, t('app.diag.steps.pragma')],
  [{ phase: 'open', step: 'schema', errorName: 'Error', message: 'm3' }, t('app.diag.steps.schema')],
  [{ phase: 'open', step: 'backup', errorName: 'MigrationBackupError', message: 'm4' }, t('app.diag.steps.backup')],
  [MIGRATION_FAILURE, t('app.diag.steps.migration', { version: '7' })],
  [{ phase: 'open', step: 'afterApply', errorName: 'Error', message: 'm6' }, t('app.diag.steps.afterApply')],
  [{ phase: 'open', step: 'runtime', errorName: 'Error', message: 'm7' }, t('app.diag.steps.runtime')],
  [{ phase: 'open', step: 'other', errorName: 'Error', message: 'm8' }, t('app.diag.steps.other')],
  [{ phase: 'start', step: 'openNotificationScheduler', errorName: 'TypeError', message: 'm9' }, t('app.diag.steps.start', { name: 'openNotificationScheduler' })],
];

describe('0.2.1 diagnostic : affichage et copie', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(OPEN_CASES)('affiche l’étape et le message exact (%#)', async (item, label) => {
    render(<DbFailureDetails failure={item} readEnvironment={() => Promise.resolve(ENV)} />);
    const detail = screen.getByTestId('db-failure-detail');
    expect(detail).toHaveTextContent(t('app.diag.step', { step: label }));
    expect(detail).toHaveTextContent(t('app.diag.error', { name: item.errorName, message: item.message }));
    expect(detail).toHaveTextContent('sqlite:circletasks.db');
    await waitFor(() => expect(detail).toHaveTextContent('/var/mobile/X/Library/Application Support/fr.ct/circletasks.db'));
  });

  it('0.2.2 : le mode de journal effectif est affiché, « inconnu » s’il est illisible, rien si la base n’était pas ouverte', () => {
    expect(formatDbFailure({ ...MIGRATION_FAILURE, journalMode: 'delete' }, ENV)).toContain(t('app.diag.journalMode', { mode: 'delete' }));
    expect(formatDbFailure({ ...MIGRATION_FAILURE, journalMode: null }, ENV)).toContain(t('app.diag.journalMode', { mode: t('app.diag.unknown') }));
    expect(formatDbFailure(LOAD_FAILURE, ENV)).not.toContain(t('app.diag.journalMode', { mode: '' }));
  });

  it('chemins indisponibles : le message de la commande est affiché', () => {
    const text = formatDbFailure(LOAD_FAILURE, { ...ENV, paths: null, pathsError: 'Command db_diagnostics not found' });
    expect(text).toContain(t('app.diag.pathsError', { message: 'Command db_diagnostics not found' }));
  });

  it('« Copier le détail » copie le texte affiché', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={() => Promise.resolve(ENV)} />);
    await waitFor(() => expect(screen.getByTestId('db-failure-detail')).toHaveTextContent('circletasks.db (existe'));
    fireEvent.click(screen.getByRole('button', { name: t('app.diag.copy') }));
    expect(await screen.findByRole('status')).toHaveTextContent(t('app.diag.copied'));
    expect(writeText).toHaveBeenCalledWith(screen.getByTestId('db-failure-detail').textContent);
  });

  it('copie impossible : invite à sélectionner le texte', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    render(<DbFailureDetails failure={LOAD_FAILURE} readEnvironment={() => Promise.resolve(ENV)} />);
    fireEvent.click(screen.getByRole('button', { name: t('app.diag.copy') }));
    expect(await screen.findByRole('status')).toHaveTextContent(t('app.diag.copyFailed'));
  });
});
