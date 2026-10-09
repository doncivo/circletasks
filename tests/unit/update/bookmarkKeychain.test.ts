import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { LocalDate, SpaceId, TaskId } from '../../../src/domain/types';
import type { SqlDriver } from '../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../src/db/drivers/sqliteWasm';
import { migrations } from '../../../src/db/migrations';
import type { Migration } from '../../../src/db/migrator';
import { SPACE_PRO_ID } from '../../../src/db/seed/defaultSpaces';
import { useAppStore } from '../../../src/features/app/appStore';
import { bootstrapApp } from '../../../src/features/app/bootstrap';
import type { AppContainer } from '../../../src/features/app/container';
import { isTroublePhase, statusLine } from '../../../src/features/sync/syncText';
import { t } from '../../../src/i18n';
import { createUnavailableBackup } from '../../../src/platform/backup';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS } from '../../../src/platform/calendars';
import { createUnavailableFiles } from '../../../src/platform/files';
import { SyncPlatformError } from '../../../src/platform/sync';
import { createMemorySyncPlatform, type MemorySyncPlatform } from '../../../src/platform/sync/memory';

/**
 * I-06 critère 10 (ADR 0007 avenant I-06 point 5) : une mise à jour (même identifiant, même Apple ID) garde le signet du dossier et la clé
 * du Trousseau : rien n'est redemandé, réécrit ni régénéré, l'état de la synchro est intact et le cycle reprend. Signet périmé ou clé
 * absente : états visibles existants (Y-IOS-01, Y-08/Y-11), la file attend, jamais une régénération silencieuse.
 */

const LAST = migrations.at(-1)?.version ?? 0;
const NEXT: Migration[] = [...migrations, { version: LAST + 1, name: 'test_i06_additive', statements: ['ALTER TABLE task ADD COLUMN i06_note TEXT'] }];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const clock = createManualClock('2026-10-09T08:00:00.000Z');
const common = { desktop: null, focusWindow: null, files: createUnavailableFiles(), calendars: createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS), backups: createUnavailableBackup(), clock } as const;

const keepOpen = (db: SqlDriver): SqlDriver => ({ kind: db.kind, execute: (s, p) => db.execute(s, p), select: (s, p) => db.select(s, p), transaction: (fn) => db.transaction(fn), close: () => Promise.resolve() });

/** Faux du Trousseau et du signet : aucune écriture ne doit passer après la mise à jour. */
function watch(platform: MemorySyncPlatform) {
  return {
    choose: vi.spyOn(platform.folder, 'choose'),
    forget: vi.spyOn(platform.folder, 'forget'),
    create: vi.spyOn(platform.key, 'create'),
    importKey: vi.spyOn(platform.key, 'import'),
  };
}

async function installedAtN(): Promise<{ db: SqlDriver; platform: MemorySyncPlatform; kid: string | null }> {
  vi.stubGlobal('navigator', { userAgent: IPHONE });
  const platform = createMemorySyncPlatform({ platform: 'ios', nowMs: () => clock.nowMs() });
  await platform.folder.choose();
  await platform.key.create();
  const db = await openSqliteWasmDriver();
  const n = await bootstrapApp({ ...common, open: () => Promise.resolve(keepOpen(db)), syncPlatform: platform, appVersion: () => Promise.resolve({ ok: true, version: '0.2.3', source: 'runtime' }) });
  await n?.sync?.syncNow('manual');
  expect(n?.sync?.status().phase).toBe('idle');
  return { db, platform, kid: (await platform.key.status()).kid };
}

async function update(db: SqlDriver, platform: MemorySyncPlatform): Promise<AppContainer | undefined> {
  return bootstrapApp({ ...common, open: () => Promise.resolve(keepOpen(db)), syncPlatform: platform, migrations: NEXT, appVersion: () => Promise.resolve({ ok: true, version: '0.3.0', source: 'runtime' }) });
}

const syncState = (db: SqlDriver) => db.select('SELECT * FROM sync_state ORDER BY device_id');

beforeEach(() => {
  useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('signet et clé conservés par la mise à jour (critère 10)', () => {
  it('aucun sélecteur ouvert, aucune clé créée, importée ni effacée ; sync_state intact ; le cycle reprend', async () => {
    const { db, platform, kid } = await installedAtN();
    const before = await syncState(db);
    const spies = watch(platform);
    const container = await update(db, platform);
    expect(container?.launch).toBe('updated');
    expect(await syncState(db)).toEqual(before);
    expect((await platform.folder.info()).configured).toBe(true);
    await container?.sync?.syncNow('manual');
    expect(container?.sync?.status().phase).toBe('idle');
    expect((await platform.key.status()).kid).toBe(kid);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    await db.close();
  });

  it('signet périmé après la mise à jour : « choisissez de nouveau le dossier » (iPhone), la file attend sans perte, la clé reste', async () => {
    const { db, platform, kid } = await installedAtN();
    const spies = watch(platform);
    vi.spyOn(platform.folder, 'info').mockRejectedValue(new SyncPlatformError('folder-unreachable'));
    const container = await update(db, platform);
    await container?.data.repos.tasks.create({ id: '55555555-5555-4555-8555-555555555555' as TaskId, spaceId: SPACE_PRO_ID as SpaceId, projectId: null, title: 'Après la mise à jour', note: '', date: '2026-10-09' as LocalDate, time: null, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null });
    const queued = await db.select('SELECT * FROM sync_outbox');
    expect(queued.length).toBeGreaterThan(0);
    await container?.sync?.syncNow('manual');
    const status = container?.sync?.status();
    expect(status).toMatchObject({ phase: 'error', errorCode: 'folder-unreachable' });
    expect(status && statusLine(status, clock.nowMs())).toBe(t('sync.status.errorFolderUnreachableIos'));
    expect(status && isTroublePhase(status)).toBe(true);
    expect(await db.select('SELECT * FROM sync_outbox')).toEqual(queued);
    expect((await platform.key.status()).kid).toBe(kid);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    await db.close();
  });

  it('clé absente du Trousseau alors que la synchro est configurée : état « à associer » visible, aucune clé régénérée', async () => {
    const { db, platform } = await installedAtN();
    const spies = watch(platform);
    vi.spyOn(platform.key, 'status').mockResolvedValue({ present: false, kid: null });
    const container = await update(db, platform);
    expect(container).toBeDefined();
    await container?.sync?.syncNow('manual');
    const status = container?.sync?.status();
    expect(status?.phase).toBe('needs-pairing');
    expect(status && statusLine(status, clock.nowMs())).not.toBe('');
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    await db.close();
  });
});
