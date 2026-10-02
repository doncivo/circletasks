import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { ReminderOffsetMin, Task } from '../../domain/model';
import { computeFireAt } from '../../domain/reminders';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000013');

/** QA N-02 : cas limites supplémentaires (suppression / restauration T-08, dédoublonnage, changement d'heure, aucun plugin). */
describe('QA rappels (N-02)', () => {
  let db: TestDb;
  let undo: UndoStack;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-09-23T08:00:00.000Z');
    undo = createUndoStack();
  });
  afterEach(async () => {
    await db.close();
  });
  const cases = () => createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: createTaskEntities() });
  const rows = (task: Task) => db.data.repos.reminders.listForTarget({ type: 'task', id: task.id });
  async function create(offsets: ReminderOffsetMin[], date = '2026-03-01', time = '09:00'): Promise<Task> {
    const r = await cases().create({ title: 'T', spaceId: SPACE_PRO_ID, date: asLocalDate(date), time: asLocalTime(time), reminderOffsets: offsets });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  it('N-02 c.2 plusieurs avances identiques à la création : une seule ligne par avance', async () => {
    const task = await create([30, 30, 0, 0] as ReminderOffsetMin[]);
    expect((await rows(task)).map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('N-02 c.6 « 1 jour » le 1er du mois : fin de mois précédent, y compris 1er janvier et 1er mars bissextile', async () => {
    expect((await rows(await create([1440], '2026-01-01')))[0]?.fireAt).toBe('2025-12-31T09:00');
    expect((await rows(await create([1440], '2028-03-01')))[0]?.fireAt).toBe('2028-02-29T09:00');
    expect((await rows(await create([1440], '2026-05-01')))[0]?.fireAt).toBe('2026-04-30T09:00');
  });

  it('N-02 c.6 changement d’heure : « 1 jour » reste à la même heure locale (heure flottante)', () => {
    expect(computeFireAt(asLocalDate('2026-03-29'), asLocalTime('09:00'), 1440)).toBe('2026-03-28T09:00');
    expect(computeFireAt(asLocalDate('2026-03-30'), asLocalTime('09:00'), 1440)).toBe('2026-03-29T09:00');
    expect(computeFireAt(asLocalDate('2026-10-25'), asLocalTime('03:00'), 1440)).toBe('2026-10-24T03:00');
    expect(computeFireAt(asLocalDate('2026-10-26'), asLocalTime('09:00'), 60)).toBe('2026-10-26T08:00');
  });

  it('N-02 c.8 / T-08 : annuler la suppression ne réactive que les rappels supprimés avec la tâche', async () => {
    const task = await create([0, 30, 1440]);
    expect((await cases().setReminders(task.id, [0, 30])).ok).toBe(true); // 1440 supprimé avant la tâche
    await cases().remove([task.id]);
    expect(await rows(task)).toEqual([]);
    expect((await undo.undoLast()).status).toBe('undone');
    expect((await rows(task)).map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('N-02 c.8 : suppression puis restauration, rappels dus de nouveau avec leur échéance', async () => {
    const task = await create([0, 15]);
    await cases().remove([task.id]);
    await undo.undoLast();
    expect((await rows(task)).map((r) => [r.offsetMin, r.fireAt]).sort()).toEqual([
      [0, '2026-03-01T09:00'],
      [15, '2026-03-01T08:45'],
    ]);
  });

  it('QB-10 : « Un jour » puis annulation, rappels inchangés ; heure redonnée recalcule fire_at', async () => {
    const task = await create([0]);
    await cases().moveToSomeday([task.id]);
    await undo.undoLast();
    expect((await rows(task)).map((r) => r.fireAt)).toEqual(['2026-03-01T09:00']);
    await cases().moveToSomeday([task.id]);
    // « Un jour » efface l'heure : les rappels restent, inactifs ; une heure redonnée les recalcule.
    await cases().moveToDay(task.id, asLocalDate('2026-04-02'));
    expect((await rows(task)).map((r) => r.fireAt)).toEqual(['2026-03-01T09:00']);
    await cases().update(task.id, { time: asLocalTime('10:00') });
    expect((await rows(task)).map((r) => r.fireAt)).toEqual(['2026-04-02T10:00']);
  });

  it('N-02 c.9 / N-04 c.7 : aucun plugin de notification dans package.json, Cargo.toml, capabilities', () => {
    const root = join(__dirname, '..', '..', '..');
    for (const file of ['package.json', 'src-tauri/Cargo.toml']) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/notification/i);
    }
  });
});
