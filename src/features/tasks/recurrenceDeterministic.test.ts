import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { NewTask, RecurrenceFields, Task } from '../../domain/model';
import { occurrenceReminderId, occurrenceTaskId } from '../../domain/occurrenceId';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type RecurrenceId, type ReminderId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import { createRecurrenceUseCases } from './recurrenceUseCases';
import type { TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

/**
 * T-TECH-01 critères 2 à 5 : identifiants déterministes des occurrences et de leurs rappels, création idempotente, résurrection d'une
 * occurrence annulée (T-09), corbeille manuelle inchangée.
 */

const DEVICE_A = asEntityId<DeviceId>('40000000-0000-4000-8000-0000000000a1');
const DEVICE_B = asEntityId<DeviceId>('40000000-0000-4000-8000-0000000000b1');
const RULE_ID = asEntityId<RecurrenceId>('41000000-0000-4000-8000-000000000001');
const FIRST = asEntityId<TaskId>('42000000-0000-4000-8000-000000000001');
const d = asLocalDate;
const local = (m: number, day: number, h: number, min = 0): number => new Date(2026, m, day, h, min).getTime();

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('valeur attendue');
  return value;
}

/** Même série sur chaque base : règle quotidienne, occurrence 0 du 23 sept. à 09:00, rappels 30 et 60 min avant. */
async function seed(db: TestDb): Promise<void> {
  await db.data.repos.recurrences.create({ id: RULE_ID, ...defaultRecurrence('daily', d('2026-09-23')) } as RecurrenceFields & { id: RecurrenceId });
  const task: NewTask = {
    id: FIRST,
    spaceId: SPACE_PRO_ID,
    projectId: null,
    title: 'Prendre les vitamines',
    note: '',
    date: d('2026-09-23'),
    time: asLocalTime('09:00'),
    status: 'todo',
    doneAt: null,
    sortOrder: 1,
    carriedOver: false,
    recurrenceId: RULE_ID,
    seriesIndex: 0,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local',
    externalId: null,
    appleListId: null,
    appleRecurring: false,
    externalEventId: null,
  };
  await db.data.repos.tasks.create(task);
  await db.data.repos.reminders.replaceForTarget(
    { type: 'task', id: FIRST },
    [30, 60].map((offsetMin) => ({ id: asEntityId<ReminderId>(`43000000-0000-4000-8000-0000000000${String(offsetMin)}`), targetType: 'task' as const, targetId: FIRST, offsetMin: offsetMin as never, fireAt: `2026-09-23T08:${String(offsetMin).padStart(2, '0')}` as never })),
  );
}

const depsOf = (db: TestDb, undo: UndoStack = createUndoStack()): TaskUseCaseDeps => ({ clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: createTaskEntities() });
const series = (db: TestDb, includeDeleted = false): Promise<Task[]> => db.data.repos.tasks.listByRecurrence(RULE_ID, { includeDeleted });

describe('occurrences à identifiant déterministe (T-TECH-01 critères 2 et 3)', () => {
  let a: TestDb;
  let b: TestDb;
  beforeEach(async () => {
    a = await openTestDb(DEVICE_A, local(8, 24, 8));
    b = await openTestDb(DEVICE_B, local(8, 24, 8));
    await seed(a);
    await seed(b);
  });
  afterEach(async () => {
    await a.close();
    await b.close();
  });

  it('critère 2 : créée sur A puis sur B (bases séparées), la tâche et ses deux rappels ont les mêmes identifiants', async () => {
    const [onA] = await createRecurrenceUseCases(depsOf(a)).generateDue();
    const [onB] = await createRecurrenceUseCases(depsOf(b)).generateDue();
    const expected = await occurrenceTaskId(RULE_ID, 1);
    expect(onA?.id).toBe(expected);
    expect(onB?.id).toBe(expected);
    const remindersOf = async (db: TestDb) => (await db.data.repos.reminders.listForTarget({ type: 'task', id: expected })).map((r) => [r.id, r.offsetMin, r.fireAt]);
    const onADb = await remindersOf(a);
    // Triés par échéance : 08:00 (60 min avant 09:00), puis 08:30.
    expect(onADb).toEqual([
      [await occurrenceReminderId(expected, 60), 60, '2026-09-24T08:00'],
      [await occurrenceReminderId(expected, 30), 30, '2026-09-24T08:30'],
    ]);
    expect(await remindersOf(b)).toEqual(onADb);
  });

  it('critère 3 : une occurrence déjà présente et vivante (reçue de l’autre appareil) n’est pas recréée, sans erreur', async () => {
    await createRecurrenceUseCases(depsOf(a)).generateDue();
    // B reçoit la ligne de A (même identifiant) puis repasse : rien à créer.
    const received = must(await a.data.repos.tasks.getById(await occurrenceTaskId(RULE_ID, 1)));
    const { id, ...rest } = received;
    await b.data.repos.tasks.create({ ...rest, id } as unknown as NewTask);
    expect(await createRecurrenceUseCases(depsOf(b)).generateDue()).toEqual([]);
    expect(await createRecurrenceUseCases(depsOf(b)).generateDue()).toEqual([]);
    expect(await series(b)).toHaveLength(2);
    expect(await series(b, true)).toHaveLength(2);
  });
});

describe('résurrection et corbeille (T-TECH-01 critères 4 et 5)', () => {
  let db: TestDb;
  let undo: UndoStack;
  let useCases: TaskUseCases;
  beforeEach(async () => {
    db = await openTestDb(DEVICE_A, local(8, 23, 8));
    await seed(db);
    undo = createUndoStack();
    useCases = createTaskUseCases(depsOf(db, undo));
  });
  afterEach(() => db.close());

  it('critère 4 : annuler la complétion puis terminer de nouveau ressuscite la même ligne (une seule vivante, rien en corbeille)', async () => {
    await useCases.complete(FIRST);
    const nextId = await occurrenceTaskId(RULE_ID, 1);
    expect(must(await db.data.repos.tasks.getById(nextId)).seriesIndex).toBe(1);
    expect((await undo.undoLast()).status).toBe('undone');
    const undone = must(await db.data.repos.tasks.getById(nextId, { includeDeleted: true }));
    expect(undone.deletedAt).not.toBeNull();
    expect(undone.seriesIndex).toBe(-1);

    await useCases.complete(FIRST);

    const rows = await series(db, true);
    expect(rows.map((t) => t.id).sort()).toEqual([FIRST, nextId].sort());
    const back = must(rows.find((t) => t.id === nextId));
    expect(back).toMatchObject({ deletedAt: null, seriesIndex: 1, date: '2026-09-24', status: 'todo', doneAt: null, title: 'Prendre les vitamines' });
    expect(await db.data.repos.tasks.listTrash('2000-01-01T00:00:00.000Z' as never, 'all')).toEqual([]);
    const reminders = await db.data.repos.reminders.listForTarget({ type: 'task', id: nextId });
    expect(reminders.map((r) => r.id).sort()).toEqual([await occurrenceReminderId(nextId, 30), await occurrenceReminderId(nextId, 60)].sort());
    expect(reminders.every((r) => r.deletedAt === null)).toBe(true);
  });

  it('critère 4 (variante) : terminer, annuler, terminer, annuler, terminer : toujours une seule ligne pour (R, 1)', async () => {
    for (let i = 0; i < 2; i += 1) {
      await useCases.complete(FIRST);
      await undo.undoLast();
    }
    await useCases.complete(FIRST);
    const live = (await series(db, true)).filter((t) => t.seriesIndex === 1 && t.deletedAt === null);
    expect(live).toHaveLength(1);
    expect((await series(db, true)).filter((t) => t.id === live[0]?.id)).toHaveLength(1);
  });

  it('M2 : une ligne annulée (-1) restaurée à la main garde les modifications de l’utilisateur, elle n’est pas réécrite', async () => {
    await useCases.complete(FIRST);
    const nextId = await occurrenceTaskId(RULE_ID, 1);
    await undo.undoLast();
    await db.data.repos.tasks.restore([nextId]);
    await db.data.repos.tasks.update(nextId, { note: 'modifiée par l’utilisateur' });
    await useCases.complete(FIRST);
    expect(must(await db.data.repos.tasks.getById(nextId))).toMatchObject({ note: 'modifiée par l’utilisateur', deletedAt: null });
  });

  it('critère 5 : une occurrence mise à la corbeille à la main (index conservé) n’est pas recréée', async () => {
    db.clock.set(local(8, 24, 8));
    const [next] = await createRecurrenceUseCases(depsOf(db)).generateDue();
    await useCases.remove([must(next).id]);
    expect(await createRecurrenceUseCases(depsOf(db)).generateDue()).toEqual([]);
    expect(await series(db)).toHaveLength(1);
    const trashed = must(await db.data.repos.tasks.getById(must(next).id, { includeDeleted: true }));
    expect(trashed.deletedAt).not.toBeNull();
    expect(trashed.seriesIndex).toBe(1);
  });
});
