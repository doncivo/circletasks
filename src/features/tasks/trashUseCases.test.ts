import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type ReminderId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';
import { createTrashUseCases, type TrashUseCases } from './trashUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000008');
const DAY = asLocalDate('2026-10-05');
const DAY_MS = 86_400_000;

describe('suppression et corbeille (T-08)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;
  let trash: TrashUseCases;
  let undo: UndoStack;
  let entities: TaskEntities;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    undo = createUndoStack();
    entities = createTaskEntities();
    const deps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: entities };
    useCases = createTaskUseCases(deps);
    trash = createTrashUseCases(deps);
  });
  afterEach(() => db.close());

  async function create(title: string, spaceId = SPACE_PRO_ID, time: string | null = null): Promise<TaskId> {
    const result = await useCases.create({ title, spaceId, date: DAY, ...(time ? { time: asLocalTime(time) } : {}) });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }

  async function addReminder(id: TaskId): Promise<void> {
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id }, [
      { id: asEntityId<ReminderId>(uuidGenerator.next()), targetType: 'task', targetId: id, offsetMin: 0, fireAt: '2026-10-05T09:00' as never },
    ]);
  }

  it('remove : deletedAt renseigné, la tâche quitte toutes les lectures et la source unique (critère 2)', async () => {
    const id = await create('Courses');
    const [deleted] = await useCases.remove([id]);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(entities.get(id)).toBeUndefined();
    expect(await db.data.repos.tasks.getById(id)).toBeNull();
    expect(await db.data.repos.tasks.listForDay(DAY, 'all')).toEqual([]);
  });

  it('remove pousse une commande annulable « « <titre> » supprimée » (critère 3)', async () => {
    const id = await create('Courses');
    await useCases.remove([id]);
    const top = undo.getSnapshot().top;
    expect(top?.kind).toBe('delete');
    if (top) expect(undoMessage(top)).toBe('« Courses » supprimée');
  });

  it('annuler restaure à l’identique : date, heure, ordre, espace, rappels (critères 3, 9)', async () => {
    const id = await create('Courses', SPACE_PERSO_ID, '10:30');
    await addReminder(id);
    const before = await db.data.repos.tasks.getById(id);
    await useCases.remove([id]);
    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id })).toEqual([]); // inactifs

    db.clock.advance(1_000);
    const result = await undo.undoLast();
    expect(result.status).toBe('undone');
    const after = await db.data.repos.tasks.getById(id);
    expect(after).toMatchObject({ title: 'Courses', date: DAY, time: '10:30', spaceId: SPACE_PERSO_ID, sortOrder: before?.sortOrder, deletedAt: null });
    expect(entities.get(id)?.deletedAt).toBeNull();
    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id })).toHaveLength(1);
  });

  it('annuler après une restauration depuis la corbeille : « stale », rien n’est écrit', async () => {
    const id = await create('Courses');
    await useCases.remove([id]);
    db.clock.advance(1_000);
    await trash.restore(id);
    db.clock.advance(1_000);
    expect((await undo.undoLast()).status).toBe('stale');
    expect((await db.data.repos.tasks.getById(id))?.deletedAt).toBeNull();
  });

  it('remove d’une tâche déjà supprimée : rien à faire, rien à annuler', async () => {
    const id = await create('Courses');
    await useCases.remove([id]);
    undo.clear();
    expect(await useCases.remove([id])).toEqual([]);
    expect(undo.getSnapshot().size).toBe(0);
  });

  it('suppression par lot : une seule commande, message au pluriel', async () => {
    const a = await create('A');
    const b = await create('B');
    await useCases.remove([a, b]);
    expect(undo.getSnapshot().size).toBe(1);
    const top = undo.getSnapshot().top;
    if (top) expect(undoMessage(top)).toBe('2 tâches supprimées');
    expect((await undo.undoLast()).status).toBe('undone');
    expect(await db.data.repos.tasks.listForDay(DAY, 'all')).toHaveLength(2);
  });

  it('list : moins de 30 jours, plus récente d’abord, filtre d’espace (critère 5)', async () => {
    const a = await create('Ancienne');
    const b = await create('Récente', SPACE_PERSO_ID);
    await useCases.remove([a]);
    db.clock.advance(DAY_MS);
    await useCases.remove([b]);
    expect((await trash.list('all')).map((t) => t.title)).toEqual(['Récente', 'Ancienne']);
    expect((await trash.list(SPACE_PRO_ID)).map((t) => t.title)).toEqual(['Ancienne']);
  });

  it('list : une suppression de plus de 30 jours n’apparaît plus (critère 7)', async () => {
    const id = await create('Vieille');
    await useCases.remove([id]);
    db.clock.advance(30 * DAY_MS); // exactement 30 jours : encore visible
    expect(await trash.list('all')).toHaveLength(1);
    db.clock.advance(1_000);
    expect(await trash.list('all')).toEqual([]);
  });

  it('restore : retrouve date, espace, ordre et rappels, republiée dans la source unique (critères 6, 9)', async () => {
    const id = await create('Courses', SPACE_PERSO_ID);
    await addReminder(id);
    const before = await db.data.repos.tasks.getById(id);
    await useCases.remove([id]);
    db.clock.advance(DAY_MS);
    const restored = await trash.restore(id);
    expect(restored).toMatchObject({ date: DAY, spaceId: SPACE_PERSO_ID, sortOrder: before?.sortOrder, deletedAt: null });
    expect(entities.get(id)?.title).toBe('Courses');
    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id })).toHaveLength(1);
    expect(await trash.list('all')).toEqual([]);
  });

  it('restore : tâche expirée, active ou inconnue : null, rien d’écrit', async () => {
    const id = await create('Vieille');
    await useCases.remove([id]);
    db.clock.advance(31 * DAY_MS);
    expect(await trash.restore(id)).toBeNull();
    expect(await db.data.repos.tasks.getById(id)).toBeNull();
    const active = await create('Active');
    expect(await trash.restore(active)).toBeNull();
    expect(await trash.restore(asEntityId<TaskId>(uuidGenerator.next()))).toBeNull();
  });

  it('purgeExpired : jamais avant 30 jours, définitive ensuite (critère 7)', async () => {
    const id = await create('Vieille');
    await addReminder(id);
    await useCases.remove([id]);
    db.clock.advance(30 * DAY_MS);
    expect(await trash.purgeExpired()).toBe(0);
    expect(await db.driver.select('SELECT id FROM task WHERE id = ?', [id])).toHaveLength(1);
    db.clock.advance(1_000);
    expect(await trash.purgeExpired()).toBe(1);
    expect(await db.driver.select('SELECT id FROM task WHERE id = ?', [id])).toEqual([]);
    expect(await db.driver.select('SELECT id FROM reminder', [])).toEqual([]);
  });
});
