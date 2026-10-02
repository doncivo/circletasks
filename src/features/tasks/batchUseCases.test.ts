import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { RecurrenceFields } from '../../domain/model';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000a05');
const DAY = asLocalDate('2026-10-08');

describe('actions par lot du mode édition (A-05)', () => {
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

  async function create(title: string, extra: Partial<Parameters<TaskUseCases['create']>[0]> = {}): Promise<TaskId> {
    const result = await useCases.create({ title, spaceId: SPACE_PRO_ID, date: DAY, time: asLocalTime('09:00'), ...extra });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }

  describe('moveToSpace (Q12 : espace, jamais la date)', () => {
    it('déplace les tâches vers l’autre espace sans toucher à la date ni à l’heure, en une seule commande annulable (critère 7)', async () => {
      const a = await create('A');
      const b = await create('B');
      const moved = await useCases.moveToSpace([a, b], SPACE_PERSO_ID, null);
      expect(moved.map((task) => task.spaceId)).toEqual([SPACE_PERSO_ID, SPACE_PERSO_ID]);
      expect(await db.data.repos.tasks.getById(a)).toMatchObject({ spaceId: SPACE_PERSO_ID, date: DAY, time: '09:00', projectId: null });
      expect(entities.get(b)?.spaceId).toBe(SPACE_PERSO_ID);
      expect(undo.getSnapshot().size).toBe(1);
      expect(undoMessage(undo.getSnapshot().top as never)).toBe('2 tâches déplacées');

      expect((await undo.undoLast()).status).toBe('undone');
      expect(await db.data.repos.tasks.getById(a)).toMatchObject({ spaceId: SPACE_PRO_ID, date: DAY });
      expect(await db.data.repos.tasks.getById(b)).toMatchObject({ spaceId: SPACE_PRO_ID });
      expect(entities.get(a)?.spaceId).toBe(SPACE_PRO_ID);
    });

    it('une seule tâche : message « « A » déplacée » ; les tâches déjà dans l’espace sont ignorées', async () => {
      const a = await create('A');
      const p = await create('P', { spaceId: SPACE_PERSO_ID });
      const moved = await useCases.moveToSpace([a, p], SPACE_PERSO_ID, null);
      expect(moved.map((task) => task.id)).toEqual([a]);
      expect(undoMessage(undo.getSnapshot().top as never)).toBe('« A » déplacée');
      expect(await useCases.moveToSpace([a, p], SPACE_PERSO_ID, null)).toEqual([]);
      expect(undo.getSnapshot().size).toBe(1);
    });

    it('annuler après une modification de la tâche : « stale », rien n’est écrit', async () => {
      const a = await create('A');
      await useCases.moveToSpace([a], SPACE_PERSO_ID, null);
      await useCases.update(a, { note: 'modifiée' });
      expect((await undo.undoLast()).status).toBe('stale');
      expect(await db.data.repos.tasks.getById(a)).toMatchObject({ spaceId: SPACE_PERSO_ID });
    });

    it('une occurrence récurrente déplacée garde l’espace d’origine pour la suivante (« cette occurrence »)', async () => {
      const rule: RecurrenceFields = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null };
      const id = await create('Quotidienne', { recurrence: rule, date: asLocalDate('2026-10-02') });
      await useCases.moveToSpace([id], SPACE_PERSO_ID, null);
      expect(await db.data.repos.tasks.getById(id)).toMatchObject({ spaceId: SPACE_PERSO_ID });
      await useCases.complete(id);
      const next = (await db.data.repos.tasks.listForDay(asLocalDate('2026-10-03'), 'all'))[0];
      expect(next?.spaceId).toBe(SPACE_PRO_ID);
    });
  });

  describe('remove par lot', () => {
    it('supprime plusieurs tâches vers la corbeille, annulables en une fois (critère 6)', async () => {
      const a = await create('A');
      const b = await create('B');
      const deleted = await useCases.remove([a, b]);
      expect(deleted).toHaveLength(2);
      expect(await db.data.repos.tasks.getById(a)).toBeNull();
      expect(undo.getSnapshot().size).toBe(1);
      expect(undoMessage(undo.getSnapshot().top as never)).toBe('2 tâches supprimées');
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await db.data.repos.tasks.getById(a)).not.toBeNull();
      expect(await db.data.repos.tasks.getById(b)).not.toBeNull();
    });

    it('avec continueSeries, une occurrence récurrente génère la suivante ; l’annulation la retire', async () => {
      const rule: RecurrenceFields = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null };
      const series = await create('Série', { recurrence: rule });
      const simple = await create('Simple');
      await useCases.remove([series, simple], { continueSeries: true });
      const recurrenceId = (await db.data.repos.tasks.getById(series, { includeDeleted: true }))?.recurrenceId;
      const siblings = await db.data.repos.tasks.listByRecurrence(recurrenceId as never);
      expect(siblings).toHaveLength(1);
      expect(siblings[0]?.date).toBe('2026-10-09');
      expect(undo.getSnapshot().size).toBe(1);

      expect((await undo.undoLast()).status).toBe('undone');
      expect(await db.data.repos.tasks.getById(series)).not.toBeNull();
      expect(await db.data.repos.tasks.listByRecurrence(recurrenceId as never)).toHaveLength(1);
      expect((await db.data.repos.tasks.listByRecurrence(recurrenceId as never))[0]?.id).toBe(series);
    });

    it('sans continueSeries, la série n’est pas touchée (comportement de T-08)', async () => {
      const rule: RecurrenceFields = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null };
      const series = await create('Série', { recurrence: rule });
      await useCases.remove([series]);
      const recurrenceId = (await db.data.repos.tasks.getById(series, { includeDeleted: true }))?.recurrenceId;
      expect(await db.data.repos.tasks.listByRecurrence(recurrenceId as never)).toHaveLength(0);
    });
  });

  describe('moveToSomeday (« Un jour » de la fiche, A-08)', () => {
    it('retire date et heure, annulable, ignore terminées, déjà rangées et récurrentes', async () => {
      const a = await create('A');
      const done = await create('Faite');
      await useCases.complete(done);
      const rule: RecurrenceFields = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null };
      const series = await create('Série', { recurrence: rule });
      const moved = await useCases.moveToSomeday([a, done, series]);
      expect(moved.map((task) => task.id)).toEqual([a]);
      expect(await db.data.repos.tasks.getById(a)).toMatchObject({ someday: true, date: null, time: null });
      expect(await db.data.repos.tasks.getById(done)).toMatchObject({ someday: false });
      expect(await db.data.repos.tasks.getById(series)).toMatchObject({ someday: false });
      expect(entities.get(a)?.someday).toBe(true);
      expect(undoMessage(undo.getSnapshot().top as never)).toBe('« A » rangée dans « Un jour »');
      expect(await useCases.moveToSomeday([a])).toEqual([]);

      expect((await undo.undoLast()).status).toBe('undone');
      expect(await db.data.repos.tasks.getById(a)).toMatchObject({ someday: false, date: DAY, time: '09:00' });
    });
  });
});
