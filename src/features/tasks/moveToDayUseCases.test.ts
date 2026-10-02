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

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000302');

// Horloge de test : 2026-10-02 08:00 UTC = vendredi 2 octobre.
describe('taskUseCases.moveToDay (S-02)', () => {
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

  async function create(title: string, date: string, extra: { time?: string; spaceId?: typeof SPACE_PRO_ID; recurrence?: RecurrenceFields } = {}): Promise<TaskId> {
    db.clock.advance(1);
    const result = await useCases.create({
      title,
      spaceId: extra.spaceId ?? SPACE_PRO_ID,
      date: asLocalDate(date),
      ...(extra.time ? { time: asLocalTime(extra.time) } : {}),
      ...(extra.recurrence ? { recurrence: extra.recurrence } : {}),
    });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }

  it('change la date en base et dans la source unique, garde heure et espace (critères 1, 2)', async () => {
    const id = await create('Envoyer la facture', '2026-10-06', { time: '09:00', spaceId: SPACE_PERSO_ID });
    const moved = await useCases.moveToDay(id, asLocalDate('2026-10-07'));
    expect(moved).toMatchObject({ date: '2026-10-07', time: '09:00', spaceId: SPACE_PERSO_ID, carriedOver: false, someday: false });
    expect(await db.data.repos.tasks.getById(id)).toEqual(moved);
    expect(entities.get(id)).toEqual(moved);
  });

  it('efface le badge « reportée » (carriedOver repasse à faux, critère 2)', async () => {
    const id = await create('Reportée', '2026-10-06');
    await db.data.repos.tasks.update(id, { carriedOver: true });
    expect((await useCases.moveToDay(id, asLocalDate('2026-10-07'))).carriedOver).toBe(false);
  });

  it('place la tâche à la fin de l’ordre manuel du jour d’arrivée (critère 10)', async () => {
    await create('Déjà là A', '2026-10-07');
    await create('Déjà là B', '2026-10-07');
    const id = await create('Arrivée', '2026-10-06');
    await useCases.moveToDay(id, asLocalDate('2026-10-07'));
    const day = await db.data.repos.tasks.listForDay(asLocalDate('2026-10-07'), 'all');
    expect(day.map((task) => task.title)).toEqual(['Déjà là A', 'Déjà là B', 'Arrivée']);
  });

  it('une tâche terminée est déplaçable et reste terminée (critère 7)', async () => {
    const id = await create('Faite', '2026-10-06');
    await useCases.complete(id);
    const moved = await useCases.moveToDay(id, asLocalDate('2026-10-07'));
    expect(moved).toMatchObject({ date: '2026-10-07', status: 'done' });
    expect(moved.doneAt).not.toBeNull();
  });

  it('est annulable : message « déplacée au … », annuler remet date et position (critère 3)', async () => {
    const first = await create('Première', '2026-10-06');
    await create('Seconde', '2026-10-06');
    const before = await db.data.repos.tasks.getById(first);
    if (!before) throw new Error('tâche introuvable');
    await useCases.moveToDay(first, asLocalDate('2026-10-07'));
    const top = undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Première » déplacée au mer. 7 oct.');
    expect((await undo.undoLast()).status).toBe('undone');
    const restored = await db.data.repos.tasks.getById(first);
    expect(restored).toMatchObject({ date: '2026-10-06', sortOrder: before.sortOrder });
    expect(entities.get(first)?.date).toBe('2026-10-06');
    const day = await db.data.repos.tasks.listForDay(asLocalDate('2026-10-06'), 'all');
    expect(day.map((task) => task.title)).toEqual(['Première', 'Seconde']);
  });

  it('l’annulation est ignorée si la tâche a changé depuis (stale, rien n’est écrit)', async () => {
    const id = await create('Modifiée', '2026-10-06');
    await useCases.moveToDay(id, asLocalDate('2026-10-07'));
    await useCases.update(id, { title: 'Renommée' });
    expect((await undo.undoLast()).status).toBe('stale');
    expect((await db.data.repos.tasks.getById(id))?.date).toBe('2026-10-07');
  });

  it('même jour : rien n’est écrit ni empilé', async () => {
    const id = await create('Sur place', '2026-10-06');
    const before = await db.data.repos.tasks.getById(id);
    await useCases.moveToDay(id, asLocalDate('2026-10-06'));
    expect(await db.data.repos.tasks.getById(id)).toEqual(before);
    expect(undo.getSnapshot().size).toBe(0);
  });

  it('une occurrence récurrente ne déplace que cette occurrence : la série garde son ancre (critère 8)', async () => {
    const id = await create('Chaque jour', '2026-10-06', { recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } });
    const moved = await useCases.moveToDay(id, asLocalDate('2026-10-08'));
    expect(moved.date).toBe('2026-10-08');
    expect(moved.seriesTemplate).toMatchObject({ date: '2026-10-06', title: 'Chaque jour' });
    await useCases.complete(id);
    const next = (await db.data.repos.tasks.listByRecurrence(moved.recurrenceId ?? ('' as never))).find((task) => task.id !== id && task.status === 'todo');
    expect(next?.date).toBe('2026-10-07');
  });

  it('rejette une tâche inconnue et une date invalide', async () => {
    await expect(useCases.moveToDay(asEntityId<TaskId>('00000000-0000-4000-8000-000000000099'), asLocalDate('2026-10-07'))).rejects.toThrow();
    const id = await create('Valide', '2026-10-06');
    await expect(useCases.moveToDay(id, 'pas-une-date' as never)).rejects.toThrow(RangeError);
  });
});
