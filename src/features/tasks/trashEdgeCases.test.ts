import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, type DeviceId, type ReminderId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';
import { createTrashUseCases, type TrashUseCases } from './trashUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000018');
const DAY_MS = 86_400_000;

describe('corbeille : cas limites (T-08)', () => {
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

  async function create(title: string, date = '2026-10-05'): Promise<TaskId> {
    const r = await useCases.create({ title, spaceId: SPACE_PRO_ID, date: asLocalDate(date) });
    if (!r.ok) throw new Error('création impossible');
    return r.value.id;
  }
  const reminder = (id: TaskId, offsetMin: 0 | 5 | 15 | 30 | 60 | 1440) => ({
    id: asEntityId<ReminderId>(uuidGenerator.next()),
    targetType: 'task' as const,
    targetId: id,
    offsetMin,
    fireAt: '2026-10-05T09:00' as never,
  });

  it('T-08 restaurer une tâche dont la date est passée : elle garde sa date', async () => {
    const id = await create('Passée', '2026-10-05');
    await useCases.remove([id]);
    db.clock.advance(20 * DAY_MS); // aujourd'hui = 22 octobre
    const restored = await trash.restore(id);
    expect(restored?.date).toBe('2026-10-05');
    expect((await db.data.repos.tasks.getById(id))?.date).toBe('2026-10-05');
  });

  it('T-08 restauration à exactement 30 jours acceptée, à 30 jours + 1 ms refusée', async () => {
    const a = await create('Limite');
    await useCases.remove([a]);
    db.clock.advance(30 * DAY_MS);
    expect(await trash.restore(a)).not.toBeNull();
    const b = await create('Dépassée');
    await useCases.remove([b]);
    db.clock.advance(30 * DAY_MS + 1);
    expect(await trash.restore(b)).toBeNull();
  });

  it('T-08 suppression puis annulation dans les 5 s : tâche revenue dans listForDay et la source unique', async () => {
    const id = await create('Courses');
    await useCases.remove([id]);
    expect(entities.get(id)).toBeUndefined();
    db.clock.advance(4_000);
    expect((await undo.undoLast()).status).toBe('undone');
    expect(entities.get(id)?.deletedAt).toBeNull();
    expect((await db.data.repos.tasks.listForDay(asLocalDate('2026-10-05'), 'all')).map((t) => t.id)).toEqual([id]);
    expect(await trash.list('all')).toEqual([]);
  });

  it('T-08 tâche terminée supprimée : absente de listDone, de listForDay et de la source unique', async () => {
    const id = await create('Faite');
    await useCases.complete(id);
    const doneAt = (await db.data.repos.tasks.getById(id))?.doneAt;
    expect(doneAt).toBeTruthy();
    const range = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' } as never;
    expect(await db.data.repos.tasks.listDone(range, 'all')).toHaveLength(1);
    await useCases.remove([id]);
    expect(await db.data.repos.tasks.listDone(range, 'all')).toEqual([]);
    expect(await db.data.repos.tasks.listForDay(asLocalDate('2026-10-05'), 'all')).toEqual([]);
    expect(entities.get(id)).toBeUndefined();
  });

  it('T-08 rappels : restaurer ne réactive que les rappels supprimés avec la tâche', async () => {
    const id = await create('Courses');
    const target = { type: 'task' as const, id };
    await db.data.repos.reminders.replaceForTarget(target, [reminder(id, 0), reminder(id, 60)]);
    // le rappel +60 est retiré par l'utilisateur AVANT la suppression de la tâche
    await db.data.repos.reminders.replaceForTarget(target, [reminder(id, 0)]);
    await useCases.remove([id]);
    db.clock.advance(1_000);
    await trash.restore(id);
    const active = await db.data.repos.reminders.listForTarget(target);
    expect(active.map((r) => r.offsetMin)).toEqual([0]);
  });

  it('T-08 rappels : annuler la suppression ne réactive que les rappels supprimés avec la tâche', async () => {
    const id = await create('Courses');
    const target = { type: 'task' as const, id };
    await db.data.repos.reminders.replaceForTarget(target, [reminder(id, 0), reminder(id, 60)]);
    await db.data.repos.reminders.replaceForTarget(target, [reminder(id, 0)]);
    await useCases.remove([id]);
    db.clock.advance(1_000);
    await undo.undoLast();
    const active = await db.data.repos.reminders.listForTarget(target);
    expect(active.map((r) => r.offsetMin)).toEqual([0]);
  });

  it('T-08 rappels d’une autre tâche : non touchés par suppression et restauration', async () => {
    const a = await create('A');
    const b = await create('B');
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id: a }, [reminder(a, 0)]);
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id: b }, [reminder(b, 0)]);
    await useCases.remove([a]);
    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id: b })).toHaveLength(1);
    await trash.restore(a);
    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id: b })).toHaveLength(1);
  });
});
