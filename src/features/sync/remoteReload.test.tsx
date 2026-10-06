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

async function task(): Promise<TaskId> {
  const created = await db.data.repos.tasks.create({
    id: asEntityId<TaskId>('13000000-0000-4000-8000-000000000001'), spaceId: PRO, projectId: null, title: 'Vivante', note: '', date: null, time: null, status: 'todo', doneAt: null,
    sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, externalEventId: null,
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
});
