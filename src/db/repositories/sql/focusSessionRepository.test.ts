import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId, type FocusSessionId, type IsoDateTime, type SpaceId, type TaskId } from '../../../domain/types';
import { RepositoryError } from '../common';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000f01');
const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const TASK = asEntityId<TaskId>('20000000-0000-4000-8000-000000000f01');
const sid = (n: number) => asEntityId<FocusSessionId>(`40000000-0000-4000-8000-00000000000${String(n)}`);
const at = (value: string) => value as IsoDateTime;

describe('FocusSessionRepository (SQL, F-01)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(async () => {
    await db.close();
  });

  it('create enregistre la session dès le lancement : fin vide, pauses à 0, tampon de synchro', async () => {
    const created = await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    expect(created).toMatchObject({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: '2026-10-04T08:00:00.000Z', endedAt: null, pausedSec: 0, pausedAt: null, deletedAt: null, deviceId: DEVICE });
    expect(created.hlc).not.toBe('');
    expect(await db.data.repos.focusSessions.getById(sid(1))).toEqual(created);
  });

  it('une session « Libre » a une durée prévue nulle', async () => {
    const created = await db.data.repos.focusSessions.create({ id: sid(1), taskId: null, spaceId: PRO, plannedMin: null, startedAt: at('2026-10-04T08:00:00.000Z') });
    expect(created.plannedMin).toBeNull();
    expect(created.taskId).toBeNull();
  });

  it('getOpen rend la session non terminée et null quand toutes sont closes', async () => {
    expect(await db.data.repos.focusSessions.getOpen()).toBeNull();
    await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    expect((await db.data.repos.focusSessions.getOpen())?.id).toBe(sid(1));
    await db.data.repos.focusSessions.update(sid(1), { endedAt: at('2026-10-04T08:25:00.000Z') });
    expect(await db.data.repos.focusSessions.getOpen()).toBeNull();
  });

  it('update change la durée, la fin et les pauses, et fait avancer le hlc', async () => {
    const created = await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    db.clock.advance(1000);
    const paused = await db.data.repos.focusSessions.update(sid(1), { pausedAt: at('2026-10-04T08:10:00.000Z') });
    expect(paused.pausedAt).toBe('2026-10-04T08:10:00.000Z');
    expect(paused.hlc > created.hlc).toBe(true);
    const resumed = await db.data.repos.focusSessions.update(sid(1), { pausedAt: null, pausedSec: 120, plannedMin: null });
    expect(resumed).toMatchObject({ pausedAt: null, pausedSec: 120, plannedMin: null, endedAt: null });
  });

  it('update d’une session absente ou supprimée lève not-found', async () => {
    await expect(db.data.repos.focusSessions.update(sid(9), { pausedSec: 1 })).rejects.toBeInstanceOf(RepositoryError);
    await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    await db.data.repos.focusSessions.discard(sid(1));
    await expect(db.data.repos.focusSessions.update(sid(1), { pausedSec: 1 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('discard supprime logiquement : invisible, jamais ouverte, tombstone conservé pour la synchro', async () => {
    await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    await db.data.repos.focusSessions.discard(sid(1));
    expect(await db.data.repos.focusSessions.getById(sid(1))).toBeNull();
    expect(await db.data.repos.focusSessions.getOpen()).toBeNull();
    const rows = await db.driver.select<{ deleted_at: string | null }>('SELECT deleted_at FROM focus_session WHERE id = ?', [sid(1)]);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('la tâche peut disparaître sans toucher à la session (pas de clé étrangère)', async () => {
    await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    expect((await db.data.repos.focusSessions.getById(sid(1)))?.taskId).toBe(TASK);
  });

  it('plusieurs sessions ouvertes (deux appareils hors ligne) : la plus récente est rendue', async () => {
    await db.data.repos.focusSessions.create({ id: sid(1), taskId: TASK, spaceId: PRO, plannedMin: 25, startedAt: at('2026-10-04T08:00:00.000Z') });
    await db.data.repos.focusSessions.create({ id: sid(2), taskId: null, spaceId: PRO, plannedMin: 50, startedAt: at('2026-10-04T09:00:00.000Z') });
    expect((await db.data.repos.focusSessions.getOpen())?.id).toBe(sid(2));
  });
});
