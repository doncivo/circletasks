import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000012');

describe('taskUseCases.duplicate (T-12)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;
  let undo: UndoStack;
  let entities: TaskEntities;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    undo = createUndoStack();
    entities = createTaskEntities();
    useCases = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: entities });
  });
  afterEach(() => db.close());

  async function create(input: Partial<Parameters<TaskUseCases['create']>[0]> = {}): Promise<TaskId> {
    const result = await useCases.create({
      title: 'Courses',
      spaceId: SPACE_PERSO_ID,
      date: asLocalDate('2026-10-08'),
      time: asLocalTime('10:00'),
      note: 'Pain, lait',
      icon: { kind: 'emoji', value: '🛒' } as never,
      ...input,
    });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }
  const offsetsOf = async (id: TaskId) => (await db.data.repos.reminders.listForTarget({ type: 'task', id })).map((r) => r.offsetMin);

  it('crée la copie à la date choisie avec titre, note, icône, espace, heure ; l’original est intact (critères 3, 9)', async () => {
    const id = await create();
    const original = await db.data.repos.tasks.getById(id);
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-09'));
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({ title: 'Courses', note: 'Pain, lait', spaceId: SPACE_PERSO_ID, time: '10:00', date: '2026-10-09', status: 'todo', carriedOver: false, recurrenceId: null, goalId: null });
    expect(copy.icon).toEqual(original?.icon);
    expect(await db.data.repos.tasks.getById(id)).toEqual(original);
    expect(entities.get(copy.id)).toEqual(copy);
  });

  it('copie les rappels avec la même avance et l’échéance recalculée (critère 3)', async () => {
    const id = await create();
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id }, [
      { id: asEntityId('50000000-0000-4000-8000-000000000001'), targetType: 'task', targetId: id, offsetMin: 0, fireAt: '2026-10-08T10:00' as never },
      { id: asEntityId('50000000-0000-4000-8000-000000000002'), targetType: 'task', targetId: id, offsetMin: 30, fireAt: '2026-10-08T09:30' as never },
    ]);
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-12'));
    const reminders = await db.data.repos.reminders.listForTarget({ type: 'task', id: copy.id });
    expect(reminders.map((r) => [r.offsetMin, r.fireAt])).toEqual([
      [30, '2026-10-12T09:30'],
      [0, '2026-10-12T10:00'],
    ]);
    expect(await offsetsOf(id)).toHaveLength(2);
  });

  it('ne copie ni récurrence, ni objectif, ni statut terminé ; la copie d’une tâche terminée est à faire (critères 4, 8)', async () => {
    const id = await create({ date: asLocalDate('2026-10-02'), recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } as never });
    await useCases.complete(id);
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-02'));
    expect((await db.data.repos.tasks.getById(id))?.recurrenceId).not.toBeNull();
    expect(copy).toMatchObject({ status: 'todo', doneAt: null, recurrenceId: null, seriesIndex: null });
  });

  it('« Un jour » : copie sans date ni heure ni rappel (critère 5)', async () => {
    const id = await create();
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id }, [
      { id: asEntityId('50000000-0000-4000-8000-000000000003'), targetType: 'task', targetId: id, offsetMin: 0, fireAt: '2026-10-08T10:00' as never },
    ]);
    const copy = await useCases.duplicate(id, null);
    expect(copy).toMatchObject({ someday: true, date: null, time: null });
    expect(await offsetsOf(copy.id)).toEqual([]);
  });

  it('la copie est placée après les tâches du jour (ordre manuel, critère 4)', async () => {
    const id = await create();
    db.clock.advance(1000);
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-08'));
    const original = await db.data.repos.tasks.getById(id);
    expect(copy.sortOrder).toBeGreaterThan(original?.sortOrder ?? 0);
  });

  it('annulable : message « dupliquée », annuler supprime la copie sans la mettre en corbeille (critère 7)', async () => {
    const id = await create();
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-09'));
    const top = undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Courses » dupliquée');
    expect(top?.kind).toBe('duplicate');

    const result = await undo.undoLast();
    expect(result.status).toBe('undone');
    expect(await db.data.repos.tasks.getById(copy.id)).toBeNull();
    expect(entities.get(copy.id)).toBeUndefined();
    const trash = await db.data.repos.tasks.listTrash('2026-01-01T00:00:00.000Z' as never, 'all');
    expect(trash.map((t) => t.id)).not.toContain(copy.id);
    // Tombstone conservé (synchro), série intacte : aucun series_index n'est touché.
    const tomb = await db.data.repos.tasks.getById(copy.id, { includeDeleted: true });
    expect(tomb?.deletedAt).not.toBeNull();
    expect(tomb?.seriesIndex).toBeNull();
    expect(await db.data.repos.tasks.getById(id)).not.toBeNull();
  });

  it('annuler après une modification de la copie : « stale », rien n’est supprimé', async () => {
    const id = await create();
    const copy = await useCases.duplicate(id, asLocalDate('2026-10-09'));
    await useCases.update(copy.id, { note: 'changée' });
    expect((await undo.undoLast()).status).toBe('stale');
    expect(await db.data.repos.tasks.getById(copy.id)).not.toBeNull();
  });

  it('original introuvable : rejet (le store affiche un message), rien dans la pile', async () => {
    await expect(useCases.duplicate(asEntityId<TaskId>('99999999-0000-4000-8000-000000000001'), null)).rejects.toThrow();
    expect(undo.getSnapshot().size).toBe(0);
  });

  it('espace Pro conservé', async () => {
    const id = await create({ spaceId: SPACE_PRO_ID });
    expect((await useCases.duplicate(id, asLocalDate('2026-10-09'))).spaceId).toBe(SPACE_PRO_ID);
  });
});
