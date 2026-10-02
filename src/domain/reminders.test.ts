import { describe, expect, it } from 'vitest';
import type { Reminder } from './model';
import { REMINDER_OFFSETS_MIN } from './model';
import {
  buildReminders,
  canHaveReminders,
  computeFireAt,
  dueReminders,
  offsetsAfterTimeChange,
  recomputeReminders,
  REMINDER_QUICK_OFFSETS,
  sortReminderOffsets,
  toggleReminderOffset,
} from './reminders';
import { asEntityId, asLocalDate, asLocalTime, type ReminderId, type TaskId } from './types';

const date = asLocalDate('2026-03-01');
const time = asLocalTime('09:00');
const task = asEntityId<TaskId>('10000000-0000-4000-8000-000000000001');
let n = 0;
const newId = () => asEntityId<ReminderId>(`20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);

describe('rappels (N-02)', () => {
  it('les six avances sont la seule source ; les rapides sont À l’heure, 30 min, 1 heure', () => {
    expect(REMINDER_OFFSETS_MIN).toEqual([0, 5, 15, 30, 60, 1440]);
    expect(REMINDER_QUICK_OFFSETS).toEqual([0, 30, 60]);
  });

  it('fire_at = date-heure − avance, heure flottante (critères 1, 6)', () => {
    expect(computeFireAt(date, time, 0)).toBe('2026-03-01T09:00');
    expect(computeFireAt(date, time, 30)).toBe('2026-03-01T08:30');
    expect(computeFireAt(date, time, 60)).toBe('2026-03-01T08:00');
    expect(computeFireAt(date, time, 1440)).toBe('2026-02-28T09:00');
    // Année bissextile : la veille du 1er mars 2028 est le 29 février.
    expect(computeFireAt(asLocalDate('2028-03-01'), time, 1440)).toBe('2028-02-29T09:00');
    // Passage de minuit.
    expect(computeFireAt(date, asLocalTime('00:10'), 30)).toBe('2026-02-28T23:40');
    // Heure d'été : aucun décalage, 02:30 reste 02:30 (calcul sans fuseau).
    expect(computeFireAt(asLocalDate('2026-03-29'), asLocalTime('02:30'), 0)).toBe('2026-03-29T02:30');
  });

  it('aucun rappel sans date ni heure (QB-07)', () => {
    expect(canHaveReminders({ date, time: null })).toBe(false);
    expect(canHaveReminders({ date: null, time })).toBe(false);
    expect(canHaveReminders({ date, time })).toBe(true);
    const input = { target: { type: 'task', id: task } as const, offsets: [0, 30], newReminderId: newId };
    expect(buildReminders({ ...input, date, time: null })).toEqual([]);
    expect(buildReminders({ ...input, date: null, time })).toEqual([]);
  });

  it('une ligne par avance, sans doublon, triée, avances invalides ignorées (critères 1, 2)', () => {
    const rows = buildReminders({ target: { type: 'task', id: task }, date, time, offsets: [30, 0, 30, 7], newReminderId: newId });
    expect(rows.map((r) => [r.offsetMin, r.fireAt])).toEqual([
      [0, '2026-03-01T09:00'],
      [30, '2026-03-01T08:30'],
    ]);
    expect(rows.every((r) => r.targetType === 'task' && r.targetId === task)).toBe(true);
  });

  it('coche / décoche chaque avance indépendamment (critère 2)', () => {
    let current = sortReminderOffsets([]);
    for (const offset of REMINDER_OFFSETS_MIN) current = toggleReminderOffset(current, offset);
    expect(current).toEqual([0, 5, 15, 30, 60, 1440]);
    expect(toggleReminderOffset(current, 15)).toEqual([0, 5, 30, 60, 1440]);
    expect(toggleReminderOffset([30, 0], 5)).toEqual([0, 5, 30]);
  });

  const row = (offsetMin: 0 | 30 | 1440, fireAt: string): Reminder =>
    ({ id: newId(), targetType: 'task', targetId: task, offsetMin, fireAt, delivered: false }) as unknown as Reminder;

  it('recalcul au changement de date ou d’heure : avance conservée (critère 5)', () => {
    const existing = [row(0, '2026-03-01T09:00'), row(30, '2026-03-01T08:30')];
    expect(recomputeReminders({ date, time }, existing)).toBeNull(); // rien ne change
    const moved = recomputeReminders({ date: asLocalDate('2026-03-05'), time: asLocalTime('14:00') }, existing);
    expect(moved?.map((r) => [r.id, r.offsetMin, r.fireAt])).toEqual([
      [existing[0]?.id, 0, '2026-03-05T14:00'],
      [existing[1]?.id, 30, '2026-03-05T13:30'],
    ]);
  });

  it('sans heure, les rappels sont conservés mais inactifs (critère 7, QB-10)', () => {
    const existing = [row(0, '2026-03-01T09:00')];
    expect(recomputeReminders({ date, time: null }, existing)).toBeNull();
    expect(recomputeReminders({ date: null, time }, existing)).toBeNull();
    expect(dueReminders(existing, { date, time: null })).toEqual([]);
    expect(dueReminders(existing, { date, time })).toHaveLength(1);
  });

  it('« À l’heure » est cochée à la première heure donnée, sauf si on a touché aux cases (QB-08, critère 11)', () => {
    expect(offsetsAfterTimeChange([], null, time, false, [0])).toEqual([0]);
    expect(offsetsAfterTimeChange([], null, time, true, [0])).toEqual([]);
    expect(offsetsAfterTimeChange([30], null, time, false, [0])).toEqual([30]);
    expect(offsetsAfterTimeChange([], time, asLocalTime('10:00'), false, [0])).toEqual([]);
    expect(offsetsAfterTimeChange([0], time, null, false, [0])).toEqual([0]);
  });
});
