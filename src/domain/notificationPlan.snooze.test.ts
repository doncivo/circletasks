import { describe, expect, it } from 'vitest';
import { makeEvent } from './eventTestKit';
import type { Reminder, ReminderOffsetMin, ReminderTargetType, Task } from './model';
import type { SnoozeEntry } from './notificationActions';
import { NOTIFICATION_LIMIT_DEFAULT, planNotifications, type NotificationPlanInput } from './notificationPlan';
import { DEFAULT_PRO_QUIET_HOURS } from './quietHours';
import type { RecapSettings } from './recap';
import { makeLog, makeRoutine } from './routineTestKit';
import { asEntityId, asLocalDate, asLocalDateTime, asLocalTime, type Id, type ReminderId, type SpaceId } from './types';

/**
 * N-03 critères 6, 7 et 10 (ADR 0012 avenant N3.6) : une répétition « +15 min » est un élément du plan (`kind: 'snooze'`), vivante tant que
 * l'origine l'est, comptée dans les 64 sans réserve, jamais soumise aux plages silencieuses.
 */
const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const SPACES = [
  { id: PRO, quietHours: DEFAULT_PRO_QUIET_HOURS },
  { id: PERSO, quietHours: [] },
] as const;
const NO_RECAPS: RecapSettings = { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: false, time: asLocalTime('21:00') } };
const NOW = asLocalDateTime('2026-10-08T10:00');

let counter = 0;
const uuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function task(over: Partial<Task> = {}): Task {
  counter += 1;
  return { id: uuid('11000000', counter), spaceId: PERSO, title: 'Tâche', date: asLocalDate('2026-10-08'), time: asLocalTime('10:00'), status: 'todo', someday: false, sortOrder: 0, deletedAt: null, ...over } as unknown as Task;
}

function reminder(targetType: ReminderTargetType, target: { readonly id: Id }, offsetMin = 0, over: Partial<Reminder> = {}): Reminder {
  counter += 1;
  return { id: uuid('22000000', counter) as ReminderId, targetType, targetId: target.id, offsetMin: offsetMin as ReminderOffsetMin, fireAt: asLocalDateTime('2020-01-01T00:00'), delivered: false, deletedAt: null, ...over } as unknown as Reminder;
}

function plan(over: Partial<NotificationPlanInput> = {}) {
  return planNotifications({ now: NOW, tasks: [], routines: [], routinePauses: [], routineLogs: [], events: [], reminders: [], spaces: SPACES, recaps: NO_RECAPS, ...over });
}

const snooze = (originId: string, fireAt: string): SnoozeEntry => ({ id: `snooze:${originId}`, originId, fireAt: asLocalDateTime(fireAt) });

describe('répétitions « +15 min » dans le plan (N-03 critères 6, 7 et 10)', () => {
  it('une répétition d’une tâche à faire entre dans le plan avec la catégorie, le rappel et la cible de l’origine', () => {
    const t = task();
    const r = reminder('task', t, 0);
    const result = plan({ tasks: [t], reminders: [r], snoozes: [snooze(`task:${r.id}`, '2026-10-08T10:15')] });
    expect(result.items).toEqual([
      { kind: 'snooze', id: `snooze:task:${r.id}`, originId: `task:${r.id}`, originKind: 'task', reminderId: r.id, offsetMin: 0, targetId: t.id, occurrenceDate: null, fireAt: '2026-10-08T10:15' },
    ]);
    expect(result.deadSnoozeIds).toEqual([]);
  });

  it('tâche terminée (sur ce téléphone par « Fait » ou reçue par la synchro), supprimée ou rappel retiré : répétition morte', () => {
    const done = task({ status: 'done' });
    const trashed = task({ deletedAt: '2026-10-08T00:00:00.000Z' as never });
    const live = task();
    const removed = reminder('task', live, 0, { deletedAt: '2026-10-08T00:00:00.000Z' as never });
    const doneReminder = reminder('task', done, 0);
    const trashedReminder = reminder('task', trashed, 0);
    const result = plan({
      tasks: [done, trashed, live],
      reminders: [doneReminder, trashedReminder, removed],
      snoozes: [snooze(`task:${doneReminder.id}`, '2026-10-08T10:15'), snooze(`task:${trashedReminder.id}`, '2026-10-08T10:15'), snooze(`task:${removed.id}`, '2026-10-08T10:15'), snooze('task:inconnu', '2026-10-08T10:15')],
    });
    expect(result.items).toEqual([]);
    expect(result.deadSnoozeIds).toHaveLength(4);
  });

  it('échéance passée ou à la minute courante : morte', () => {
    const t = task();
    const r = reminder('task', t, 0);
    const result = plan({ tasks: [t], reminders: [r], snoozes: [snooze(`task:${r.id}`, '2026-10-08T10:00')] });
    expect(result.items).toEqual([]);
    expect(result.deadSnoozeIds).toEqual([`snooze:task:${r.id}`]);
  });

  it('aucune plage silencieuse : une répétition d’une tâche Pro sonne à 20:30', () => {
    const t = task({ spaceId: PRO });
    const r = reminder('task', t, 0);
    const result = plan({ now: asLocalDateTime('2026-10-08T20:00'), tasks: [t], reminders: [r], snoozes: [snooze(`task:${r.id}`, '2026-10-08T20:30')] });
    expect(result.items.map((item) => item.fireAt)).toEqual(['2026-10-08T20:30']);
  });

  it('routine : vivante tant que l’occurrence de la notification n’est pas validée, morte une fois validée (« Fait » ou synchro)', () => {
    const routine = makeRoutine({ time: asLocalTime('09:00') });
    const r = reminder('routine', routine, 0);
    const origin = `routine:${r.id}:2026-10-08`;
    const alive = plan({ routines: [routine], reminders: [r], snoozes: [snooze(origin, '2026-10-08T10:15')] });
    expect(alive.items.find((item) => item.kind === 'snooze')).toMatchObject({ originKind: 'routine', occurrenceDate: '2026-10-08', targetId: routine.id });
    const validated = plan({ routines: [routine], reminders: [r], routineLogs: [makeLog(routine, '2026-10-08')], snoozes: [snooze(origin, '2026-10-08T10:15')] });
    expect(validated.items.some((item) => item.kind === 'snooze')).toBe(false);
    expect(validated.deadSnoozeIds).toEqual([`snooze:${origin}`]);
    const archived = plan({ routines: [{ ...routine, archived: true }], reminders: [r], snoozes: [snooze(origin, '2026-10-08T10:15')] });
    expect(archived.deadSnoozeIds).toEqual([`snooze:${origin}`]);
  });

  it('événement : répétition vivante tant que l’événement existe', () => {
    const event = makeEvent({ startDate: '2026-10-08', startTime: asLocalTime('10:00') });
    const r = reminder('event', event, 0);
    const origin = `event:${r.id}:2026-10-08`;
    expect(plan({ events: [event], reminders: [r], snoozes: [snooze(origin, '2026-10-08T10:15')] }).items.some((item) => item.kind === 'snooze' && item.originKind === 'event')).toBe(true);
    const deleted = plan({ events: [{ ...event, deletedAt: '2026-10-08T00:00:00.000Z' as never }], reminders: [r], snoozes: [snooze(origin, '2026-10-08T10:15')] });
    expect(deleted.deadSnoozeIds).toEqual([`snooze:${origin}`]);
  });

  it('une origine illisible (récapitulatif, format inconnu) : morte', () => {
    const result = plan({ snoozes: [snooze('recap:evening:2026-10-08', '2026-10-08T10:15'), snooze('autre', '2026-10-08T10:15')] });
    expect(result.deadSnoozeIds).toHaveLength(2);
  });

  it('critère 10 : avec 64 rappels plus proches, une répétition plus lointaine ne dépasse jamais le plafond', () => {
    const tasks = Array.from({ length: NOTIFICATION_LIMIT_DEFAULT }, (_, index) => task({ date: asLocalDate('2026-10-09'), time: asLocalTime(`${String(8 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`) }));
    const reminders = tasks.map((t) => reminder('task', t, 0));
    const origin = reminders[0];
    if (origin === undefined) throw new Error('rappel attendu');
    const result = plan({ tasks, reminders, snoozes: [snooze(`task:${origin.id}`, '2026-12-01T10:00')] });
    expect(result.items).toHaveLength(NOTIFICATION_LIMIT_DEFAULT);
    expect(result.items.some((item) => item.kind === 'snooze')).toBe(false);
    expect(result.total).toBe(NOTIFICATION_LIMIT_DEFAULT + 1);
    // Vivante, seulement coupée par le plafond : elle n'est pas à purger de la file.
    expect(result.deadSnoozeIds).toEqual([]);
  });

  it('critère 10 : une répétition plus proche prend la place du dernier rappel du plan', () => {
    const tasks = Array.from({ length: NOTIFICATION_LIMIT_DEFAULT }, (_, index) => task({ date: asLocalDate('2026-10-09'), time: asLocalTime(`${String(8 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`) }));
    const reminders = tasks.map((t) => reminder('task', t, 0));
    const last = reminders[reminders.length - 1];
    const first = reminders[0];
    if (last === undefined || first === undefined) throw new Error('rappel attendu');
    const result = plan({ tasks, reminders, snoozes: [snooze(`task:${first.id}`, '2026-10-08T10:15')] });
    expect(result.items).toHaveLength(NOTIFICATION_LIMIT_DEFAULT);
    expect(result.items[0]).toMatchObject({ kind: 'snooze', fireAt: '2026-10-08T10:15' });
    expect(result.items.some((item) => item.id === `task:${last.id}`)).toBe(false);
  });

  it('sans répétition en entrée, le plan est celui d’avant N-03', () => {
    const t = task({ time: asLocalTime('11:00') });
    const r = reminder('task', t, 0);
    const result = plan({ tasks: [t], reminders: [r] });
    expect(result.items.map((item) => item.kind)).toEqual(['task']);
    expect(result.deadSnoozeIds).toEqual([]);
  });
});
