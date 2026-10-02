import { describe, expect, it } from 'vitest';
import type { IconRef, RecurrenceFields, Task } from './model';
import {
  buildNextOccurrence,
  decideNextOccurrence,
  reminderFireAt,
  type NextOccurrenceInput,
} from './recurrenceNext';
import {
  asEntityId,
  asId,
  asLocalDate,
  asLocalTime,
  asSpaceId,
  type ProjectId,
  type RecurrenceId,
  type ReminderId,
  type TaskId,
} from './types';

const d = asLocalDate;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recId = asEntityId<RecurrenceId>(uuid(1));

const monthly23: RecurrenceFields = {
  freq: 'monthly',
  interval: 1,
  weekdays: [],
  monthDay: 23,
  nthWeekday: null,
  until: null,
  count: null,
};

const input = (
  over: Partial<NextOccurrenceInput['task']>,
  extra: Partial<NextOccurrenceInput> = {},
): NextOccurrenceInput => ({
  task: { date: d('2026-09-23'), status: 'todo', recurrenceId: recId, seriesIndex: 0, ...over },
  rule: monthly23,
  today: d('2026-09-23'),
  ...extra,
});

describe('decideNextOccurrence', () => {
  it('terminée : crée la suivante au 23 oct., seriesIndex + 1 (critère 7)', () => {
    expect(decideNextOccurrence(input({ status: 'done' }))).toEqual({
      create: true,
      date: '2026-10-23',
      seriesIndex: 1,
    });
  });

  it('terminée en avance (le 20 pour le 23) : calculée depuis le 23 (critère 11)', () => {
    expect(decideNextOccurrence(input({ status: 'done' }, { today: d('2026-09-20') }))).toMatchObject({
      date: '2026-10-23',
    });
  });

  it('terminée en retard : calculée depuis la date prévue, pas depuis la fin', () => {
    expect(decideNextOccurrence(input({ status: 'done' }, { today: d('2026-09-30') }))).toMatchObject({
      date: '2026-10-23',
    });
  });

  it('non faite : pas due le jour même, créée dès le 24 (critère 10, Q2)', () => {
    expect(decideNextOccurrence(input({}, { today: d('2026-09-23') }))).toEqual({ create: false, reason: 'not_due' });
    expect(decideNextOccurrence(input({}, { today: d('2026-09-24') }))).toEqual({
      create: true,
      date: '2026-10-23',
      seriesIndex: 1,
    });
  });

  it('aucun doublon si une occurrence plus récente existe (corbeille comprise)', () => {
    expect(decideNextOccurrence(input({ status: 'done' }, { existingSeriesIndexes: [0, 1] }))).toEqual({
      create: false,
      reason: 'already_generated',
    });
    expect(decideNextOccurrence(input({ status: 'done' }, { existingSeriesIndexes: [0] }))).toMatchObject({
      create: true,
    });
  });

  it('pas de règle, pas de récurrence, pas de date', () => {
    expect(decideNextOccurrence(input({}, { rule: null }))).toEqual({ create: false, reason: 'no_recurrence' });
    expect(decideNextOccurrence(input({ recurrenceId: null }))).toEqual({ create: false, reason: 'no_recurrence' });
    expect(decideNextOccurrence(input({ date: null, status: 'done' }))).toEqual({ create: false, reason: 'no_date' });
  });

  it('fin de série : count atteint (seriesIndex null = 0) ou until dépassé', () => {
    const ended = { ...monthly23, count: 1 };
    expect(decideNextOccurrence(input({ status: 'done', seriesIndex: null }, { rule: ended }))).toEqual({
      create: false,
      reason: 'series_ended',
    });
    const six = { ...monthly23, count: 6 };
    expect(decideNextOccurrence(input({ status: 'done', seriesIndex: 4 }, { rule: six }))).toMatchObject({
      create: true,
      seriesIndex: 5,
    });
    expect(decideNextOccurrence(input({ status: 'done', seriesIndex: 5 }, { rule: six }))).toEqual({
      create: false,
      reason: 'series_ended',
    });
    const until = { ...monthly23, until: d('2026-10-22') };
    expect(decideNextOccurrence(input({ status: 'done' }, { rule: until }))).toMatchObject({
      reason: 'series_ended',
    });
  });

  it('rattrapage après longue absence : l’enchaînement atteint le futur sans doublon', () => {
    let task = input({}).task;
    const today = d('2027-03-01');
    const dates: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = decideNextOccurrence({ task, rule: monthly23, today });
      if (!res.create) break;
      dates.push(res.date);
      task = { ...task, date: res.date, seriesIndex: res.seriesIndex };
    }
    expect(dates).toEqual(['2026-10-23', '2026-11-23', '2026-12-23', '2027-01-23', '2027-02-23', '2027-03-23']);
  });
});

describe('reminderFireAt', () => {
  it('soustrait l’avance en heure flottante, à travers minuit, la fin d’année et le changement d’heure', () => {
    expect(reminderFireAt(d('2026-09-23'), '09:00', 0)).toBe('2026-09-23T09:00');
    expect(reminderFireAt(d('2026-09-23'), '09:00', 30)).toBe('2026-09-23T08:30');
    expect(reminderFireAt(d('2027-01-01'), '00:10', 15)).toBe('2026-12-31T23:55');
    expect(reminderFireAt(d('2026-03-29'), '02:30', 1440)).toBe('2026-03-28T02:30');
  });
});

describe('buildNextOccurrence', () => {
  const previous: Task = {
    id: asEntityId<TaskId>(uuid(2)),
    createdAt: '2026-09-01T10:00:00.000Z' as Task['createdAt'],
    updatedAt: '2026-09-23T10:00:00.000Z' as Task['updatedAt'],
    deletedAt: null,
    deviceId: asId(uuid(9)) as Task['deviceId'],
    hlc: 'x' as Task['hlc'],
    spaceId: asSpaceId(uuid(3)),
    projectId: asEntityId<ProjectId>(uuid(4)),
    title: 'Payer le loyer',
    note: 'Virement',
    date: d('2026-09-23'),
    time: asLocalTime('09:00'),
    status: 'done',
    doneAt: '2026-09-23T07:00:00.000Z' as Task['doneAt'],
    sortOrder: 3.5,
    carriedOver: true,
    recurrenceId: recId,
    seriesIndex: 0,
    goalId: null,
    icon: { kind: 'lucide', name: 'house' } as unknown as IconRef,
    someday: false,
    source: 'local',
    externalId: null,
  };
  let n = 100;
  const opts = {
    taskId: asEntityId<TaskId>(uuid(50)),
    date: d('2026-10-23'),
    seriesIndex: 1,
    newReminderId: () => asEntityId<ReminderId>(uuid(n++)),
  };

  it('recopie les champs, remet à zéro statut, report et fin (critère 7)', () => {
    const { task, reminders } = buildNextOccurrence(previous, opts);
    expect(task).toMatchObject({
      id: opts.taskId,
      title: 'Payer le loyer',
      note: 'Virement',
      icon: previous.icon,
      spaceId: previous.spaceId,
      projectId: previous.projectId,
      time: '09:00',
      date: '2026-10-23',
      status: 'todo',
      doneAt: null,
      carriedOver: false,
      recurrenceId: recId,
      seriesIndex: 1,
      sortOrder: 3.5,
      someday: false,
      source: 'local',
      externalId: null,
    });
    expect(reminders).toEqual([]);
    expect(buildNextOccurrence(previous, { ...opts, sortOrder: 9 }).task.sortOrder).toBe(9);
  });

  it('recopie les rappels avec échéance recalculée', () => {
    const { reminders } = buildNextOccurrence(previous, { ...opts, reminderOffsets: [0, 60, 1440] });
    expect(reminders.map((r) => [r.offsetMin, r.fireAt, r.targetType, r.targetId])).toEqual([
      [0, '2026-10-23T09:00', 'task', opts.taskId],
      [60, '2026-10-23T08:00', 'task', opts.taskId],
      [1440, '2026-10-22T09:00', 'task', opts.taskId],
    ]);
    expect(new Set(reminders.map((r) => r.id)).size).toBe(3);
  });

  it('sans heure : les rappels sont omis', () => {
    const { reminders } = buildNextOccurrence({ ...previous, time: null }, { ...opts, reminderOffsets: [0] });
    expect(reminders).toEqual([]);
  });
});
