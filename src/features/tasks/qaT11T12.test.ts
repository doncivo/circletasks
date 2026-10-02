// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { toKeyInput } from '../app/shortcuts';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { duplicateDefaultDate } from '../../domain/taskDuplicate';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000099');

describe('QA T-11 : rappels flottants (critères 2, 7)', () => {
  const initialTz = process.env['TZ'];
  afterEach(() => {
    if (initialTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = initialTz;
  });
  it('T-11 critère 2 : fire_at est identique à Paris, Tunis et le jour du passage à l’heure d’été', () => {
    const results = ['Europe/Paris', 'Africa/Tunis', 'Pacific/Auckland'].map((tz) => {
      process.env['TZ'] = tz;
      return [reminderFireAt(asLocalDate('2026-09-23'), '10:00', 30), reminderFireAt(asLocalDate('2026-03-29'), '02:30', 0)];
    });
    for (const r of results) expect(r).toEqual(['2026-09-23T09:30', '2026-03-29T02:30']);
  });
});

describe('QA T-12 : cas limites', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
  });
  afterEach(() => db.close());

  it('T-12 critères 1, 4 : dupliquer une occurrence récurrente donne une copie « Une fois », la série reste intacte', async () => {
    const uc = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() });
    const r = await uc.create({
      title: 'Sport',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-10-08'),
      time: asLocalTime('18:00'),
      recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } as never,
    });
    if (!r.ok) throw new Error('création');
    const before = await db.data.repos.tasks.getById(r.value.id);
    expect(before?.recurrenceId).not.toBeNull();
    expect(duplicateDefaultDate(before as never, asLocalDate('2026-10-02'))).toBe('2026-10-08');
    const copy = await uc.duplicate(r.value.id, asLocalDate('2026-10-08'));
    expect(copy).toMatchObject({ recurrenceId: null, seriesIndex: null, date: '2026-10-08', time: '18:00', status: 'todo' });
    expect(await db.data.repos.tasks.getById(r.value.id)).toEqual(before);
  });

  it('T-12 critère 1 (Q8) : une tâche Un jour présélectionne « Un jour » et la copie reste Un jour', async () => {
    const uc = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() });
    const r = await uc.create({ title: 'Idée', spaceId: SPACE_PRO_ID, date: null, someday: true });
    if (!r.ok) throw new Error('création');
    const original = await db.data.repos.tasks.getById(r.value.id);
    const pre = duplicateDefaultDate(original as never, asLocalDate('2026-10-02'));
    expect(pre).toBeNull();
    const copy = await uc.duplicate(r.value.id, pre);
    expect(copy).toMatchObject({ someday: true, date: null, time: null });
  });
});

describe('QA T-13 : Ctrl+Z dans un vrai champ', () => {
  it('T-13 critère 4 : un événement clavier issu d’un input, textarea ou contenteditable est « editable »', () => {
    const mk = (el: HTMLElement) => {
      document.body.append(el);
      let input: ReturnType<typeof toKeyInput> | null = null;
      el.addEventListener('keydown', (e) => (input = toKeyInput(e)));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      el.remove();
      return input as unknown as { editable: boolean };
    };
    expect(mk(document.createElement('input')).editable).toBe(true);
    expect(mk(document.createElement('textarea')).editable).toBe(true);
    expect(mk(document.createElement('button')).editable).toBe(false);
  });
});
