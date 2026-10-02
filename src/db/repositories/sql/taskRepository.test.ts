import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asLocalDate, type DeviceId, type GoalId, type RecurrenceId, type TaskId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { sampleSomedayTasks, sampleTodayTasks, testTaskId } from '../../seed/sampleData';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000002');
const DAY = asLocalDate('2026-10-05');

/** Lève si la fixture attendue est absente, au lieu d'une assertion non-null (`!`). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture manquante');
  return value;
}

describe('TaskRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée une tâche et la relit (T-01)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    const created = await db.data.repos.tasks.create(task);
    expect(created.id).toBe(task.id);
    expect(created.hlc).toBeTruthy();
    expect(created.createdAt).toBe(created.updatedAt);
    const read = await db.data.repos.tasks.getById(task.id);
    expect(read).toEqual(created);
  });

  it('createMany insère plusieurs tâches en conservant leurs champs', async () => {
    const created = await db.data.repos.tasks.createMany(sampleTodayTasks(DAY));
    expect(created).toHaveLength(2);
    expect(created.map((t) => t.title)).toEqual(['Envoyer la facture', 'Appeler le notaire']);
  });

  it('update ne modifie que les champs fournis et pose un nouveau tampon (hlc, updated_at)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    const created = await db.data.repos.tasks.create(task);
    db.clock.advance(500);
    const updated = await db.data.repos.tasks.update(task.id, { title: 'Envoyer la facture corrigée' });
    expect(updated.title).toBe('Envoyer la facture corrigée');
    expect(updated.note).toBe(created.note);
    expect(updated.hlc > created.hlc).toBe(true);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('enregistre et relit la note multi-lignes et l’icône (lucide ou emoji), T-03', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    const created = await db.data.repos.tasks.create({ ...task, note: 'Ligne 1\nLigne 2', icon: { kind: 'lucide', name: 'phone' } });
    expect(created.note).toBe('Ligne 1\nLigne 2');
    expect(created.icon).toEqual({ kind: 'lucide', name: 'phone' });
    const read = await db.data.repos.tasks.getById(task.id);
    expect(read).toEqual(created);

    const withEmoji = await db.data.repos.tasks.update(task.id, { icon: { kind: 'emoji', value: '📞' } });
    expect(withEmoji.icon).toEqual({ kind: 'emoji', value: '📞' });

    const withoutIcon = await db.data.repos.tasks.update(task.id, { icon: null, note: '' });
    expect(withoutIcon.icon).toBeNull();
    expect(withoutIcon.note).toBe('');
  });

  it("lève RepositoryError('not-found') sur un id inconnu", async () => {
    await expect(db.data.repos.tasks.update(testTaskId('999'), { title: 'x' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('complete puis reopen (T-04 et annulation)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    const done = await db.data.repos.tasks.complete(task.id, '2026-10-05T10:00:00.000Z' as never);
    expect(done.status).toBe('done');
    expect(done.doneAt).not.toBeNull();
    const reopened = await db.data.repos.tasks.reopen(task.id);
    expect(reopened.status).toBe('todo');
    expect(reopened.doneAt).toBeNull();
  });

  it('reschedule conserve l’heure si elle n’est pas fournie, la change sinon (T-05)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    const tomorrow = asLocalDate('2026-10-06');
    const [moved] = await db.data.repos.tasks.reschedule([task.id], tomorrow);
    expect(moved?.date).toBe(tomorrow);
    expect(moved?.time).toBe(task.time);
    expect(moved?.someday).toBe(false);

    const [movedWithTime] = await db.data.repos.tasks.reschedule([task.id], tomorrow, null);
    expect(movedWithTime?.time).toBeNull();
  });

  it('moveToSomeday retire date et heure (SD-03)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    const [moved] = await db.data.repos.tasks.moveToSomeday([task.id]);
    expect(moved?.date).toBeNull();
    expect(moved?.time).toBeNull();
    expect(moved?.someday).toBe(true);
  });

  it('carryOver marque la tâche reportée (T-06)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    const tomorrow = asLocalDate('2026-10-06');
    const [carried] = await db.data.repos.tasks.carryOver([task.id], tomorrow);
    expect(carried?.date).toBe(tomorrow);
    expect(carried?.carriedOver).toBe(true);
  });

  it('moveToSpace change espace et projet par lot (ES-05)', async () => {
    const tasks = sampleTodayTasks(DAY);
    await db.data.repos.tasks.createMany(tasks);
    const ids = tasks.map((t) => t.id);
    const moved = await db.data.repos.tasks.moveToSpace(ids, SPACE_PERSO_ID, null);
    expect(moved.every((t) => t.spaceId === SPACE_PERSO_ID)).toBe(true);
  });

  it('setSortOrders persiste un ordre manuel', async () => {
    const tasks = sampleTodayTasks(DAY);
    await db.data.repos.tasks.createMany(tasks);
    const [first, second] = tasks;
    await db.data.repos.tasks.setSortOrders([
      { id: must(first).id, sortOrder: 9 },
      { id: must(second).id, sortOrder: 1 },
    ]);
    const list = await db.data.repos.tasks.listForDay(DAY, 'all');
    expect(list.map((t) => t.id)).toEqual([must(second).id, must(first).id]);
  });

  it('softDelete puis restore (T-08), exclues des lectures entre temps', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    await db.data.repos.tasks.softDelete([task.id]);
    expect(await db.data.repos.tasks.getById(task.id)).toBeNull();
    expect(await db.data.repos.tasks.listForDay(DAY, 'all')).toEqual([]);
    const trash = await db.data.repos.tasks.listTrash('2000-01-01T00:00:00.000Z' as never, 'all');
    expect(trash.map((t) => t.id)).toEqual([task.id]);

    const [restored] = await db.data.repos.tasks.restore([task.id]);
    expect(restored?.deletedAt).toBeNull();
    expect(await db.data.repos.tasks.getById(task.id)).not.toBeNull();
  });

  it('listForDay filtre par espace (ES-03)', async () => {
    await db.data.repos.tasks.createMany(sampleTodayTasks(DAY));
    expect(await db.data.repos.tasks.listForDay(DAY, SPACE_PRO_ID)).toHaveLength(1);
    expect(await db.data.repos.tasks.listForDay(DAY, SPACE_PERSO_ID)).toHaveLength(1);
    expect(await db.data.repos.tasks.listForDay(DAY, 'all')).toHaveLength(2);
  });

  it('listForWeek couvre les 7 jours depuis weekStart (S-01)', async () => {
    const monday = asLocalDate('2026-10-05');
    const sunday = asLocalDate('2026-10-11');
    const outside = asLocalDate('2026-10-12');
    await db.data.repos.tasks.createMany([
      must(sampleTodayTasks(monday)[0]),
      { ...must(sampleTodayTasks(sunday)[1]), id: testTaskId('10') },
      { ...must(sampleTodayTasks(outside)[0]), id: testTaskId('11') },
    ]);
    const week = await db.data.repos.tasks.listForWeek(monday, 'all');
    expect(week).toHaveLength(2);
  });

  it('listSomeday et countSomeday (SD-01)', async () => {
    await db.data.repos.tasks.createMany(sampleSomedayTasks());
    expect(await db.data.repos.tasks.countSomeday('all')).toBe(3);
    expect(await db.data.repos.tasks.countSomeday(SPACE_PRO_ID)).toBe(1);
    const list = await db.data.repos.tasks.listSomeday('all');
    expect(list).toHaveLength(3);
  });

  it('listUndoneBefore ignore les tâches faites et sans date (T-06, T-09)', async () => {
    const before = asLocalDate('2026-10-01');
    await db.data.repos.tasks.createMany([
      { ...must(sampleTodayTasks(before)[0]), id: testTaskId('20') },
      must(sampleSomedayTasks()[0]),
    ]);
    const undone = await db.data.repos.tasks.listUndoneBefore(DAY);
    expect(undone.map((t) => t.id)).toEqual([testTaskId('20')]);
  });

  it('listDone filtre sur done_at (T-07)', async () => {
    const [task] = sampleTodayTasks(DAY);
    if (!task) throw new Error('fixture manquante');
    await db.data.repos.tasks.create(task);
    await db.data.repos.tasks.complete(task.id, '2026-10-05T10:00:00.000Z' as never);
    const done = await db.data.repos.tasks.listDone(
      { from: '2026-10-05T00:00:00.000Z' as never, to: '2026-10-06T00:00:00.000Z' as never },
      'all',
    );
    expect(done.map((t) => t.id)).toEqual([task.id]);
    expect(
      await db.data.repos.tasks.listDone(
        { from: '2026-10-06T00:00:00.000Z' as never, to: '2026-10-07T00:00:00.000Z' as never },
        'all',
      ),
    ).toEqual([]);
  });

  it('listByGoal et progressByGoal agrègent par statut (OB-03, OB-04)', async () => {
    const goalId = asEntityId<GoalId>('50000000-0000-4000-8000-000000000001');
    await db.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart: asLocalDate('2026-10-05'),
      title: 'Clôturer le trimestre',
      icon: null,
      pinned: false,
      status: 'open',
      carriedFromId: null,
    });
    const [t1, t2] = sampleTodayTasks(DAY);
    await db.data.repos.tasks.createMany([
      { ...must(t1), goalId },
      { ...must(t2), id: testTaskId('30'), goalId },
    ]);
    await db.data.repos.tasks.complete(must(t1).id, '2026-10-05T10:00:00.000Z' as never);
    const byGoal = await db.data.repos.tasks.listByGoal(goalId);
    expect(byGoal).toHaveLength(2);
    const progress = await db.data.repos.tasks.progressByGoal([goalId]);
    expect(progress.get(goalId)).toEqual({ done: 1, total: 2 });
  });

  it('listByRecurrence (T-10)', async () => {
    const recurrenceId = asEntityId<RecurrenceId>('60000000-0000-4000-8000-000000000001');
    await db.data.repos.recurrences.create({
      id: recurrenceId,
      freq: 'daily',
      interval: 1,
      weekdays: [],
      monthDay: null,
      nthWeekday: null,
      until: null,
      count: null,
    });
    const [t1] = sampleTodayTasks(DAY);
    await db.data.repos.tasks.create({ ...must(t1), recurrenceId, seriesIndex: 0 });
    const list = await db.data.repos.tasks.listByRecurrence(recurrenceId);
    expect(list).toHaveLength(1);
  });

});

describe('RecurrenceRepository (SQL)', () => {
  let db: TestDb;
  const recurrenceId = asEntityId<RecurrenceId>('70000000-0000-4000-8000-000000000001');

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée, édite, supprime et restaure une règle de récurrence (T-09, T-10)', async () => {
    const created = await db.data.repos.recurrences.create({
      id: recurrenceId,
      freq: 'weekly',
      interval: 1,
      weekdays: [1, 3, 5],
      monthDay: null,
      nthWeekday: null,
      until: null,
      count: null,
    });
    expect(created.weekdays).toEqual([1, 3, 5]);

    const updated = await db.data.repos.recurrences.update(recurrenceId, { interval: 2 });
    expect(updated.interval).toBe(2);

    const deleted = await db.data.repos.recurrences.softDelete(recurrenceId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await db.data.repos.recurrences.getById(recurrenceId)).toBeNull();

    const restored = await db.data.repos.recurrences.restore(recurrenceId);
    expect(restored.deletedAt).toBeNull();
  });
});

describe('Identité de l’id choisi TaskId', () => {
  it('testTaskId produit un identifiant stable et valide', () => {
    const id: TaskId = testTaskId('42');
    expect(id).toBe(testTaskId('42'));
  });
});
