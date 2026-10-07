import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeEvent } from './eventTestKit';
import type { CalendarEvent, Reminder, ReminderOffsetMin, ReminderTargetType, Routine, RoutineLog, RoutinePause, Task } from './model';
import { NOTIFICATION_HORIZON_DAYS, planNotifications, type NotificationPlanInput, type PlannedItem } from './notificationPlan';
import { DEFAULT_PRO_QUIET_HOURS } from './quietHours';
import type { RecapSettings } from './recap';
import { makeLog, makeRoutine } from './routineTestKit';
import { asEntityId, asLocalDate, asLocalDateTime, asLocalTime, type Id, type ReminderId, type RoutinePauseId, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const SPACES = [
  { id: PRO, quietHours: DEFAULT_PRO_QUIET_HOURS },
  { id: PERSO, quietHours: [] },
] as const;

const NO_RECAPS: RecapSettings = {
  morning: { enabled: false, time: asLocalTime('07:30') },
  evening: { enabled: false, time: asLocalTime('21:00') },
};
const DEFAULT_RECAPS: RecapSettings = {
  morning: { enabled: true, time: asLocalTime('07:30') },
  evening: { enabled: true, time: asLocalTime('21:00') },
};

const NOW = asLocalDateTime('2026-10-07T10:00'); // mercredi

let counter = 0;
const uuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function task(over: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: uuid('11000000', counter),
    spaceId: PERSO,
    title: 'Tâche',
    date: asLocalDate('2026-10-08'),
    time: asLocalTime('09:00'),
    status: 'todo',
    someday: false,
    sortOrder: 0,
    deletedAt: null,
    ...over,
  } as unknown as Task;
}

function reminder(targetType: ReminderTargetType, target: { readonly id: Id }, offsetMin: number, over: Partial<Reminder> = {}): Reminder {
  counter += 1;
  return {
    id: uuid('22000000', counter) as ReminderId,
    targetType,
    targetId: target.id,
    offsetMin: offsetMin as ReminderOffsetMin,
    fireAt: asLocalDateTime('2020-01-01T00:00'),
    delivered: false,
    deletedAt: null,
    ...over,
  } as unknown as Reminder;
}

function plan(over: Partial<NotificationPlanInput> = {}) {
  return planNotifications({
    now: NOW,
    tasks: [],
    routines: [],
    routinePauses: [],
    routineLogs: [],
    events: [],
    reminders: [],
    spaces: SPACES,
    recaps: NO_RECAPS,
    ...over,
  });
}

const fires = (items: readonly PlannedItem[]): string[] => items.map((item) => item.fireAt);
const ids = (items: readonly PlannedItem[]): string[] => items.map((item) => item.id);

function pause(routine: Routine, from: string, to: string | null): RoutinePause {
  counter += 1;
  return { id: uuid('33000000', counter) as RoutinePauseId, routineId: routine.id, fromDate: asLocalDate(from), toDate: to === null ? null : asLocalDate(to), deletedAt: null } as unknown as RoutinePause;
}

describe('rappels de tâches (critères 7 à 9)', () => {
  it('7 : trois rappels (0, 15, 1440) d’une tâche à 09:00, identifiants task:{reminderId}, échéance recalculée', () => {
    const t = task({ date: asLocalDate('2026-10-12'), time: asLocalTime('09:00') });
    const rs = [reminder('task', t, 0), reminder('task', t, 15), reminder('task', t, 1440)];
    const result = plan({ tasks: [t], reminders: rs });
    expect(fires(result.items)).toEqual(['2026-10-11T09:00', '2026-10-12T08:45', '2026-10-12T09:00']);
    expect(result.items.map((item) => item.id).sort()).toEqual(rs.map((r) => `task:${r.id}`).sort());
    expect(result.items.every((item) => item.kind === 'task' && item.occurrenceDate === '2026-10-12')).toBe(true);
    // `fire_at` périmé (2020) jamais lu : les échéances ci-dessus viennent de la date et de l'heure actuelles de la tâche.
    expect(rs.every((r) => r.fireAt === '2020-01-01T00:00')).toBe(true);
  });

  it('7 : changer l’heure de la tâche garde l’identifiant et déplace l’échéance', () => {
    const t = task({ time: asLocalTime('09:00') });
    const r = reminder('task', t, 0);
    const before = plan({ tasks: [t], reminders: [r] }).items[0];
    const after = plan({ tasks: [{ ...t, time: asLocalTime('10:30') }], reminders: [r] }).items[0];
    expect(before?.id).toBe(after?.id);
    expect(before?.fireAt).toBe('2026-10-08T09:00');
    expect(after?.fireAt).toBe('2026-10-08T10:30');
  });

  it('8 : exclut terminée, supprimée, Un jour, sans date, sans heure, rappel supprimé, cible absente', () => {
    const done = task({ status: 'done' });
    const trashed = task({ deletedAt: '2026-10-01T00:00:00.000Z' as never });
    const someday = task({ someday: true, date: null, time: null });
    const noDate = task({ date: null, time: null });
    const noTime = task({ time: null });
    const deletedReminderTask = task();
    const ok = task();
    const rs = [
      ...[done, trashed, someday, noDate, noTime].map((t) => reminder('task', t, 0)),
      reminder('task', deletedReminderTask, 0, { deletedAt: '2026-10-01T00:00:00.000Z' as never }),
      reminder('task', { id: uuid('99000000', 1) as Id }, 0),
      reminder('task', ok, 5),
    ];
    const result = plan({ tasks: [done, trashed, someday, noDate, noTime, deletedReminderTask, ok], reminders: rs });
    expect(ids(result.items)).toEqual([`task:${rs[rs.length - 1]?.id}`]);
    expect(result.total).toBe(1);
  });

  it('8 : échéance passée ou égale à now exclue, à la minute (aucun rattrapage)', () => {
    const t = task({ date: asLocalDate('2026-10-07'), time: asLocalTime('10:00') });
    const r = reminder('task', t, 0);
    expect(plan({ tasks: [t], reminders: [r], now: asLocalDateTime('2026-10-07T09:59') }).items).toHaveLength(1);
    expect(plan({ tasks: [t], reminders: [r], now: asLocalDateTime('2026-10-07T10:00') }).items).toHaveLength(0);
    expect(plan({ tasks: [t], reminders: [r], now: asLocalDateTime('2026-10-07T10:01') }).items).toHaveLength(0);
  });

  it('8 : un rappel Pro de 20:00 décalé au lendemain 08:00 reste dû à 21:00', () => {
    const t = task({ spaceId: PRO, date: asLocalDate('2026-10-07'), time: asLocalTime('20:00') });
    const r = reminder('task', t, 0);
    const result = plan({ tasks: [t], reminders: [r], now: asLocalDateTime('2026-10-07T21:00') });
    expect(fires(result.items)).toEqual(['2026-10-08T08:00']);
    // Le lendemain à 08:00 il n'est plus dû.
    expect(plan({ tasks: [t], reminders: [r], now: asLocalDateTime('2026-10-08T08:00') }).items).toHaveLength(0);
  });

  it('9 : deux lignes de même cible, avance et occurrence : la ligne d’identifiant le plus petit', () => {
    const t = task();
    const a = reminder('task', t, 0);
    const b = reminder('task', t, 0);
    expect(a.id < b.id).toBe(true);
    for (const order of [[a, b], [b, a]]) expect(ids(plan({ tasks: [t], reminders: order }).items)).toEqual([`task:${a.id}`]);
  });

  it('une avance inconnue ou une heure mal formée ne produit rien et ne lève pas', () => {
    const t = task();
    const bad = task({ time: '25:99' as never });
    const result = plan({ tasks: [t, bad], reminders: [reminder('task', t, 7), reminder('task', bad, 0)] });
    expect(result).toEqual({ items: [], coverage: { state: 'empty' }, total: 0 });
  });

  it('un now mal formé rend un plan vide sans lever', () => {
    expect(plan({ now: 'hier' as never })).toEqual({ items: [], coverage: { state: 'empty' }, total: 0 });
  });
});

describe('plages silencieuses (critères 10 et 11)', () => {
  it('10 : Pro, mardi 20:00 sans avance : mercredi 08:00, échéance d’origine gardée ; Perso non décalée', () => {
    const pro = task({ spaceId: PRO, date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') });
    const perso = task({ spaceId: PERSO, date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') });
    const rp = reminder('task', pro, 0);
    const rq = reminder('task', perso, 0);
    const result = plan({ tasks: [pro, perso], reminders: [rp, rq] });
    const itemPro = result.items.find((item) => item.id === `task:${rp.id}`);
    const itemPerso = result.items.find((item) => item.id === `task:${rq.id}`);
    expect(itemPro).toMatchObject({ fireAt: '2026-10-14T08:00', scheduledAt: '2026-10-13T20:00' });
    expect(itemPerso).toMatchObject({ fireAt: '2026-10-13T20:00', scheduledAt: '2026-10-13T20:00' });
    // Tri par échéance effective : Perso (mardi 20:00) avant Pro (mercredi 08:00).
    expect(ids(result.items)).toEqual([`task:${rq.id}`, `task:${rp.id}`]);
  });

  it('10 : des plages enchaînées comptent pour une seule (vendredi 20:00 → lundi 08:00)', () => {
    const t = task({ spaceId: PRO, date: asLocalDate('2026-10-09'), time: asLocalTime('20:00') });
    expect(fires(plan({ tasks: [t], reminders: [reminder('task', t, 0)] }).items)).toEqual(['2026-10-12T08:00']);
  });

  it('10 : plusieurs rappels décalés à la même heure restent des éléments distincts', () => {
    const a = task({ spaceId: PRO, date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') });
    const b = task({ spaceId: PRO, date: asLocalDate('2026-10-13'), time: asLocalTime('22:15') });
    const result = plan({ tasks: [a, b], reminders: [reminder('task', a, 0), reminder('task', b, 0)] });
    expect(fires(result.items)).toEqual(['2026-10-14T08:00', '2026-10-14T08:00']);
    expect(new Set(ids(result.items)).size).toBe(2);
  });

  it('10 : le plafond utilise l’échéance effective', () => {
    const shifted = task({ spaceId: PRO, date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') }); // effectif mercredi 08:00
    const later = task({ date: asLocalDate('2026-10-14'), time: asLocalTime('07:00') }); // Perso, mercredi 07:00
    const result = plan({ tasks: [shifted, later], reminders: [reminder('task', shifted, 0), reminder('task', later, 0)], limit: 1 });
    expect(result.items[0]?.fireAt).toBe('2026-10-14T07:00');
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-14T07:00' });
  });

  it('10 : un espace inconnu n’a aucune plage', () => {
    const t = task({ spaceId: asEntityId<SpaceId>(uuid('10000000', 9)), date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') });
    expect(fires(plan({ tasks: [t], reminders: [reminder('task', t, 0)] }).items)).toEqual(['2026-10-13T20:00']);
  });

  it('11 : les récapitulatifs ne sont pas décalés par les plages (07:30 reste 07:30)', () => {
    const result = plan({ recaps: DEFAULT_RECAPS, limit: 4 });
    expect(fires(result.items)).toEqual(['2026-10-07T21:00', '2026-10-08T07:30', '2026-10-08T21:00', '2026-10-09T07:30']);
  });
});

describe('routines (critères 12 à 14)', () => {
  const at = (hhmm: string, over: Partial<Routine> = {}): Routine => makeRoutine({ spaceId: PERSO, time: asLocalTime(hhmm), ...over });

  it('12 : une routine quotidienne à 07:00, avance 30 min : un seul élément, la prochaine occurrence', () => {
    const routine = at('07:00');
    const r = reminder('routine', routine, 30);
    const result = plan({ routines: [routine], reminders: [r], now: asLocalDateTime('2026-10-07T07:00') });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: `routine:${r.id}:2026-10-08`,
      kind: 'routine',
      occurrenceDate: '2026-10-08',
      fireAt: '2026-10-08T06:30',
    });
    // Le plan suit le temps : un jour plus tard, le lendemain (pure fonction de now).
    const next = plan({ routines: [routine], reminders: [r], now: asLocalDateTime('2026-10-08T07:00') });
    expect(next.items.map((item) => item.id)).toEqual([`routine:${r.id}:2026-10-09`]);
  });

  it('12 : avant l’échéance du jour, l’occurrence du jour ; un élément par avance', () => {
    const routine = at('07:00');
    const rs = [reminder('routine', routine, 0), reminder('routine', routine, 30)];
    const result = plan({ routines: [routine], reminders: rs, now: asLocalDateTime('2026-10-07T06:00') });
    expect(fires(result.items)).toEqual(['2026-10-07T06:30', '2026-10-07T07:00']);
  });

  it('13 : ignorées si archivée, supprimée, sans heure ou en pause sans période', () => {
    const archived = at('07:00', { archived: true });
    const trashed = at('07:00', { deletedAt: '2026-10-01T00:00:00.000Z' as never });
    const noTime = at('07:00', { time: null });
    const paused = at('07:00', { paused: true });
    const all = [archived, trashed, noTime, paused];
    expect(plan({ routines: all, reminders: all.map((routine) => reminder('routine', routine, 0)) }).items).toEqual([]);
  });

  it('13 : une pause couvre des occurrences ; la première hors pause est planifiée ; aucune si la pause est ouverte', () => {
    const routine = at('07:00');
    const r = reminder('routine', routine, 0);
    const bounded = plan({ routines: [routine], reminders: [r], routinePauses: [pause(routine, '2026-10-07', '2026-10-09')] });
    expect(bounded.items.map((item) => item.fireAt)).toEqual(['2026-10-10T07:00']);
    const open = plan({ routines: [routine], reminders: [r], routinePauses: [pause(routine, '2026-10-07', null)] });
    expect(open.items).toEqual([]);
  });

  it('13 : l’occurrence du jour déjà validée est remplacée par la suivante', () => {
    const routine = at('07:00');
    const r = reminder('routine', routine, 0);
    const now = asLocalDateTime('2026-10-07T06:00');
    expect(plan({ routines: [routine], reminders: [r], now }).items[0]?.fireAt).toBe('2026-10-07T07:00');
    const logs: RoutineLog[] = [makeLog(routine, '2026-10-07')];
    expect(plan({ routines: [routine], reminders: [r], routineLogs: logs, now }).items[0]?.fireAt).toBe('2026-10-08T07:00');
    const undone: RoutineLog[] = [makeLog(routine, '2026-10-07', { deletedAt: '2026-10-07T05:00:00.000Z' as never })];
    expect(plan({ routines: [routine], reminders: [r], routineLogs: undone, now }).items[0]?.fireAt).toBe('2026-10-07T07:00');
  });

  it('13 : « X fois par semaine » dont le quota est atteint : aucun rappel jusqu’au lundi', () => {
    const routine = at('07:00', { scheduleType: 'x_per_week', timesPerWeek: 2 });
    const r = reminder('routine', routine, 0);
    const logs = [makeLog(routine, '2026-10-05'), makeLog(routine, '2026-10-06')];
    const result = plan({ routines: [routine], reminders: [r], routineLogs: logs, now: asLocalDateTime('2026-10-07T06:00') });
    expect(result.items.map((item) => item.fireAt)).toEqual(['2026-10-12T07:00']);
    const notReached = plan({ routines: [routine], reminders: [r], routineLogs: [logs[0] as RoutineLog], now: asLocalDateTime('2026-10-07T06:00') });
    expect(notReached.items.map((item) => item.fireAt)).toEqual(['2026-10-07T07:00']);
  });

  it('13 : une routine Pro suit les plages silencieuses de son espace', () => {
    const routine = at('20:00', { spaceId: PRO });
    const result = plan({ routines: [routine], reminders: [reminder('routine', routine, 0)], now: asLocalDateTime('2026-10-07T06:00') });
    expect(result.items[0]).toMatchObject({ occurrenceDate: '2026-10-07', scheduledAt: '2026-10-07T20:00', fireAt: '2026-10-08T08:00' });
  });

  it('14 : tous les 2 jours : la prochaine occurrence suit la règle', () => {
    const routine = at('07:00', { scheduleType: 'every_n_days', interval: 2, startDate: asLocalDate('2026-10-07') });
    const result = plan({ routines: [routine], reminders: [reminder('routine', routine, 0)] });
    expect(result.items.map((item) => (item.kind === 'recap' ? null : item.occurrenceDate))).toEqual(['2026-10-09']);
  });

  it('14 : toutes les 2 semaines : la prochaine occurrence suit la règle', () => {
    const routine = at('07:00', { scheduleType: 'every_n_weeks', interval: 2, weekdays: [1], startDate: asLocalDate('2026-10-05') });
    const result = plan({ routines: [routine], reminders: [reminder('routine', routine, 0)] });
    expect(result.items.map((item) => (item.kind === 'recap' ? null : item.occurrenceDate))).toEqual(['2026-10-19']);
  });

  it('une règle sans occurrence ne produit rien et ne lève pas', () => {
    const broken = at('07:00', { scheduleType: 'every_n_days', interval: null });
    expect(plan({ routines: [broken], reminders: [reminder('routine', broken, 0)] }).items).toEqual([]);
  });
});

describe('événements (critères 15 à 17)', () => {
  const ev = (over: Omit<Partial<CalendarEvent>, 'startDate' | 'endDate'> & { startDate?: string; endDate?: string }): CalendarEvent => makeEvent({ spaceId: PERSO, ...over });

  it('15 : anniversaire annuel du 12 mars, avances 10080, 1440, 0 : trois éléments pour le 12 mars 2027 à 09:00', () => {
    const birthday = ev({ startDate: '2026-03-12', repeat: 'yearly', kind: 'birthday' });
    const rs = [reminder('event', birthday, 10080), reminder('event', birthday, 1440), reminder('event', birthday, 0)];
    const result = plan({ events: [birthday], reminders: rs });
    expect(fires(result.items)).toEqual(['2027-03-05T09:00', '2027-03-11T09:00', '2027-03-12T09:00']);
    expect(result.items.map((item) => item.id).sort()).toEqual(rs.map((r) => `event:${r.id}:2027-03-12`).sort());
    expect(result.items.every((item) => item.kind === 'event' && item.occurrenceDate === '2027-03-12')).toBe(true);
  });

  it('15 : un événement à heures utilise son heure de début', () => {
    const meeting = ev({ startDate: '2026-10-20', allDay: false, startTime: asLocalTime('14:30'), endTime: asLocalTime('15:30') });
    expect(fires(plan({ events: [meeting], reminders: [reminder('event', meeting, 0)] }).items)).toEqual(['2026-10-20T14:30']);
  });

  it('16 : mensuel : chaque occurrence a ses éléments, fin de mois bornée, horizon de 400 jours', () => {
    const monthly = ev({ startDate: '2026-01-31', repeat: 'monthly' });
    const r = reminder('event', monthly, 0);
    const result = plan({ events: [monthly], reminders: [r] });
    const dates = result.items.map((item) => (item.kind === 'event' ? item.occurrenceDate : ''));
    expect(dates.slice(0, 5)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
    expect(dates.at(-1)).toBe('2027-10-31');
    expect(dates.every((date) => date <= '2027-11-11')).toBe(true); // 2027-11-11 = jour de now + 400
    expect(NOTIFICATION_HORIZON_DAYS).toBe(400);
  });

  it('16 : l’horizon borne les occurrences (mensuel : au plus le jour + 400)', () => {
    const monthly = ev({ startDate: '2026-01-15', repeat: 'monthly' });
    const result = plan({ events: [monthly], reminders: [reminder('event', monthly, 0)] });
    const dates = result.items.map((item) => (item.kind === 'event' ? item.occurrenceDate : ''));
    expect(dates[0]).toBe('2026-10-15');
    expect(dates.at(-1)).toBe('2027-10-15');
    expect(dates).toHaveLength(13);
  });

  it('16 : annuel, 29 février : le 28 les années non bissextiles', () => {
    const leap = ev({ startDate: '2024-02-29', repeat: 'yearly' });
    expect(plan({ events: [leap], reminders: [reminder('event', leap, 0)] }).items.map((item) => item.fireAt)).toEqual(['2027-02-28T09:00']);
  });

  it('16 : l’échéance stockée de la ligne reminder n’est pas utilisée', () => {
    const yearly = ev({ startDate: '2026-03-12', repeat: 'yearly' });
    const stale = reminder('event', yearly, 0, { fireAt: asLocalDateTime('2026-10-08T09:00') });
    expect(fires(plan({ events: [yearly], reminders: [stale] }).items)).toEqual(['2027-03-12T09:00']);
  });

  it('17 : demain 08:00, avance la veille : gardé à aujourd’hui 08:00 avant 08:00, exclu après', () => {
    const tomorrow = ev({ startDate: '2026-10-08', allDay: false, startTime: asLocalTime('08:00'), endTime: asLocalTime('09:00') });
    const r = reminder('event', tomorrow, 1440);
    const before = plan({ events: [tomorrow], reminders: [r], now: asLocalDateTime('2026-10-07T07:00') });
    expect(fires(before.items)).toEqual(['2026-10-07T08:00']);
    expect(plan({ events: [tomorrow], reminders: [r], now: asLocalDateTime('2026-10-07T08:30') }).items).toEqual([]);
  });

  it('17 : un événement non répété et passé ne donne rien ; un événement supprimé non plus', () => {
    const past = ev({ startDate: '2026-09-01' });
    const trashed = ev({ startDate: '2026-11-01', deletedAt: '2026-10-01T00:00:00.000Z' as never });
    expect(plan({ events: [past, trashed], reminders: [reminder('event', past, 0), reminder('event', trashed, 0)] }).items).toEqual([]);
  });

  it('un événement Pro suit les plages silencieuses de son espace', () => {
    const dinner = ev({ spaceId: PRO, startDate: '2026-10-13', allDay: false, startTime: asLocalTime('20:00'), endTime: asLocalTime('22:00') });
    expect(plan({ events: [dinner], reminders: [reminder('event', dinner, 0)] }).items[0]).toMatchObject({ scheduledAt: '2026-10-13T20:00', fireAt: '2026-10-14T08:00' });
  });
});

describe('récapitulatifs (critères 18 et 19)', () => {
  it('18 : réglages par défaut, now 10:00 : le soir d’aujourd’hui, puis matin et soir des jours suivants', () => {
    const result = plan({ recaps: DEFAULT_RECAPS });
    expect(ids(result.items.slice(0, 5))).toEqual([
      'recap:evening:2026-10-07',
      'recap:morning:2026-10-08',
      'recap:evening:2026-10-08',
      'recap:morning:2026-10-09',
      'recap:evening:2026-10-09',
    ]);
    expect(ids(result.items)).not.toContain('recap:morning:2026-10-07');
  });

  it('18 : un récapitulatif désactivé n’apparaît jamais', () => {
    const eveningOnly = plan({ recaps: { ...DEFAULT_RECAPS, morning: { enabled: false, time: asLocalTime('07:30') } } });
    expect(eveningOnly.items.every((item) => item.kind === 'recap' && item.recapKind === 'evening')).toBe(true);
    expect(plan({ recaps: NO_RECAPS })).toEqual({ items: [], coverage: { state: 'empty' }, total: 0 });
  });

  it('18 : le plan couvre l’horizon (401 jours, deux récapitulatifs moins celui du matin passé)', () => {
    expect(plan({ recaps: DEFAULT_RECAPS }).total).toBe(2 * (NOTIFICATION_HORIZON_DAYS + 1) - 1);
  });

  it('18 : récapitulatif du matin avant now : celui du jour est exclu ; à l’heure exacte aussi', () => {
    const exact = plan({ recaps: DEFAULT_RECAPS, now: asLocalDateTime('2026-10-07T07:30') });
    expect(exact.items[0]?.id).toBe('recap:evening:2026-10-07');
    const early = plan({ recaps: DEFAULT_RECAPS, now: asLocalDateTime('2026-10-07T07:29') });
    expect(early.items[0]?.id).toBe('recap:morning:2026-10-07');
  });

  it('19 : contenu calculé pour aujourd’hui seulement, sans filtre d’espace ; les autres jours : null', () => {
    const doneToday = task({ spaceId: PRO, date: asLocalDate('2026-10-07'), time: asLocalTime('08:00'), status: 'done' });
    const openPro = task({ spaceId: PRO, date: asLocalDate('2026-10-07'), time: asLocalTime('18:00') });
    const openPerso = task({ spaceId: PERSO, date: asLocalDate('2026-10-07'), time: null });
    const routine = makeRoutine({ spaceId: PERSO, time: asLocalTime('19:00') });
    const result = plan({ recaps: DEFAULT_RECAPS, tasks: [doneToday, openPro, openPerso], routines: [routine] });
    const [first, second] = result.items;
    expect(first?.kind === 'recap' && first.content).toMatchObject({ kind: 'evening', day: '2026-10-07', count: 3 });
    expect(second?.kind === 'recap' && second.content).toBeNull();
    expect(result.items.filter((item) => item.kind === 'recap' && item.content !== null)).toHaveLength(1);
  });
});

describe('plafond et couverture (critère 20)', () => {
  function hundredTasks() {
    const tasks: Task[] = [];
    const reminders: Reminder[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t = task({ date: asLocalDate('2026-10-09'), time: asLocalTime(`${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`) });
      tasks.push(t);
      reminders.push(reminder('task', t, 0));
    }
    return { tasks, reminders };
  }

  it('100 candidats : les 64 premiers par échéance effective, total 100, coverage until sur le dernier gardé', () => {
    const { tasks, reminders } = hundredTasks();
    const result = plan({ tasks, reminders });
    expect(result.items).toHaveLength(64);
    expect(result.total).toBe(100);
    expect(result.items[0]?.fireAt).toBe('2026-10-09T00:00');
    expect(result.items[63]?.fireAt).toBe('2026-10-09T01:03');
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-09T01:03' });
    expect(fires(result.items)).toEqual([...fires(result.items)].sort());
  });

  it('limit = 63 (fin de Focus planifiée) : 63 éléments gardés', () => {
    const { tasks, reminders } = hundredTasks();
    const result = plan({ tasks, reminders, limit: 63 });
    expect(result.items).toHaveLength(63);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-09T01:02' });
  });

  it('limit : borné à 0 et 64, valeurs absurdes ramenées', () => {
    const { tasks, reminders } = hundredTasks();
    expect(plan({ tasks, reminders, limit: 500 }).items).toHaveLength(64);
    expect(plan({ tasks, reminders, limit: -3 }).items).toHaveLength(0);
    expect(plan({ tasks, reminders, limit: Number.NaN }).items).toHaveLength(64);
    expect(plan({ tasks, reminders, limit: 2.9 }).items).toHaveLength(2);
    expect(plan({ tasks, reminders, limit: 0 }).coverage).toEqual({ state: 'until', until: NOW });
  });

  it('sous le plafond : complete ; sans candidat : empty', () => {
    const t = task();
    expect(plan({ tasks: [t], reminders: [reminder('task', t, 0)] }).coverage).toEqual({ state: 'complete' });
    expect(plan().coverage).toEqual({ state: 'empty' });
  });

  it('exactement 64 candidats : complete', () => {
    const { tasks, reminders } = hundredTasks();
    expect(plan({ tasks: tasks.slice(0, 64), reminders: reminders.slice(0, 64) }).coverage).toEqual({ state: 'complete' });
  });

  it('égalité d’échéance : rappel avant récapitulatif, puis identifiant', () => {
    const a = task({ date: asLocalDate('2026-10-07'), time: asLocalTime('21:00') });
    const b = task({ date: asLocalDate('2026-10-07'), time: asLocalTime('21:00') });
    const ra = reminder('task', a, 0);
    const rb = reminder('task', b, 0);
    const result = plan({ tasks: [b, a], reminders: [rb, ra], recaps: DEFAULT_RECAPS, limit: 3 });
    expect(ids(result.items)).toEqual([`task:${ra.id}`, `task:${rb.id}`, 'recap:evening:2026-10-07']);
  });
});

describe('pureté et déterminisme (critères 22 à 24)', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };

  function scenario(): NotificationPlanInput {
    const t1 = task({ spaceId: PRO, date: asLocalDate('2026-10-13'), time: asLocalTime('20:00') });
    const t2 = task({ date: asLocalDate('2026-10-09'), time: asLocalTime('08:00') });
    const routine = makeRoutine({ spaceId: PERSO, time: asLocalTime('07:00') });
    const event = makeEvent({ spaceId: PERSO, startDate: '2026-03-12', repeat: 'yearly' });
    return {
      now: NOW,
      tasks: [t1, t2],
      routines: [routine],
      routinePauses: [pause(routine, '2026-10-08', '2026-10-08')],
      routineLogs: [makeLog(routine, '2026-10-07')],
      events: [event],
      reminders: [reminder('task', t1, 0), reminder('task', t1, 15), reminder('task', t2, 0), reminder('routine', routine, 30), reminder('event', event, 1440), reminder('event', event, 0)],
      spaces: SPACES,
      recaps: DEFAULT_RECAPS,
    };
  }

  it('22 : n’appelle ni Date.now ni Math.random, n’importe ni platform, ni db, ni i18n', () => {
    for (const file of ['notificationPlan.ts', 'notificationId.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)|performance\.now/);
      expect(source, file).not.toMatch(/from\s+'[^']*\/(platform|db|i18n)(\/[^']*)?'/);
    }
  });

  it('22 : ne modifie pas ses arguments (entrées gelées en profondeur)', () => {
    expect(() => planNotifications(deepFreeze(scenario()))).not.toThrow();
  });

  it('22 : même résultat quel que soit l’ordre des tableaux d’entrée', () => {
    const input = scenario();
    const reversed: NotificationPlanInput = {
      ...input,
      tasks: [...input.tasks].reverse(),
      routines: [...input.routines].reverse(),
      routinePauses: [...input.routinePauses].reverse(),
      routineLogs: [...input.routineLogs].reverse(),
      events: [...input.events].reverse(),
      reminders: [...input.reminders].reverse(),
      spaces: [...input.spaces].reverse(),
    };
    expect(planNotifications(reversed)).toEqual(planNotifications(input));
  });

  it('22 : un doublon de ligne reminder donne le même résultat dans les deux ordres', () => {
    const input = scenario();
    const copy = { ...(input.reminders[0] as Reminder), id: uuid('22000000', 999) as ReminderId };
    const a = planNotifications({ ...input, reminders: [...input.reminders, copy] });
    const b = planNotifications({ ...input, reminders: [copy, ...[...input.reminders].reverse()] });
    expect(a).toEqual(b);
    expect(a).toEqual(planNotifications(input));
  });

  it('23 : le plan est identique quel que soit le fuseau de l’appareil', () => {
    const original = process.env['TZ'];
    try {
      const results = ['UTC', 'Europe/Paris', 'Pacific/Auckland', 'America/Los_Angeles'].map((zone) => {
        process.env['TZ'] = zone;
        return planNotifications(scenario());
      });
      // Les identifiants de réglage sont recréés à chaque appel de scenario() : on compare les formes sans identifiants uniques.
      const shape = (p: ReturnType<typeof planNotifications>) => p.items.map((item) => [item.kind, item.fireAt]);
      for (const result of results) expect(shape(result)).toEqual(shape(results[0] as typeof result));
      expect(results[0]?.items.length).toBeGreaterThan(5);
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });

  it('23 : heures du changement d’heure inchangées (02:30 le 29 mars reste 02:30)', () => {
    const t = task({ date: asLocalDate('2027-03-28'), time: asLocalTime('02:30') });
    const result = plan({ tasks: [t], reminders: [reminder('task', t, 0)], now: asLocalDateTime('2027-03-27T10:00') });
    expect(fires(result.items)).toEqual(['2027-03-28T02:30']);
  });

  it('24 : 5 000 tâches, 200 événements répétés, 30 routines : au plus 64 éléments', () => {
    const tasks: Task[] = [];
    const reminders: Reminder[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const t = task({ date: asLocalDate(`2026-${i % 2 === 0 ? '10' : '11'}-${String((i % 28) + 1).padStart(2, '0')}`), time: asLocalTime('09:00') });
      tasks.push(t);
      if (i % 250 === 0) reminders.push(reminder('task', t, 15));
    }
    const events: CalendarEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      const event = makeEvent({ spaceId: i % 2 === 0 ? PRO : PERSO, startDate: '2025-01-15', repeat: i % 2 === 0 ? 'monthly' : 'yearly' });
      events.push(event);
      reminders.push(reminder('event', event, 1440));
    }
    const routines: Routine[] = [];
    for (let i = 0; i < 30; i += 1) {
      const routine = makeRoutine({ spaceId: PERSO, time: asLocalTime('07:00'), scheduleType: 'every_n_days', interval: (i % 5) + 1 });
      routines.push(routine);
      reminders.push(reminder('routine', routine, 0));
    }
    const result = plan({ tasks, events, routines, reminders, recaps: DEFAULT_RECAPS });
    expect(result.items).toHaveLength(64);
    expect(result.total).toBeGreaterThan(64);
    expect(result.coverage.state).toBe('until');
    expect(fires(result.items)).toEqual([...fires(result.items)].sort());
  });
});
