import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createCarryOverUseCases, type CarryOverUseCases } from './carryOverUseCases';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000006');

// Horloge locale : on utilise des instants à midi UTC, donc le même jour civil dans tous les fuseaux courants.
describe('carryOver (T-06)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;
  let carry: CarryOverUseCases;
  let undo: UndoStack;
  let entities: TaskEntities;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-09-23T12:00:00.000Z');
    undo = createUndoStack();
    entities = createTaskEntities();
    useCases = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: entities });
    carry = createCarryOverUseCases({ clock: db.clock, data: db.data, taskEntities: entities });
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

  const get = async (id: TaskId) => db.data.repos.tasks.getById(id);

  it('réglage actif par défaut (critère 11) : report à aujourd’hui, heure conservée, carriedOver, publié (critère 1)', async () => {
    expect(await db.data.repos.settings.get('tasks.carryOverUndone')).toBe(true);
    const id = await create('Courses', '2026-09-22', '10:00');
    db.clock.advance(24 * 3_600_000); // 24 sept.
    const carried = await carry.run();
    expect(carried).toHaveLength(1);
    expect(await get(id)).toMatchObject({ date: '2026-09-24', time: '10:00', carriedOver: true });
    expect(entities.get(id)).toMatchObject({ date: '2026-09-24', carriedOver: true });
  });

  it('rattrape plusieurs jours sautés en une transaction (critère 2) et n’est pas annulable (critère 10)', async () => {
    const a = await create('A', '2026-09-20');
    const b = await create('B', '2026-09-21');
    const c = await create('C', '2026-09-22');
    db.clock.advance(1000);
    const carried = await carry.run();
    expect(carried.map((t) => t.id).sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) expect(await get(id)).toMatchObject({ date: '2026-09-23', carriedOver: true });
    expect(undo.getSnapshot().top).toBeNull();
  });

  it('est idempotente : un second passage le même jour n’écrit rien (critères 1, 9)', async () => {
    const id = await create('A', '2026-09-20');
    await carry.run();
    const before = await get(id);
    expect(await carry.run()).toEqual([]);
    expect(await get(id)).toEqual(before);
  });

  it('n’atteint ni terminées, ni Un jour, ni sans date, ni futures, ni du jour (critère 6)', async () => {
    const done = await create('Faite', '2026-09-20');
    await useCases.complete(done);
    const someday = await create('Un jour', null);
    const future = await create('Futur', '2026-09-30');
    const todayId = await create('Jour', '2026-09-23');
    expect(await carry.run()).toEqual([]);
    expect(await get(done)).toMatchObject({ date: '2026-09-20', carriedOver: false });
    expect(await get(someday)).toMatchObject({ date: null, someday: true });
    expect(await get(future)).toMatchObject({ date: '2026-09-30' });
    expect(await get(todayId)).toMatchObject({ date: '2026-09-23', carriedOver: false });
  });

  it('réglage désactivé : aucune date ne change (critère 5)', async () => {
    await db.data.repos.settings.set('tasks.carryOverUndone', false);
    const id = await create('A', '2026-09-20');
    expect(await carry.run()).toEqual([]);
    expect(await get(id)).toMatchObject({ date: '2026-09-20', carriedOver: false });
  });

  it('occurrence récurrente non faite : reportée comme toute tâche, la suivante reste à sa date (Q2, critère 7)', async () => {
    // T-09 n'existe pas encore : les deux occurrences sont deux tâches datées (sans lien de récurrence).
    const rent = await create('Payer le loyer', '2026-09-22');
    const next = await create('Payer le loyer', '2026-10-22');
    await carry.run();
    expect(await get(rent)).toMatchObject({ date: '2026-09-23', carriedOver: true });
    expect(await get(next)).toMatchObject({ date: '2026-10-22', carriedOver: false });
  });

  it('terminer, reporter à la main ou changer la date efface carriedOver (critère 4)', async () => {
    const a = await create('A', '2026-09-20');
    const b = await create('B', '2026-09-20');
    const c = await create('C', '2026-09-20');
    const e = await create('E', '2026-09-20');
    await carry.run();
    expect((await useCases.complete(a)).carriedOver).toBe(false);
    expect((await useCases.postpone([b], 'tomorrow'))[0]?.carriedOver).toBe(false);
    expect((await useCases.update(c, { date: asLocalDate('2026-09-30') })).carriedOver).toBe(false);
    // Une autre modification (titre) conserve le badge.
    expect((await useCases.update(e, { title: 'E2' })).carriedOver).toBe(true);
    expect(await get(a)).toMatchObject({ status: 'done', carriedOver: false });
  });

  it('annuler la complétion d’une tâche reportée restaure le badge', async () => {
    const id = await create('A', '2026-09-20');
    await carry.run();
    await useCases.complete(id);
    expect(await get(id)).toMatchObject({ status: 'done', carriedOver: false });
    expect((await undo.undoLast()).status).toBe('undone');
    expect(await get(id)).toMatchObject({ status: 'todo', date: '2026-09-23', carriedOver: true });
    expect(entities.get(id)?.carriedOver).toBe(true);
  });

  it('annuler un report manuel restaure aussi le badge', async () => {
    const id = await create('A', '2026-09-20');
    await carry.run();
    await useCases.postpone([id], 'tomorrow');
    const top = undo.getSnapshot().top;
    expect(top).not.toBeNull();
    expect((await undo.undoLast()).status).toBe('undone');
    expect(await get(id)).toMatchObject({ date: '2026-09-23', carriedOver: true });
  });
});
