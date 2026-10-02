import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack, undoMessage, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000013');

/**
 * T-13 : intégration du mécanisme commun avec les actions livrées (terminer, reporter, dupliquer,
 * supprimer) sur de vrais repositories : messages, ordre d'annulation, état exact rétabli,
 * lot au pluriel, 'stale' après modification.
 */
describe('annulation généralisée (T-13)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;
  let undo: UndoStack;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    undo = createUndoStack();
    useCases = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: createTaskEntities() });
  });
  afterEach(() => db.close());

  async function create(title: string, date = '2026-10-02', time: string | null = '10:00'): Promise<TaskId> {
    const result = await useCases.create({ title, spaceId: SPACE_PRO_ID, date: asLocalDate(date), ...(time ? { time: asLocalTime(time) } : {}) });
    if (!result.ok) throw new Error('création impossible');
    return result.value.id;
  }
  const topMessage = () => {
    const top = undo.getSnapshot().top;
    return top ? undoMessage(top) : null;
  };

  it('terminer, reporter, supprimer puis 3 annulations : chaque état exact est rétabli (critères 1, 2, 4)', async () => {
    const a = await create('Courses');
    const b = await create('Rapport', '2026-10-02', '14:30');
    const c = await create('Médecin', '2026-10-02', null);
    const before = await Promise.all([a, b, c].map((id) => db.data.repos.tasks.getById(id)));

    await useCases.complete(a);
    expect(topMessage()).toBe('« Courses » terminée');
    await useCases.postpone([b], 'tomorrow');
    expect(topMessage()).toBe('« Rapport » reportée à demain');
    await useCases.remove([c]);
    expect(topMessage()).toBe('« Médecin » supprimée');

    for (let i = 0; i < 3; i += 1) expect((await undo.undoLast()).status).toBe('undone');
    expect((await undo.undoLast()).status).toBe('empty');

    const after = await Promise.all([a, b, c].map((id) => db.data.repos.tasks.getById(id)));
    for (const [index, task] of after.entries()) {
      expect(task).toMatchObject({
        status: before[index]?.status,
        date: before[index]?.date,
        time: before[index]?.time,
        deletedAt: null,
        doneAt: before[index]?.doneAt,
      });
    }
  });

  it('dupliquer entre dans la même pile : message « dupliquée », annulation de la copie (critère 1)', async () => {
    const a = await create('Courses');
    const copy = await useCases.duplicate(a, asLocalDate('2026-10-03'));
    expect(topMessage()).toBe('« Courses » dupliquée');
    await undo.undoLast();
    expect(await db.data.repos.tasks.getById(copy.id)).toBeNull();
  });

  it('report au jour choisi : message avec la date (critère 1)', async () => {
    const a = await create('Courses');
    await useCases.postpone([a], { date: asLocalDate('2026-10-15') });
    expect(topMessage()).toMatch(/^« Courses » reportée au .*15/);
  });

  it('lot de 3 tâches : une seule annulation, message au pluriel (critère 6)', async () => {
    const ids = [await create('Un'), await create('Deux'), await create('Trois')];
    await useCases.postpone(ids, 'tomorrow');
    expect(undo.getSnapshot().size).toBe(1);
    expect(topMessage()).toBe('3 tâches reportées');
    await undo.undoLast();
    for (const id of ids) expect((await db.data.repos.tasks.getById(id))?.date).toBe('2026-10-02');
  });

  it('suppression de 3 tâches : « 3 tâches supprimées », une seule annulation', async () => {
    const ids = [await create('Un'), await create('Deux'), await create('Trois')];
    await useCases.remove(ids);
    expect(topMessage()).toBe('3 tâches supprimées');
    expect((await undo.undoLast()).status).toBe('undone');
    for (const id of ids) expect((await db.data.repos.tasks.getById(id))?.deletedAt).toBeNull();
  });

  it('tâche modifiée depuis l’action : « stale », rien n’est écrit (critère 7)', async () => {
    const a = await create('Courses');
    await useCases.complete(a);
    await useCases.update(a, { note: 'modifiée après' });
    const written = await db.data.repos.tasks.getById(a);
    expect((await undo.undoLast()).status).toBe('stale');
    expect(await db.data.repos.tasks.getById(a)).toEqual(written);
  });

  it('les actions non listées (créer, modifier le titre ou la note) ne poussent aucune commande (critère 10)', async () => {
    const a = await create('Courses');
    await useCases.update(a, { note: 'x', title: 'Courses 2' });
    expect(undo.getSnapshot().size).toBe(0);
  });

  it('une nouvelle session démarre avec une pile vide (critère 8)', () => {
    expect(createUndoStack().getSnapshot()).toMatchObject({ size: 0, top: null });
  });
});
