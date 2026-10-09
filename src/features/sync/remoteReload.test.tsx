// Y-TECH-02 (revue, point 2) : rechargement des écrans après un lot reçu. Une relecture en échec n'est jamais prise pour une suppression,
// chaque relecture en échec est journalisée (code seulement), et l'échec est visible (bandeau « reload-failed ») jusqu'au rechargement
// réussi suivant. Base SQLite en mémoire, faux service, aucun délai réel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime, type SpaceId, type TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { createMemorySyncLogger } from '../../sync';
import { useAppStore } from '../app/appStore';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { applyRemoteChanges } from './remoteChanges';
import { startSyncIntegration } from './startSync';
import { syncStore } from './syncStore';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f3');
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-06T08:00:00.000Z');
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-06T08:00:00.000Z' as IsoDateTime });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

async function task(id = '13000000-0000-4000-8000-000000000001'): Promise<TaskId> {
  const created = await db.data.repos.tasks.create({
    id: asEntityId<TaskId>(id), spaceId: PRO, projectId: null, title: 'Vivante', note: '', date: null, time: null, status: 'todo', doneAt: null,
    sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null,
  });
  container.taskEntities.publish([created]);
  return created.id;
}

const failing = (target: object, method: string): void => {
  (target as Record<string, unknown>)[method] = () => Promise.reject(new Error('base occupée'));
};

describe('relectures en échec (applyRemoteChanges)', () => {
  it('tâche : lecture en échec → jamais retirée de l’écran comme supprimée ; journalisée', async () => {
    const id = await task();
    const logger = createMemorySyncLogger();
    failing(db.data.repos.tasks, 'getById');
    const result = await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) }, logger);
    expect(container.taskEntities.get(id)?.title).toBe('Vivante');
    expect(result.failed).toEqual(['task']);
    expect(logger.entries).toEqual([{ event: 'remote-reload-failed', detail: { what: 'task', code: 'io' } }]);
  });

  it('espaces : relecture en échec → valeur gardée, journalisée', async () => {
    const logger = createMemorySyncLogger();
    const before = useAppStore.getState().spaces;
    failing(db.data.repos.spaces, 'listAll');
    const result = await applyRemoteChanges(container, { tables: new Set(['space']), ids: new Map() }, logger);
    expect(useAppStore.getState().spaces).toBe(before);
    expect(result.failed).toEqual(['space']);
    expect(logger.entries.map((e) => e.detail['what'])).toEqual(['space']);
  });

  it('projets : relecture en échec → valeur gardée, journalisée', async () => {
    const logger = createMemorySyncLogger();
    failing(db.data.repos.projects, 'listForFilter');
    const result = await applyRemoteChanges(container, { tables: new Set(['project']), ids: new Map() }, logger);
    expect(result.failed).toEqual(['project']);
    expect(logger.entries.map((e) => e.detail['what'])).toEqual(['project']);
  });

  it('identifiant reçu invalide : ignoré mais journalisé', async () => {
    const logger = createMemorySyncLogger();
    const result = await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(['pas-un-uuid'])]]) }, logger);
    expect(result.failed).toEqual([]);
    expect(logger.entries).toEqual([{ event: 'remote-id-ignored', detail: { table: 'task' } }]);
  });
});

describe('signal visible (startSync)', () => {
  it('rechargement en échec : bandeau « reload-failed », retiré au rechargement réussi suivant', async () => {
    const id = await task();
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    failing(db.data.repos.tasks, 'getById');
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble).toMatchObject({ detail: 'reload-failed', message: t('status.syncReloadFailed') });
    (db.data.repos.tasks as unknown as Record<string, unknown>)['getById'] = real;
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('seconde revue, point 1 : échec, puis cycle sans nouveau lot → rechargement retenté, tâche à jour, bandeau retiré', async () => {
    const id = await task();
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    failing(db.data.repos.tasks, 'getById');
    await db.data.repos.tasks.update(id, { title: 'Renommée ailleurs' });
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reload-failed');
    (db.data.repos.tasks as unknown as Record<string, unknown>)['getById'] = real;
    // Cycle sans nouveau lot : il passe par « syncing » et revient à l'état conclu.
    sync.setStatus({ phase: 'syncing' });
    sync.setStatus({ phase: 'idle' });
    await integration.reloaded();
    expect(container.taskEntities.get(id)?.title).toBe('Renommée ailleurs');
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('seconde revue, point 1 : « Synchroniser maintenant » retente aussi le rechargement', async () => {
    const id = await task();
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    failing(db.data.repos.tasks, 'getById');
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) });
    await integration.reloaded();
    (db.data.repos.tasks as unknown as Record<string, unknown>)['getById'] = real;
    await syncStore.get(container).getState().syncNow('manual');
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('troisième revue, point M2 : la fin d’une ancienne intégration ne retire pas la relance de la nouvelle', async () => {
    const id = await task();
    const env = { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined };
    const old = startSyncIntegration(container, env);
    const integration = startSyncIntegration(container, env);
    await integration.refreshed();
    old.dispose();
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    failing(db.data.repos.tasks, 'getById');
    await db.data.repos.tasks.update(id, { title: 'Renommée ailleurs' });
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reload-failed');
    (db.data.repos.tasks as unknown as Record<string, unknown>)['getById'] = real;
    await syncStore.get(container).getState().syncNow('manual');
    await integration.reloaded();
    expect(container.taskEntities.get(id)?.title).toBe('Renommée ailleurs');
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('quatrième revue, point E : un lot réussi qui couvre la file retire le bandeau (sans attendre la relance)', async () => {
    const id1 = await task();
    const id2 = await task('13000000-0000-4000-8000-000000000002');
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    failing(db.data.repos.tasks, 'getById');
    await db.data.repos.tasks.update(id1, { title: 'Renommée ailleurs' });
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id1])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reload-failed');
    (db.data.repos.tasks as unknown as Record<string, unknown>)['getById'] = real;
    sync.emitChanges({ tables: new Set(['task', 'space']), ids: new Map([['task', new Set([id1, id2])]]) });
    await integration.reloaded();
    expect(container.taskEntities.get(id1)?.title).toBe('Renommée ailleurs');
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });

  it('troisième revue, point 1 : un lot B rechargé ne retire pas le bandeau tant que le lot A en échec attend sa relance', async () => {
    const id1 = await task();
    const id2 = await task('13000000-0000-4000-8000-000000000002');
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    const repo = db.data.repos.tasks as unknown as Record<string, unknown>;
    const real = db.data.repos.tasks.getById.bind(db.data.repos.tasks);
    // Seule la relecture de id1 échoue.
    repo['getById'] = (id: TaskId, options?: { includeDeleted?: boolean }) => (id === id1 ? Promise.reject(new Error('base occupée')) : real(id, options));
    await db.data.repos.tasks.update(id1, { title: 'Renommée ailleurs' });
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id1])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('reload-failed');
    sync.emitChanges({ tables: new Set(['task']), ids: new Map([['task', new Set([id2])]]) });
    await integration.reloaded();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail, 'id1 attend encore sa relance').toBe('reload-failed');
    expect(container.taskEntities.get(id1)?.title).toBe('Vivante');
    repo['getById'] = real;
    sync.setStatus({ phase: 'syncing' });
    sync.setStatus({ phase: 'idle' });
    await integration.reloaded();
    expect(container.taskEntities.get(id1)?.title).toBe('Renommée ailleurs');
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    integration.dispose();
  });
});
