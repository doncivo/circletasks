import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { LocalDate, SpaceId, TaskId } from '../../../src/domain/types';
import type { SqlDriver, SqlRow } from '../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../src/db/drivers/sqliteWasm';
import { findUpdateBackup, type MigrationBackup } from '../../../src/db/migrationBackup';
import { migrations } from '../../../src/db/migrations';
import type { Migration } from '../../../src/db/migrator';
import { createSqlRepositories, type RepositoryFactory } from '../../../src/db/repositories';
import { SPACE_PRO_ID } from '../../../src/db/seed/defaultSpaces';
import { useAppStore } from '../../../src/features/app/appStore';
import { bootstrapApp, type BootstrapAppOptions } from '../../../src/features/app/bootstrap';
import type { AppContainer } from '../../../src/features/app/container';
import type { AppVersionRead } from '../../../src/platform/appVersion';
import { createUnavailableBackup } from '../../../src/platform/backup';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS } from '../../../src/platform/calendars';
import { createUnavailableFiles } from '../../../src/platform/files';

/**
 * I-06 QA : états d'erreur de la mise à jour que les tests du dev ne couvrent pas (critères 9, 12, 13, 16).
 * - mise à jour interrompue à chaque étape (avant la 1re migration, au milieu de chacune, entre deux, avant la mémorisation de la version) ;
 * - sauvegarde d'avant la mise à jour impossible puis rétablie ;
 * - mémorisation de la version impossible : démarrage normal, mais la trace reste (journal) et la mise à jour est reprise comme telle.
 * Un « processus » = un appel à `bootstrapApp` sur le même fichier de base (la connexion fermée par un échec est simulée par `keepOpen`).
 */

const LAST = migrations.at(-1)?.version ?? 0;
const pad = (n: number): string => String(n).padStart(4, '0');
const common = { desktop: null, focusWindow: null, files: createUnavailableFiles(), calendars: createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS), backups: createUnavailableBackup(), syncPlatform: null } as const;
const version = (v: string): (() => Promise<AppVersionRead>) => () => Promise.resolve({ ok: true, version: v, source: 'runtime' });
const clock = createManualClock('2026-10-09T08:00:00.000Z');

/** Trois migrations additives de test (fixtures, jamais livrées) : N+1, N+2, N+3. */
const STEPS: readonly Migration[] = [
  { version: LAST + 1, name: 'test_i06_qa_a', statements: ['ALTER TABLE task ADD COLUMN i06_a TEXT', 'ALTER TABLE task ADD COLUMN i06_a2 TEXT'] },
  { version: LAST + 2, name: 'test_i06_qa_b', statements: ['CREATE TABLE i06_b (id INTEGER PRIMARY KEY)', 'CREATE INDEX i06_b_id ON i06_b (id)'] },
  { version: LAST + 3, name: 'test_i06_qa_c', statements: ['ALTER TABLE task ADD COLUMN i06_c TEXT'] },
];
const NEXT: readonly Migration[] = [...migrations, ...STEPS];
const ADDED = ['i06_a', 'i06_a2', 'i06_c'];

function keepOpen(db: SqlDriver): SqlDriver {
  return { kind: db.kind, execute: (sql, params) => db.execute(sql, params), select: (sql, params) => db.select(sql, params), transaction: (fn) => db.transaction(fn), close: () => Promise.resolve() };
}

/** Fermeture simulée : le processus « meurt » quand la condition est vraie pour une instruction d'une transaction de migration (annulée). */
function dieOn(db: SqlDriver, die: (sql: string, params?: readonly unknown[]) => boolean): SqlDriver {
  const guard = (sql: string, params?: readonly unknown[]): void => {
    if (die(sql, params)) throw new Error('processus interrompu');
  };
  return {
    ...keepOpen(db),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          select: (sql, params) => tx.select(sql, params),
          execute: (sql, params) => {
            guard(sql, params);
            return tx.execute(sql, params);
          },
        }),
      ),
  };
}

function fakeBackups(db: SqlDriver, options: { fail?: () => boolean } = {}) {
  const names: string[] = [];
  const requests: { fromVersion: number; toVersion: number; stamp: string }[] = [];
  const port: MigrationBackup = {
    backup(request) {
      requests.push({ ...request });
      if (options.fail?.()) return Promise.reject(new Error('disque plein'));
      const name = `circletasks-pre-migration-v${pad(request.fromVersion)}-to-v${pad(request.toVersion)}-${request.stamp}.db`;
      names.push(name);
      return Promise.resolve({ name });
    },
    findPrevious: (target) => Promise.resolve(findUpdateBackup(names, target)),
  };
  void db;
  return { names, requests, factory: () => Promise.resolve(port) };
}

async function boot(db: SqlDriver, options: Partial<BootstrapAppOptions> & { readonly v: string }): Promise<AppContainer | undefined> {
  const { v, ...rest } = options;
  return bootstrapApp({ ...common, clock, open: () => Promise.resolve(keepOpen(db)), appVersion: version(v), ...rest });
}

async function populatedAtN(): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  const n = await boot(db, { v: '0.2.3' });
  if (!n) throw new Error('démarrage N impossible');
  await n.data.repos.tasks.create({ id: '11111111-1111-4111-8111-111111111111' as TaskId, spaceId: SPACE_PRO_ID as SpaceId, projectId: null, title: 'Avant', note: 'n', date: '2026-10-09' as LocalDate, time: null, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null });
  await n.data.repos.settings.set('ui.theme', 'dark');
  await db.execute('DELETE FROM sync_outbox');
  return db;
}

async function snapshot(db: SqlDriver): Promise<Record<string, SqlRow[]>> {
  const tables = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%' AND name NOT IN ('schema_migrations', 'i06_b') ORDER BY name");
  const out: Record<string, SqlRow[]> = {};
  for (const { name } of tables) {
    out[name] = (await db.select(`SELECT * FROM "${name}" ORDER BY rowid`)).map((row) => {
      const copy: SqlRow = { ...row };
      for (const column of ADDED) Reflect.deleteProperty(copy, column);
      return name === 'settings' && copy['key'] === 'app.lastLaunchedVersion' ? { key: copy['key'] } : copy;
    });
  }
  return out;
}

const applied = async (db: SqlDriver): Promise<number[]> => (await db.select<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
const columns = async (db: SqlDriver): Promise<string[]> => (await db.select<{ name: string }>('PRAGMA table_info(task)')).map((c) => c.name);
const tables = async (db: SqlDriver): Promise<string[]> => (await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
const lastLaunched = async (db: SqlDriver): Promise<unknown> => {
  const raw = (await db.select<{ value: string }>("SELECT value FROM settings WHERE key = 'app.lastLaunchedVersion'"))[0]?.value;
  return raw === undefined ? null : JSON.parse(raw);
};

let warn: ReturnType<typeof vi.spyOn>;
const logged = (): string[] => warn.mock.calls.map((call: unknown[]) => String(call[0]));

beforeEach(() => {
  useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null, dbBackupFailed: false });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('critère 12 (QA) : mise à jour interrompue à chaque étape', () => {
  // Le processus meurt pendant la migration k, au moment d'enregistrer son numéro (instructions déjà jouées, transaction annulée).
  // Revue I-06 (I1) : la sauvegarde n'est réutilisée que si au moins une migration de la chaîne a été validée (k > 1) ; mort pendant la
  // migration 1 = rien de validé : une nouvelle sauvegarde de la même base est faite (un doublon, jamais une sauvegarde périmée).
  it.each([1, 2, 3])('mort pendant la migration %i : la migration n’est pas à moitié faite, le redémarrage reprend, sauvegarde réutilisée si la chaîne a avancé', async (k) => {
    const db = await populatedAtN();
    const before = await snapshot(db);
    const backups = fakeBackups(db);
    const target = LAST + k;
    const dying = dieOn(db, (sql, params) => sql.includes('INSERT INTO schema_migrations') && params?.[0] === target);

    expect(await bootstrapApp({ ...common, clock, open: () => Promise.resolve(dying), appVersion: version('0.3.0'), migrations: NEXT, backup: backups.factory })).toBeUndefined();
    // Chaque migration est transactionnelle : les migrations 1..k-1 sont validées, la k est annulée en entier (aucune colonne, table ni index à moitié).
    expect(await applied(db)).toEqual([...migrations.map((m) => m.version), ...STEPS.slice(0, k - 1).map((m) => m.version)]);
    const cols = await columns(db);
    expect(cols.includes('i06_a')).toBe(k > 1);
    expect(cols.includes('i06_a2')).toBe(k > 1);
    expect((await tables(db)).includes('i06_b')).toBe(k > 2);
    expect(cols.includes('i06_c')).toBe(false);
    // Pas de version mémorisée tant que la mise à jour n'est pas finie ; l'écran d'échec nomme l'étape et la sauvegarde.
    expect(await lastLaunched(db)).toBe('0.2.3');
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error', dbBackupFailed: false, dbFailure: { kind: 'migration', migration: target, schemaVersion: target - 1, updateBackup: { name: backups.names[0] } } });
    expect(logged()).toContain(`[desktop:db] migration ${String(target)} impossible (Error)`);

    // Démarrage suivant : reprise à la migration k ; sauvegarde réutilisée si la chaîne a avancé (k > 1), sinon refaite ; aucune ligne perdue.
    useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null });
    const container = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory });
    expect(container?.launch).toBe('updated');
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    expect(backups.requests).toHaveLength(k > 1 ? 1 : 2);
    expect(backups.names).toHaveLength(k > 1 ? 1 : 2);
    expect(await lastLaunched(db)).toBe('0.3.0');
    expect(await snapshot(db)).toEqual(before);
    await db.close();
  });

  it('mort juste après la sauvegarde, avant la première migration : nouvelle sauvegarde au redémarrage (rien de validé, revue I1), version non mémorisée entre-temps', async () => {
    const db = await populatedAtN();
    const backups = fakeBackups(db);
    const dying = dieOn(db, () => true);
    expect(await bootstrapApp({ ...common, clock, open: () => Promise.resolve(dying), appVersion: version('0.3.0'), migrations: NEXT, backup: backups.factory })).toBeUndefined();
    expect(await applied(db)).toEqual(migrations.map((m) => m.version));
    expect(backups.names).toHaveLength(1);
    expect(await lastLaunched(db)).toBe('0.2.3');
    expect((await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory }))?.launch).toBe('updated');
    expect(backups.requests).toHaveLength(2);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    await db.close();
  });

  it('migrations toutes finies mais version non mémorisée (processus tué avant l’écriture) : ni migration ni sauvegarde au lancement suivant, toujours « mise à jour »', async () => {
    const db = await populatedAtN();
    const backups = fakeBackups(db);
    // Écriture de la version refusée : le démarrage réussit quand même (jamais bloquant), la trace est dans le journal technique.
    const failing: RepositoryFactory = (executor, stamper) => {
      const repos = createSqlRepositories(executor, stamper);
      return { ...repos, settings: { ...repos.settings, set: (key, value) => (key === 'app.lastLaunchedVersion' ? Promise.reject(new Error('disque plein')) : repos.settings.set(key, value)) } };
    };
    const first = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory, repositories: failing });
    expect(first?.launch).toBe('updated');
    expect(useAppStore.getState().dbStatus).toBe('ready');
    expect(logged().some((line) => line.includes('launch-version-unwritable (Error)'))).toBe(true);
    expect(await lastLaunched(db)).toBe('0.2.3');
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));

    const second = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory });
    expect(second?.launch).toBe('updated');
    expect(backups.requests).toHaveLength(1);
    expect(await lastLaunched(db)).toBe('0.3.0');
    expect((await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory }))?.launch).toBe('same');
    await db.close();
  });
});

describe('critère 13 (QA) : sauvegarde d’avant la mise à jour impossible', () => {
  it('disque plein : aucune migration, base intacte, écran « sauvegarde impossible » ; une fois la place faite, la mise à jour se fait avec sa sauvegarde', async () => {
    const db = await populatedAtN();
    const before = await snapshot(db);
    let full = true;
    const backups = fakeBackups(db, { fail: () => full });
    expect(await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory })).toBeUndefined();
    expect(await applied(db)).toEqual(migrations.map((m) => m.version));
    expect(await snapshot(db)).toEqual(before);
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error', dbBackupFailed: true, dbFailure: { kind: 'backup', step: 'backup', appVersion: '0.3.0', updateBackup: null } });
    expect(await lastLaunched(db)).toBe('0.2.3');

    full = false;
    useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null, dbBackupFailed: false });
    const container = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory });
    expect(container?.launch).toBe('updated');
    expect(useAppStore.getState().dbBackupFailed).toBe(false);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    expect(backups.names).toHaveLength(1);
    expect(await snapshot(db)).toEqual(before);
    await db.close();
  });

  it('la liste des sauvegardes illisible (findPrevious en échec) ne bloque pas : une sauvegarde est refaite avant de migrer', async () => {
    const db = await populatedAtN();
    const backups = fakeBackups(db);
    const port: MigrationBackup = { backup: (request) => (backups.factory() as Promise<MigrationBackup>).then((p) => p.backup(request)), findPrevious: () => Promise.reject(new Error('liste illisible')) };
    expect((await boot(db, { v: '0.3.0', migrations: NEXT, backup: () => Promise.resolve(port) }))?.launch).toBe('updated');
    expect(backups.requests).toHaveLength(1);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    await db.close();
  });
});

describe('critère 16 (QA) : numéros incohérents', () => {
  it('version mémorisée illisible : comptée comme une mise à jour, jamais d’exception ; version courante illisible : rien n’est écrit, rien n’est cassé', async () => {
    const db = await populatedAtN();
    await db.execute("UPDATE settings SET value = '\"abc\"' WHERE key = 'app.lastLaunchedVersion'");
    expect((await boot(db, { v: '0.3.0' }))?.launch).toBe('updated');
    expect(await lastLaunched(db)).toBe('0.3.0');
    const unreadable = await bootstrapApp({ ...common, clock, open: () => Promise.resolve(keepOpen(db)), appVersion: () => Promise.resolve({ ok: false, version: null }) });
    expect(unreadable?.launch).toBe('unknown');
    expect(await lastLaunched(db)).toBe('0.3.0');
    await db.close();
  });

  it('retour à une IPA plus ancienne dont le schéma est le même : aucune sauvegarde, aucune migration, version mémorisée corrigée', async () => {
    const db = await populatedAtN();
    await db.execute("UPDATE settings SET value = '\"0.4.0\"' WHERE key = 'app.lastLaunchedVersion'");
    const backups = fakeBackups(db);
    const container = await boot(db, { v: '0.3.0', backup: backups.factory });
    expect(container?.launch).toBe('downgraded');
    expect(backups.requests).toEqual([]);
    expect(await lastLaunched(db)).toBe('0.3.0');
    await db.close();
  });
});
