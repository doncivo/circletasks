import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { ReminderOffsetMin, Task } from '../../domain/model';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack } from '../app/undo';
import { createCarryOverUseCases } from './carryOverUseCases';
import { createTaskUseCases } from './createTaskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000012');

/** N-02 : rappels d'une tâche (création, édition, recalcul, suppression). Ordre 1 : données seulement. */
describe('rappels des tâches (N-02)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-09-23T08:00:00.000Z');
  });
  afterEach(async () => {
    await db.close();
  });

  const taskEntities = createTaskEntities();
  const taskCases = () => createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities });
  const rows = (task: Task) => db.data.repos.reminders.listForTarget({ type: 'task', id: task.id });
  const summary = async (task: Task) => (await rows(task)).map((r) => [r.offsetMin, r.fireAt]);

  async function create(time: string | null, offsets: ReminderOffsetMin[], date = '2026-03-01'): Promise<Task> {
    const result = await taskCases().create({
      title: 'Point',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate(date),
      ...(time ? { time: asLocalTime(time) } : {}),
      reminderOffsets: offsets,
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  it('créer avec « À l’heure » et « 30 min » écrit deux lignes (critère 1)', async () => {
    const task = await create('09:00', [0, 30]);
    expect(await summary(task)).toEqual([
      [30, '2026-03-01T08:30'],
      [0, '2026-03-01T09:00'],
    ]);
  });

  it('« 1 jour avant » : 28 février 09:00 (critère 6)', async () => {
    const task = await create('09:00', [1440]);
    expect(await summary(task)).toEqual([[1440, '2026-02-28T09:00']]);
  });

  it('aucun rappel créé sans heure (critère 7)', async () => {
    const task = await create(null, [0, 30]);
    expect(await rows(task)).toEqual([]);
  });

  it('setReminders ajoute et supprime logiquement, sans doublon (critères 2, 4)', async () => {
    const task = await create('09:00', [0]);
    expect(await taskCases().setReminders(task.id, [0, 15, 15, 1440])).toEqual({ ok: true, value: [0, 15, 1440] });
    expect(await taskCases().setReminders(task.id, [15])).toEqual({ ok: true, value: [15] });
    expect((await rows(task)).map((r) => r.offsetMin)).toEqual([15]);
    const all = await db.driver.select<{ offset_min: number; deleted_at: string | null }>(
      'SELECT offset_min, deleted_at FROM reminder WHERE target_id = ? ORDER BY offset_min',
      [task.id],
    );
    expect(all.filter((r) => r.deleted_at !== null).map((r) => r.offset_min)).toEqual([0, 1440]);
  });

  it('setReminders refuse sans heure, mais accepte de tout vider (critère 7)', async () => {
    const task = await create(null, []);
    expect(await taskCases().setReminders(task.id, [0])).toEqual({ ok: false, error: 'needs-time' });
    expect(await taskCases().setReminders(task.id, [])).toEqual({ ok: true, value: [] });
    expect(await taskCases().setReminders(asEntityId<TaskId>('30000000-0000-4000-8000-000000000099'), [0])).toEqual({ ok: false, error: 'not-found' });
  });

  it('changer la date ou l’heure recalcule fire_at, avances conservées (critère 5)', async () => {
    const task = await create('09:00', [0, 30]);
    await taskCases().update(task.id, { time: asLocalTime('14:00') });
    expect(await summary(task)).toEqual([
      [30, '2026-03-01T13:30'],
      [0, '2026-03-01T14:00'],
    ]);
    await taskCases().update(task.id, { date: asLocalDate('2026-03-05') });
    expect(await summary(task)).toEqual([
      [30, '2026-03-05T13:30'],
      [0, '2026-03-05T14:00'],
    ]);
    await taskCases().moveToDay(task.id, asLocalDate('2026-03-07'));
    expect((await summary(task))[1]).toEqual([0, '2026-03-07T14:00']);
    await taskCases().postpone([task.id], { date: asLocalDate('2026-03-09') });
    expect((await summary(task))[1]).toEqual([0, '2026-03-09T14:00']);
  });

  it('effacer l’heure conserve les rappels, inactifs ; une heure de nouveau choisie les reprend (critère 7)', async () => {
    const task = await create('09:00', [0]);
    await taskCases().update(task.id, { time: null });
    expect(await summary(task)).toEqual([[0, '2026-03-01T09:00']]); // conservé, non recalculé
    await taskCases().update(task.id, { time: asLocalTime('11:00') });
    expect(await summary(task)).toEqual([[0, '2026-03-01T11:00']]);
  });

  it('envoyer dans « Un jour » conserve les rappels, inactifs (QB-10)', async () => {
    const task = await create('09:00', [0]);
    await taskCases().moveToSomeday([task.id]);
    expect((await rows(task)).length).toBe(1);
  });

  it('le report automatique recalcule les rappels (critère 5)', async () => {
    const task = await create('09:00', [30], '2026-09-20');
    await createCarryOverUseCases({ clock: db.clock, data: db.data, taskEntities }).run();
    expect(await summary(task)).toEqual([[30, '2026-09-23T08:30']]);
  });

  it('supprimer la tâche rend ses rappels non dus (critère 8)', async () => {
    const task = await create('09:00', [0, 30]);
    await taskCases().remove([task.id]);
    expect(await rows(task)).toEqual([]);
  });

  it('dupliquer recopie les rappels avec l’échéance de la nouvelle date (T-12)', async () => {
    const task = await create('09:00', [0, 30]);
    const copy = await taskCases().duplicate(task.id, asLocalDate('2026-03-10'));
    expect(await summary(copy)).toEqual([
      [30, '2026-03-10T08:30'],
      [0, '2026-03-10T09:00'],
    ]);
  });

  it('terminer une tâche récurrente recopie les rappels sur l’occurrence suivante (T-09)', async () => {
    const result = await taskCases().create({
      title: 'Quotidienne',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-09-22'),
      time: asLocalTime('09:00'),
      reminderOffsets: [0, 15],
      recurrence: defaultRecurrence('daily', asLocalDate('2026-09-22')),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await summary(result.value)).toEqual([
      [15, '2026-09-22T08:45'],
      [0, '2026-09-22T09:00'],
    ]);
    await taskCases().complete(result.value.id);
    const next = (await db.data.repos.tasks.listForDay(asLocalDate('2026-09-23'), 'all')).find((task) => task.id !== result.value.id);
    expect(next).toBeDefined();
    if (next) {
      expect(await summary(next)).toEqual([
        [15, '2026-09-23T08:45'],
        [0, '2026-09-23T09:00'],
      ]);
    }
  });

  it('feuille « Modifier » : champs et rappels en une transaction ; rappel refusé, rien n’est écrit', async () => {
    const task = await create('09:00', [0]);
    // Heure effacée dans la même feuille que des rappels : refusé, le titre n'est pas écrit non plus.
    const refused = await taskCases().updateWithReminders(task.id, { title: 'Autre', time: null }, [0, 30]);
    expect(refused).toEqual({ ok: false, error: 'needs-time' });
    const stored = await db.data.repos.tasks.getById(task.id);
    expect(stored?.title).toBe('Point');
    expect(stored?.time).toBe('09:00');
    expect(await summary(task)).toEqual([[0, '2026-03-01T09:00']]);
    const ok = await taskCases().updateWithReminders(task.id, { title: 'Autre', time: asLocalTime('10:00') }, [0, 30]);
    expect(ok.ok).toBe(true);
    expect(await summary(task)).toEqual([
      [30, '2026-03-01T09:30'],
      [0, '2026-03-01T10:00'],
    ]);
  });
});
