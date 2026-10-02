import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000005');

// Horloge de test : 2026-10-02 08:00 UTC = vendredi 2 octobre.
describe('taskUseCases.postpone (T-05)', () => {
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

  async function create(title: string, date: string | null, time: string | null = null): Promise<TaskId> {
    const result = await useCases.create({
      title,
      spaceId: SPACE_PRO_ID,
      date: date === null ? null : asLocalDate(date),
      ...(time ? { time: asLocalTime(time) } : {}),
      ...(date === null ? { someday: true } : {}),
    });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }

  it('« Demain » part d’aujourd’hui (pas de la date de la tâche), garde l’heure, sans carriedOver (critères 2, 7)', async () => {
    const id = await create('Courses', '2026-10-09', '10:00');
    const [task] = await useCases.postpone([id], 'tomorrow');
    expect(task).toMatchObject({ date: '2026-10-03', time: '10:00', carriedOver: false });
    expect(await db.data.repos.tasks.getById(id)).toEqual(task);
    expect(entities.get(id)).toEqual(task);
  });

  it('« Semaine prochaine » = lundi suivant (critère 3) ; une date choisie est appliquée', async () => {
    const id = await create('Rapport', '2026-10-02');
    expect((await useCases.postpone([id], 'next-week'))[0]?.date).toBe('2026-10-05');
    expect((await useCases.postpone([id], { date: asLocalDate('2026-12-24') }))[0]?.date).toBe('2026-12-24');
  });

  it('annulable : le message cite le titre, annuler rétablit date et heure (critère 6)', async () => {
    const id = await create('Courses', '2026-10-02', '10:00');
    await useCases.postpone([id], 'tomorrow');
    const top = undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Courses » reportée à demain');

    expect((await undo.undoLast()).status).toBe('undone');
    expect(entities.get(id)).toMatchObject({ date: '2026-10-02', time: '10:00' });
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-10-02', time: '10:00' });
  });

  it('message avec date pour une autre cible', async () => {
    const id = await create('Courses', '2026-10-02');
    await useCases.postpone([id], 'next-week');
    const top = undo.getSnapshot().top;
    expect(top && undoMessage(top)).toMatch(/^« Courses » reportée au lun\. 5 oct\.$/);
  });

  it('annulation périmée si la tâche a changé depuis : rien n’est écrit', async () => {
    const id = await create('Courses', '2026-10-02');
    await useCases.postpone([id], 'tomorrow');
    await useCases.update(id, { note: 'modifiée ailleurs' });
    expect((await undo.undoLast()).status).toBe('stale');
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-10-03' });
  });

  it('une tâche « Un jour » est planifiée, et annuler la remet en « Un jour » (critère 8)', async () => {
    const id = await create('Idée', null);
    expect((await useCases.postpone([id], 'tomorrow'))[0]).toMatchObject({ date: '2026-10-03', someday: false });
    await undo.undoLast();
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: null, someday: true });
  });

  it('ignore une tâche terminée (critère 9) et ne pousse aucune commande', async () => {
    const id = await create('Faite', '2026-10-02');
    await useCases.complete(id);
    const before = undo.getSnapshot().size;
    expect(await useCases.postpone([id], 'tomorrow')).toEqual([]);
    expect(undo.getSnapshot().size).toBe(before);
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-10-02', status: 'done' });
  });

  it('refuse une date inexistante sans rien écrire', async () => {
    const id = await create('Courses', '2026-10-02');
    await expect(useCases.postpone([id], { date: '2026-02-30' as never })).rejects.toBeInstanceOf(RangeError);
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-10-02' });
  });

  it('reporte un lot en une seule commande annulable', async () => {
    const a = await create('A', '2026-10-02');
    const b = await create('B', '2026-10-02', '09:00');
    expect(await useCases.postpone([a, b], 'tomorrow')).toHaveLength(2);
    expect(undo.getSnapshot().size).toBe(1);
    await undo.undoLast();
    expect(await db.data.repos.tasks.getById(b)).toMatchObject({ date: '2026-10-02', time: '09:00' });
  });
});
