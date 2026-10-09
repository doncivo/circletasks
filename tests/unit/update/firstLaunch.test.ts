import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { LocalDate, ProjectId, RoutineId, SpaceId, TaskId } from '../../../src/domain/types';
import type { SqlDriver, SqlRow } from '../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../src/db/drivers/sqliteWasm';
import { findUpdateBackup, type MigrationBackup, type MigrationBackupRequest } from '../../../src/db/migrationBackup';
import { migrations } from '../../../src/db/migrations';
import type { Migration } from '../../../src/db/migrator';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../../src/db/seed/defaultSpaces';
import { useAppStore } from '../../../src/features/app/appStore';
import { bootstrapApp, type BootstrapAppOptions } from '../../../src/features/app/bootstrap';
import type { AppContainer } from '../../../src/features/app/container';
import type { AppVersionRead } from '../../../src/platform/appVersion';
import { createUnavailableBackup } from '../../../src/platform/backup';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS } from '../../../src/platform/calendars';
import { createUnavailableFiles } from '../../../src/platform/files';

/**
 * I-06 critères 6, 9, 12, 13, 14 et 16 (ADR 0007 avenant I-06 points 1, 4, 6 et 7) : premier lancement de N+1 sur une base peuplée en N,
 * sans perte ; mise à jour interrompue ; migration en échec ; base plus récente que l'app ; retour à une version plus ancienne.
 * « N » = migrations de l'app ; « N+1 » = les mêmes plus une migration additive de test (fixture, jamais livrée).
 */

const LAST = migrations.at(-1)?.version ?? 0;
const pad = (n: number): string => String(n).padStart(4, '0');
const ADDITIVE: Migration = { version: LAST + 1, name: 'test_i06_additive', statements: ['ALTER TABLE task ADD COLUMN i06_note TEXT'] };
const NEXT = [...migrations, ADDITIVE];
const common = { desktop: null, focusWindow: null, files: createUnavailableFiles(), calendars: createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS), backups: createUnavailableBackup(), syncPlatform: null } as const;
const version = (v: string): (() => Promise<AppVersionRead>) => () => Promise.resolve({ ok: true, version: v, source: 'runtime' });

/** Base qui survit aux échecs (le démarrage ferme la connexion en cas d'échec) : chaque démarrage est un nouveau processus sur le même fichier. */
function keepOpen(db: SqlDriver): SqlDriver {
  return { kind: db.kind, execute: (sql, params) => db.execute(sql, params), select: (sql, params) => db.select(sql, params), transaction: (fn) => db.transaction(fn), close: () => Promise.resolve() };
}

/** Faux port de sauvegarde avant migration : noms de fichiers comme Rust, liste relue par `findPrevious`. */
function fakeBackups(db: SqlDriver, fail = false) {
  const names: string[] = [];
  const requests: (MigrationBackupRequest & { readonly columnPresent: boolean })[] = [];
  const port: MigrationBackup = {
    async backup(request) {
      const columns = await db.select<{ name: string }>('PRAGMA table_info(task)');
      requests.push({ ...request, columnPresent: columns.some((c) => c.name === 'i06_note') });
      if (fail) throw new Error('disque plein');
      const name = `circletasks-pre-migration-v${pad(request.fromVersion)}-to-v${pad(request.toVersion)}-${request.stamp}.db`;
      names.push(name);
      return { name };
    },
    findPrevious: (target) => Promise.resolve(findUpdateBackup(names, target)),
  };
  return { names, requests, factory: () => Promise.resolve(port) };
}

const clock = createManualClock('2026-10-09T08:00:00.000Z');

async function boot(db: SqlDriver, options: Partial<BootstrapAppOptions> & { readonly v: string }): Promise<AppContainer | undefined> {
  const { v, ...rest } = options;
  return bootstrapApp({ ...common, clock, open: () => Promise.resolve(keepOpen(db)), appVersion: version(v), ...rest });
}

/** Base « N » peuplée par l'app 0.2.3 : tâches dans les deux espaces, routine, projet, réglages, champ gardé dans sync_unknown. */
async function populatedAtN(): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  const n = await boot(db, { v: '0.2.3' });
  if (!n) throw new Error('démarrage N impossible');
  const { repos } = n.data;
  const task = (id: string, spaceId: SpaceId, title: string) =>
    repos.tasks.create({ id: id as TaskId, spaceId, projectId: null, title, note: 'note', date: '2026-10-09' as LocalDate, time: '09:30' as never, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null });
  await task('11111111-1111-4111-8111-111111111111', SPACE_PRO_ID, 'Rapport trimestriel');
  await task('22222222-2222-4222-8222-222222222222', SPACE_PERSO_ID, 'Courses');
  await repos.routines.create({ id: '33333333-3333-4333-8333-333333333333' as RoutineId, spaceId: SPACE_PERSO_ID, title: 'Lire', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-10-01', time: null, archived: false } as never);
  await repos.projects.create({ id: '44444444-4444-4444-8444-444444444444' as ProjectId, spaceId: SPACE_PRO_ID, name: 'Projet', color: '#123456' as never, archived: false, sortOrder: 1 });
  await repos.settings.set('ui.theme', 'dark');
  await repos.settings.set('spaces.filter', SPACE_PERSO_ID);
  await repos.settings.set('security.appLock', true);
  await db.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', '99999999-0000-4000-8000-000000000009', 'futur', '1', ?, NULL, 99)", [`00${String(Date.parse('2026-10-09T08:00:00.000Z'))}-0000-${'a'.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`]);
  await db.execute('DELETE FROM sync_outbox');
  return db;
}

/** Contenu de chaque table (hors suivi des migrations et index de recherche reconstruits), colonne de test retirée. */
async function snapshot(db: SqlDriver): Promise<Record<string, SqlRow[]>> {
  const tables = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%' AND name <> 'schema_migrations' ORDER BY name");
  const out: Record<string, SqlRow[]> = {};
  for (const { name } of tables) {
    const rows = await db.select(`SELECT * FROM "${name}" ORDER BY rowid`);
    out[name] = rows.map((row) => {
      const copy: SqlRow = { ...row };
      delete copy['i06_note'];
      // Seule ligne qui change à dessein : la version du dernier lancement (comparée à part).
      return name === 'settings' && copy['key'] === 'app.lastLaunchedVersion' ? { key: copy['key'] } : copy;
    });
  }
  return out;
}

const applied = async (db: SqlDriver): Promise<number[]> => (await db.select<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
const lastLaunched = async (db: SqlDriver): Promise<unknown> => (await db.select<{ value: string }>("SELECT value FROM settings WHERE key = 'app.lastLaunchedVersion'"))[0]?.value ?? null;

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

describe('critère 9 : premier lancement de N+1 sans perte', () => {
  it('une sauvegarde avant la première migration, migrations dans l’ordre, mêmes lignes, réglages identiques, file vide, version mémorisée', async () => {
    const db = await populatedAtN();
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.2.3');
    const before = await snapshot(db);
    const backups = fakeBackups(db);

    const container = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory });
    expect(container).toBeDefined();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    expect(container?.launch).toBe('updated');
    // Sauvegarde « Avant mise à jour » : une seule, AVANT la migration (la colonne n'existe pas encore pendant la copie).
    expect(backups.requests).toEqual([{ fromVersion: LAST, toVersion: LAST + 1, stamp: '20261009T080000Z', columnPresent: false }]);
    expect(backups.names).toEqual([`circletasks-pre-migration-v${pad(LAST)}-to-v${pad(LAST + 1)}-20261009T080000Z.db`]);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    // Mêmes lignes partout (comptage et contenu), hors colonne ajoutée ; réglages (device.id, filtre, thème, verrou) inchangés.
    expect(await snapshot(db)).toEqual(before);
    expect(await container?.data.repos.settings.get('ui.theme')).toBe('dark');
    expect(await container?.data.repos.settings.get('spaces.filter')).toBe(SPACE_PERSO_ID);
    expect(await container?.data.repos.settings.get('security.appLock')).toBe(true);
    expect(await db.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.3.0');
    expect(logged()).toContain('[desktop:app] app-updated 0.2.3 0.3.0');

    // Deuxième démarrage : ni sauvegarde, ni migration, ni « app-updated ».
    warn.mockClear();
    const again = await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory });
    expect(again?.launch).toBe('same');
    expect(backups.requests).toHaveLength(1);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    expect(logged().some((line) => line.includes('app-updated'))).toBe(false);
    await db.close();
  });

  it('installation existante d’avant I-06 (aucune version mémorisée) : comptée comme une mise à jour ; base neuve : première installation', async () => {
    const db = await populatedAtN();
    await db.execute("DELETE FROM settings WHERE key = 'app.lastLaunchedVersion'");
    expect((await boot(db, { v: '0.3.0' }))?.launch).toBe('updated');
    expect(logged()).toContain('[desktop:app] app-updated ? 0.3.0');
    await db.close();
    const fresh = await openSqliteWasmDriver();
    expect((await boot(fresh, { v: '0.3.0' }))?.launch).toBe('first-install');
    expect(JSON.parse(String(await lastLaunched(fresh)))).toBe('0.3.0');
    await fresh.close();
  });
});

describe('critère 6 : version publiée par la synchro, PC et iPhone', () => {
  it('version illisible : démarrage normal, rien n’est mémorisé, journal au code seul', async () => {
    const db = await populatedAtN();
    const container = await bootstrapApp({ ...common, clock, open: () => Promise.resolve(keepOpen(db)), appVersion: () => Promise.resolve({ ok: false, version: null }) });
    expect(container?.launch).toBe('unknown');
    expect(container?.appVersion).toEqual({ ok: false, version: null });
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.2.3');
    await db.close();
  });
});

describe('critère 12 : mise à jour interrompue', () => {
  it('reprise à la migration suivante, sauvegarde réutilisée (pas de doublon), version mémorisée seulement à la fin, aucune ligne perdue', async () => {
    const db = await populatedAtN();
    const before = await snapshot(db);
    const first: Migration = { version: LAST + 1, name: 'test_i06_a', statements: ['ALTER TABLE task ADD COLUMN i06_note TEXT'] };
    const second: Migration = { version: LAST + 2, name: 'test_i06_b', statements: ['CREATE TABLE i06_b (id INTEGER PRIMARY KEY)'] };
    // Fermeture simulée au milieu : la 2e migration échoue cette fois (table déjà là), la 1re est validée.
    await db.execute('CREATE TABLE i06_b (x TEXT)');
    const backups = fakeBackups(db);
    expect(await boot(db, { v: '0.3.0', migrations: [...migrations, first, second], backup: backups.factory })).toBeUndefined();
    expect(await applied(db)).toEqual([...migrations.map((m) => m.version), LAST + 1]);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.2.3');
    expect(useAppStore.getState().dbFailure).toMatchObject({ kind: 'migration', migration: LAST + 2, schemaVersion: LAST + 1, appSchemaVersion: LAST + 2, updateBackup: { name: backups.names[0] } });

    await db.execute('DROP TABLE i06_b');
    const container = await boot(db, { v: '0.3.0', migrations: [...migrations, first, second], backup: backups.factory });
    expect(container?.launch).toBe('updated');
    expect(await applied(db)).toEqual([...migrations.map((m) => m.version), LAST + 1, LAST + 2]);
    // Une seule sauvegarde « Avant mise à jour » (vN-to-vN+2), réutilisée à la reprise (fromVersion N+1).
    expect(backups.requests).toHaveLength(1);
    expect(backups.names).toHaveLength(1);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.3.0');
    expect(await snapshot(db)).toEqual({ ...before, i06_b: [] });
    await db.close();
  });
});

describe('critère 13 : migration en échec après la mise à jour', () => {
  it('base restée en N, étape, erreur, versions, sauvegarde de ce démarrage ; journal sans contenu', async () => {
    const db = await populatedAtN();
    const before = await snapshot(db);
    const broken: Migration = { version: LAST + 1, name: 'test_i06_broken', statements: ['ALTER TABLE task ADD COLUMN i06_note TEXT', 'INSTRUCTION INVALIDE'] };
    const backups = fakeBackups(db);
    expect(await boot(db, { v: '0.3.0', migrations: [...migrations, broken], backup: backups.factory })).toBeUndefined();
    expect(await applied(db)).toEqual(migrations.map((m) => m.version));
    expect((await db.select<{ name: string }>('PRAGMA table_info(task)')).some((c) => c.name === 'i06_note')).toBe(false);
    expect(await snapshot(db)).toEqual(before);
    expect(useAppStore.getState().dbFailure).toMatchObject({
      phase: 'open',
      step: 'migration',
      migration: LAST + 1,
      kind: 'migration',
      appVersion: '0.3.0',
      schemaVersion: LAST,
      appSchemaVersion: LAST + 1,
      updateBackup: { name: `circletasks-pre-migration-v${pad(LAST)}-to-v${pad(LAST + 1)}-20261009T080000Z.db` },
    });
    expect(logged()).toContain(`[desktop:db] migration ${String(LAST + 1)} impossible (DbError)`);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.2.3');
    await db.close();
  });

  it('sauvegarde impossible (disque plein) sur iPhone : aucune migration lancée, dbBackupFailed, pas de restauration proposée', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    const db = await populatedAtN();
    const backups = fakeBackups(db, true);
    expect(await boot(db, { v: '0.3.0', migrations: NEXT, backup: backups.factory })).toBeUndefined();
    expect(await applied(db)).toEqual(migrations.map((m) => m.version));
    expect(useAppStore.getState()).toMatchObject({ dbStatus: 'error', dbBackupFailed: true, dbFailure: { kind: 'backup', updateBackup: null } });
    await db.close();
  });
});

describe('critère 14 : base plus récente que l’app (D5)', () => {
  it('erreur typée avant toute écriture : ni sauvegarde, ni migration, ni réintégration, ni version mémorisée', async () => {
    const db = await populatedAtN();
    // La base a reçu N+1 (IPA plus récente), puis l'IPA N est réinstallée par-dessus.
    await boot(db, { v: '0.3.0', migrations: NEXT });
    const before = await snapshot(db);
    const backups = fakeBackups(db);
    expect(await boot(db, { v: '0.2.3', migrations, backup: backups.factory })).toBeUndefined();
    expect(backups.requests).toEqual([]);
    expect(await applied(db)).toEqual(NEXT.map((m) => m.version));
    expect(await snapshot(db)).toEqual(before);
    expect(await db.select('SELECT field FROM sync_unknown')).toEqual([{ field: 'futur' }]);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.3.0');
    expect(useAppStore.getState().dbFailure).toMatchObject({ kind: 'schema-newer', errorName: 'SchemaNewerThanApp', schemaVersion: LAST + 1, appSchemaVersion: LAST, appVersion: '0.2.3', updateBackup: null });
    expect(logged()).toContain(`[desktop:db] schema-newer ${String(LAST + 1)} ${String(LAST)}`);
    await db.close();
  });
});

describe('critère 16 : retour à une IPA plus ancienne dont la base est compatible', () => {
  it('journal app-downgraded, aucune migration inverse, aucune donnée supprimée, version courante mémorisée', async () => {
    const db = await populatedAtN();
    await db.execute("UPDATE settings SET value = '\"0.4.0\"' WHERE key = 'app.lastLaunchedVersion'");
    const before = await snapshot(db);
    const container = await boot(db, { v: '0.3.0' });
    expect(container?.launch).toBe('downgraded');
    expect(container?.appVersion).toEqual({ ok: true, version: '0.3.0', source: 'runtime' });
    expect(logged()).toContain('[desktop:app] app-downgraded 0.4.0 0.3.0');
    expect(await applied(db)).toEqual(migrations.map((m) => m.version));
    expect(await snapshot(db)).toEqual(before);
    expect(JSON.parse(String(await lastLaunched(db)))).toBe('0.3.0');
    await db.close();
  });
});
