import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { moveTaskRow } from '../../domain/taskReorder';
import { buildTodayList } from '../../domain/todayList';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type LocalTime, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000a02');
const DAY = asLocalDate('2026-10-08');

describe('taskUseCases.reorder (A-02)', () => {
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

  async function create(title: string, time?: string): Promise<TaskId> {
    db.clock.advance(1);
    const result = await useCases.create({ title, spaceId: SPACE_PRO_ID, date: DAY, ...(time ? { time: asLocalTime(time) as LocalTime } : {}) });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }

  const order = async (): Promise<string[]> => {
    const tasks = await db.data.repos.tasks.listForDay(DAY, 'all');
    return buildTodayList({ date: DAY, filter: 'all', tasks }).rows.map((row) => (row.kind === 'task' ? row.task.title : row.id));
  };

  /** Déplace `title` à `toIndex` comme le fait l'écran : domaine puis cas d'usage. */
  async function move(title: string, toIndex: number): Promise<void> {
    const tasks = await db.data.repos.tasks.listForDay(DAY, 'all');
    const rows = buildTodayList({ date: DAY, filter: 'all', tasks }).rows;
    const id = rows.find((row) => row.kind === 'task' && row.task.title === title)?.id;
    const outcome = moveTaskRow(rows, id ?? '', toIndex);
    await useCases.reorder((outcome?.changes ?? []).map((change) => ({ id: change.id as TaskId, sortOrder: change.sortOrder })));
  }

  it('persiste l’ordre manuel dans la base et publie les tâches (critère 4)', async () => {
    await create('A');
    await create('B');
    await create('C');
    await move('C', 0);
    expect(await order()).toEqual(['C', 'A', 'B']);
    const [first] = await db.data.repos.tasks.listForDay(DAY, 'all');
    expect(first?.title).toBe('C');
    expect(entities.get(first?.id as TaskId)?.sortOrder).toBe(first?.sortOrder);
  });

  it('une nouvelle tâche se place en fin des sans-heure, après un réordonnancement (critère 9)', async () => {
    await create('A');
    await create('B');
    await move('B', 0);
    await create('N');
    await create('T9', '09:00');
    expect(await order()).toEqual(['T9', 'B', 'A', 'N']);
  });

  it('le réordonnancement est annulable : message « Tâche déplacée », Ctrl+Z rétablit l’ordre (critère 8)', async () => {
    await create('A');
    await create('B');
    await move('B', 0);
    expect(undo.getSnapshot().top).toMatchObject({ kind: 'move' });
    expect(undoMessage(undo.getSnapshot().top as never)).toBe('Tâche déplacée');
    expect(await order()).toEqual(['B', 'A']);
    const result = await undo.undoLast();
    expect(result.status).toBe('undone');
    expect(await order()).toEqual(['A', 'B']);
    const rows = await db.data.repos.tasks.listForDay(DAY, 'all');
    for (const task of rows) expect(entities.get(task.id)?.sortOrder).toBe(task.sortOrder);
  });

  it('annuler après une modification de la tâche depuis : « stale », rien n’est écrit', async () => {
    await create('A');
    const b = await create('B');
    await move('B', 0);
    await useCases.update(b, { note: 'modifiée' });
    expect((await undo.undoLast()).status).toBe('stale');
    expect(await order()).toEqual(['B', 'A']);
  });

  it('une liste d’entrées vide ou des tâches inconnues n’écrit rien et ne pousse aucune commande', async () => {
    await useCases.reorder([]);
    await useCases.reorder([{ id: asEntityId<TaskId>('40000000-0000-4000-8000-0000000000aa'), sortOrder: 1 }]);
    expect(undo.getSnapshot().size).toBe(0);
  });
});
