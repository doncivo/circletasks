import { describe, expect, it } from 'vitest';
import { makeEvent } from './eventTestKit';
import type { QuietHours, Reminder, ReminderOffsetMin, ReminderTargetType, Routine, RoutinePause, Task } from './model';
import { planNotifications, type NotificationPlanInput, type PlannedItem } from './notificationPlan';
import { DEFAULT_PRO_QUIET_HOURS } from './quietHours';
import type { RecapSettings } from './recap';
import { makeLog, makeRoutine } from './routineTestKit';
import { asEntityId, asLocalDate, asLocalDateTime, asLocalTime, type Id, type LocalTime, type ReminderId, type RoutinePauseId, type SpaceId, type Weekday } from './types';

/** QA N-TECH-01 : changements d'heure, plages à cheval, fins de mois, pauses, quotas, égalités, plafond. */

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const NIGHT = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000003');
const EVERY_DAY: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const range = (from: string, to: string): QuietHours => ({ weekdays: EVERY_DAY, from: from as LocalTime, to: to as LocalTime });
const SPACES = [
  { id: PRO, quietHours: DEFAULT_PRO_QUIET_HOURS },
  { id: PERSO, quietHours: [] },
  { id: NIGHT, quietHours: [range('23:00', '06:00')] },
] as const;

const NO_RECAPS: RecapSettings = { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: false, time: asLocalTime('21:00') } };
const DEFAULT_RECAPS: RecapSettings = { morning: { enabled: true, time: asLocalTime('07:30') }, evening: { enabled: true, time: asLocalTime('21:00') } };
const NOW = asLocalDateTime('2026-10-07T10:00');

let counter = 0;
const uuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function task(over: Partial<Task> = {}): Task {
  counter += 1;
  return { id: uuid('51000000', counter), spaceId: PERSO, title: 'Tâche', date: asLocalDate('2026-10-08'), time: asLocalTime('09:00'), status: 'todo', someday: false, sortOrder: 0, deletedAt: null, ...over } as unknown as Task;
}

function reminder(targetType: ReminderTargetType, target: { readonly id: Id }, offsetMin: number): Reminder {
  counter += 1;
  return { id: uuid('52000000', counter) as ReminderId, targetType, targetId: target.id, offsetMin: offsetMin as ReminderOffsetMin, fireAt: asLocalDateTime('2020-01-01T00:00'), delivered: false, deletedAt: null } as unknown as Reminder;
}

function pause(routine: Routine, from: string, to: string | null): RoutinePause {
  counter += 1;
  return { id: uuid('53000000', counter) as RoutinePauseId, routineId: routine.id, fromDate: asLocalDate(from), toDate: to === null ? null : asLocalDate(to), deletedAt: null } as unknown as RoutinePause;
}

function plan(over: Partial<NotificationPlanInput> = {}) {
  return planNotifications({ now: NOW, tasks: [], routines: [], routinePauses: [], routineLogs: [], events: [], reminders: [], spaces: SPACES, recaps: NO_RECAPS, ...over });
}

const fires = (items: readonly PlannedItem[]): string[] => items.map((item) => item.fireAt);
const ids = (items: readonly PlannedItem[]): string[] => items.map((item) => item.id);
const taskFire = (spaceId: SpaceId, date: string, time: string, offset = 0, now = '2027-01-01T00:00'): string[] => {
  const t = task({ spaceId, date: asLocalDate(date), time: asLocalTime(time) });
  return fires(plan({ tasks: [t], reminders: [reminder('task', t, offset)], now: asLocalDateTime(now) }).items);
};

/** Exécute `run` sous plusieurs fuseaux et vérifie que le résultat est identique (le planificateur ignore le fuseau). */
function sameInEveryZone<T>(run: () => T): T {
  const original = process.env['TZ'];
  try {
    const results = ['Europe/Paris', 'UTC', 'America/New_York'].map((zone) => {
      process.env['TZ'] = zone;
      return run();
    });
    for (const result of results) expect(result).toEqual(results[0]);
    return results[0] as T;
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
}

describe('changement d’heure Europe/Paris (critère 23)', () => {
  it('23 : heure inexistante 02:30 le 28 mars 2027 : conservée telle quelle, une fois', () => {
    expect(sameInEveryZone(() => taskFire(PERSO, '2027-03-28', '02:30'))).toEqual(['2027-03-28T02:30']);
  });

  it('23 : avance de 15 min sur 03:00 le jour du passage à l’heure d’été : 02:45, arithmétique civile', () => {
    expect(sameInEveryZone(() => taskFire(PERSO, '2027-03-28', '03:00', 15))).toEqual(['2027-03-28T02:45']);
  });

  it('23 : avance d’un jour depuis le lendemain du passage à l’heure d’été : même heure civile la veille', () => {
    expect(sameInEveryZone(() => taskFire(PERSO, '2027-03-29', '02:30', 1440))).toEqual(['2027-03-28T02:30']);
  });

  it('23 : heure doublée 02:30 le 31 octobre 2027 : un seul élément, pas de doublon', () => {
    expect(sameInEveryZone(() => taskFire(PERSO, '2027-10-31', '02:30'))).toEqual(['2027-10-31T02:30']);
  });

  it('23 : avance d’un jour sur la nuit du retour à l’heure d’hiver (lendemain 02:30) : 02:30 la veille', () => {
    expect(sameInEveryZone(() => taskFire(PERSO, '2027-11-01', '02:30', 1440))).toEqual(['2027-10-31T02:30']);
  });

  it('23 : routine quotidienne à 02:30 : occurrence du 28 mars 2027 à 02:30, du 31 octobre 2027 à 02:30', () => {
    const routine = makeRoutine({ spaceId: PERSO, time: asLocalTime('02:30') });
    const r = reminder('routine', routine, 0);
    const at = (now: string) => sameInEveryZone(() => fires(plan({ routines: [routine], reminders: [r], now: asLocalDateTime(now) }).items));
    expect(at('2027-03-28T00:00')).toEqual(['2027-03-28T02:30']);
    expect(at('2027-10-31T00:00')).toEqual(['2027-10-31T02:30']);
  });

  it('23 : événement à 02:30 le 28 mars 2027 avec avance 0 : 02:30', () => {
    const event = makeEvent({ spaceId: PERSO, startDate: '2027-03-28', allDay: false, startTime: asLocalTime('02:30'), endTime: asLocalTime('03:30') });
    expect(sameInEveryZone(() => fires(plan({ events: [event], reminders: [reminder('event', event, 0)], now: asLocalDateTime('2027-03-27T00:00') }).items))).toEqual(['2027-03-28T02:30']);
  });

  it('23 : now = 02:30 le jour du passage : une échéance à 02:30 est exclue, 02:31 est gardée', () => {
    const now = '2027-03-28T02:30';
    expect(taskFire(PERSO, '2027-03-28', '02:30', 0, now)).toEqual([]);
    expect(taskFire(PERSO, '2027-03-28', '02:31', 0, now)).toEqual(['2027-03-28T02:31']);
  });
});

describe('plages silencieuses à cheval sur minuit et sur le changement d’heure (critères 10 et 11)', () => {
  it('10 : plage 23:00 → 06:00, rappel à 23:30 : le lendemain 06:00', () => {
    expect(taskFire(NIGHT, '2026-10-13', '23:30', 0, '2026-10-07T10:00')).toEqual(['2026-10-14T06:00']);
  });

  it('10 : plage 23:00 → 06:00, rappel à 00:00 et 03:00 : 06:00 du même jour (plage commencée la veille)', () => {
    expect(taskFire(NIGHT, '2026-10-14', '00:00', 0, '2026-10-07T10:00')).toEqual(['2026-10-14T06:00']);
    expect(taskFire(NIGHT, '2026-10-14', '03:00', 0, '2026-10-07T10:00')).toEqual(['2026-10-14T06:00']);
  });

  it('10 : bornes : début de plage inclus (23:00 décalé), fin exclue (06:00 et 22:59 inchangés)', () => {
    expect(taskFire(NIGHT, '2026-10-13', '23:00', 0, '2026-10-07T10:00')).toEqual(['2026-10-14T06:00']);
    expect(taskFire(NIGHT, '2026-10-13', '06:00', 0, '2026-10-07T10:00')).toEqual(['2026-10-13T06:00']);
    expect(taskFire(NIGHT, '2026-10-13', '22:59', 0, '2026-10-07T10:00')).toEqual(['2026-10-13T22:59']);
  });

  it('10 : fin d’année et année bissextile : 31 décembre 23:30 → 1er janvier 06:00 ; 28 février 2028 → 29 février', () => {
    expect(taskFire(NIGHT, '2026-12-31', '23:30', 0, '2026-10-07T10:00')).toEqual(['2027-01-01T06:00']);
    expect(taskFire(NIGHT, '2028-02-28', '23:30', 0, '2026-10-07T10:00')).toEqual(['2028-02-29T06:00']);
    expect(taskFire(NIGHT, '2027-02-28', '23:30', 0, '2026-10-07T10:00')).toEqual(['2027-03-01T06:00']);
  });

  it('10 : une avance qui ramène l’échéance dans la plage la décale (06:15 avance 30 min → 05:45 → 06:00)', () => {
    expect(taskFire(NIGHT, '2026-10-13', '06:15', 30, '2026-10-07T10:00')).toEqual(['2026-10-13T06:00']);
  });

  it('10 : Pro, vendredi 23:30 : la plage du soir puis le week-end en entier : lundi 08:00', () => {
    expect(taskFire(PRO, '2027-03-26', '23:30')).toEqual(['2027-03-29T08:00']);
  });

  it('10 : Pro, nuit du passage à l’heure d’été (samedi 22:00 → lundi 08:00), identique sous tout fuseau', () => {
    expect(sameInEveryZone(() => taskFire(PRO, '2027-03-27', '22:00'))).toEqual(['2027-03-29T08:00']);
  });

  it('10 : plage couvrant l’heure inexistante : 02:30 le 28 mars 2027 dans 01:00 → 03:30 : 03:30', () => {
    const space = asEntityId<SpaceId>(uuid('10000000', 30));
    const t = task({ spaceId: space, date: asLocalDate('2027-03-28'), time: asLocalTime('02:30') });
    const spaces = [{ id: space, quietHours: [range('01:00', '03:30')] }];
    expect(sameInEveryZone(() => fires(plan({ spaces, tasks: [t], reminders: [reminder('task', t, 0)], now: asLocalDateTime('2027-03-27T10:00') }).items))).toEqual(['2027-03-28T03:30']);
  });

  it('10 : plage couvrant l’heure doublée : 02:30 le 31 octobre 2027 dans 01:30 → 03:00 : 03:00, un seul élément', () => {
    const space = asEntityId<SpaceId>(uuid('10000000', 31));
    const t = task({ spaceId: space, date: asLocalDate('2027-10-31'), time: asLocalTime('02:30') });
    const spaces = [{ id: space, quietHours: [range('01:30', '03:00')] }];
    const r = reminder('task', t, 0);
    const items = sameInEveryZone(() => plan({ spaces, tasks: [t], reminders: [r], now: asLocalDateTime('2027-10-30T10:00') }).items);
    expect(fires(items)).toEqual(['2027-10-31T03:00']);
  });

  it('8 et 10 : l’exclusion du passé porte sur l’échéance effective, à cheval sur minuit', () => {
    const t = task({ spaceId: NIGHT, date: asLocalDate('2026-10-13'), time: asLocalTime('23:30') });
    const r = reminder('task', t, 0);
    const at = (now: string) => fires(plan({ tasks: [t], reminders: [r], now: asLocalDateTime(now) }).items);
    expect(at('2026-10-14T05:59')).toEqual(['2026-10-14T06:00']);
    expect(at('2026-10-14T06:00')).toEqual([]);
  });

  it('11 : les récapitulatifs ignorent les plages à cheval sur minuit (un récapitulatif à 23:30 reste à 23:30)', () => {
    const recaps: RecapSettings = { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: true, time: asLocalTime('23:30') } };
    expect(fires(plan({ recaps, limit: 2 }).items)).toEqual(['2026-10-07T23:30', '2026-10-08T23:30']);
  });
});

describe('fins de mois et 29 février (critère 16)', () => {
  const dates = (items: readonly PlannedItem[]): string[] => items.map((item) => (item.kind === 'event' ? item.occurrenceDate : ''));

  it('16 : mensuel le 31 depuis janvier : 30 en novembre, 31 en décembre, 28 en février, 31 en mars, 30 en avril', () => {
    const monthly = makeEvent({ spaceId: PERSO, startDate: '2026-01-31', repeat: 'monthly' });
    const result = plan({ events: [monthly], reminders: [reminder('event', monthly, 0)] });
    expect(dates(result.items).slice(0, 7)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('16 : mensuel le 31 en année bissextile : 29 février 2028', () => {
    const monthly = makeEvent({ spaceId: PERSO, startDate: '2027-01-31', repeat: 'monthly' });
    const result = plan({ events: [monthly], reminders: [reminder('event', monthly, 0)], now: asLocalDateTime('2028-01-15T10:00') });
    expect(dates(result.items).slice(0, 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('16 : annuel le 29 février : le 29 en année bissextile (2028), rien d’autre dans l’horizon', () => {
    const leap = makeEvent({ spaceId: PERSO, startDate: '2024-02-29', repeat: 'yearly' });
    const result = plan({ events: [leap], reminders: [reminder('event', leap, 0)], now: asLocalDateTime('2027-10-07T10:00') });
    expect(fires(result.items)).toEqual(['2028-02-29T09:00']);
  });

  it('16 : annuel le 29 février, avance la veille et 7 jours : échéances 28 février et 22 février 2028', () => {
    const leap = makeEvent({ spaceId: PERSO, startDate: '2024-02-29', repeat: 'yearly' });
    const result = plan({ events: [leap], reminders: [reminder('event', leap, 1440), reminder('event', leap, 10080)], now: asLocalDateTime('2027-10-07T10:00') });
    expect(fires(result.items)).toEqual(['2028-02-22T09:00', '2028-02-28T09:00']);
  });

  it('16 : annuel le 29 février : 28 février 2029 (année non bissextile) quand now précède', () => {
    const leap = makeEvent({ spaceId: PERSO, startDate: '2024-02-29', repeat: 'yearly' });
    const result = plan({ events: [leap], reminders: [reminder('event', leap, 0)], now: asLocalDateTime('2028-03-01T00:00') });
    expect(fires(result.items)).toEqual(['2029-02-28T09:00']);
  });

  it('16 : un événement du jour de now à l’heure passée n’est pas rattrapé ; celui de demain l’est', () => {
    const today = makeEvent({ spaceId: PERSO, startDate: '2026-10-07', allDay: false, startTime: asLocalTime('09:00'), endTime: asLocalTime('10:00') });
    const tomorrow = makeEvent({ spaceId: PERSO, startDate: '2026-10-08' });
    const result = plan({ events: [today, tomorrow], reminders: [reminder('event', today, 0), reminder('event', tomorrow, 0)] });
    expect(fires(result.items)).toEqual(['2026-10-08T09:00']);
  });
});

describe('routines : pause, validation, quota (critères 12 et 13)', () => {
  const at = (hhmm: string, over: Partial<Routine> = {}): Routine => makeRoutine({ spaceId: PERSO, time: asLocalTime(hhmm), ...over });

  it('13 : routine en pause qui reprend dans l’horizon : la première occurrence après la fin de pause, pour chaque avance', () => {
    const routine = at('07:00');
    const rs = [reminder('routine', routine, 0), reminder('routine', routine, 30)];
    const result = plan({ routines: [routine], reminders: rs, routinePauses: [pause(routine, '2026-10-01', '2026-12-31')] });
    expect(result.items.map((item) => [item.fireAt, item.id.split(':')[2]])).toEqual([
      ['2027-01-01T06:30', '2027-01-01'],
      ['2027-01-01T07:00', '2027-01-01'],
    ]);
  });

  it('13 : pause d’un jour (aujourd’hui) : demain ; pause commençant demain : aujourd’hui reste planifiée', () => {
    const routine = at('18:00');
    const r = reminder('routine', routine, 0);
    expect(fires(plan({ routines: [routine], reminders: [r], routinePauses: [pause(routine, '2026-10-07', '2026-10-07')] }).items)).toEqual(['2026-10-08T18:00']);
    expect(fires(plan({ routines: [routine], reminders: [r], routinePauses: [pause(routine, '2026-10-08', null)] }).items)).toEqual(['2026-10-07T18:00']);
  });

  it('13 : pause supprimée (deletedAt) : sans effet', () => {
    const routine = at('18:00');
    const gone = { ...pause(routine, '2026-10-07', null), deletedAt: '2026-10-07T08:00:00.000Z' } as unknown as RoutinePause;
    expect(fires(plan({ routines: [routine], reminders: [reminder('routine', routine, 0)], routinePauses: [gone] }).items)).toEqual(['2026-10-07T18:00']);
  });

  it('13 : quota atteint puis nouvelle semaine : rien jusqu’au lundi, le lundi la routine reprend', () => {
    const routine = at('07:00', { scheduleType: 'x_per_week', timesPerWeek: 2 });
    const r = reminder('routine', routine, 0);
    const logs = [makeLog(routine, '2026-10-05'), makeLog(routine, '2026-10-06')];
    // Mercredi 6 h (quota atteint) → lundi 12 ; le lundi 12 à 06:00 la semaine est neuve → le jour même.
    expect(fires(plan({ routines: [routine], reminders: [r], routineLogs: logs, now: asLocalDateTime('2026-10-07T06:00') }).items)).toEqual(['2026-10-12T07:00']);
    expect(fires(plan({ routines: [routine], reminders: [r], routineLogs: logs, now: asLocalDateTime('2026-10-12T06:00') }).items)).toEqual(['2026-10-12T07:00']);
    // Dimanche 11 (même semaine, quota atteint) → lundi.
    expect(fires(plan({ routines: [routine], reminders: [r], routineLogs: logs, now: asLocalDateTime('2026-10-11T06:00') }).items)).toEqual(['2026-10-12T07:00']);
  });

  it('13 : quota de 1 atteint le lundi, validation supprimée : le quota n’est plus atteint', () => {
    const routine = at('07:00', { scheduleType: 'x_per_week', timesPerWeek: 1 });
    const r = reminder('routine', routine, 0);
    const now = asLocalDateTime('2026-10-07T06:00');
    expect(fires(plan({ routines: [routine], reminders: [r], routineLogs: [makeLog(routine, '2026-10-05')], now }).items)).toEqual(['2026-10-12T07:00']);
    const undone = makeLog(routine, '2026-10-05', { deletedAt: '2026-10-05T09:00:00.000Z' as never });
    expect(fires(plan({ routines: [routine], reminders: [r], routineLogs: [undone], now }).items)).toEqual(['2026-10-07T07:00']);
  });

  it('12 : routine Pro à 20:00 décalée au lendemain 08:00 quand now est entre les deux : l’occurrence du jour reste due', () => {
    const routine = makeRoutine({ spaceId: PRO, time: asLocalTime('20:00') });
    const r = reminder('routine', routine, 0);
    const items = plan({ routines: [routine], reminders: [r], now: asLocalDateTime('2026-10-07T21:00') }).items;
    expect(items.map((item) => [item.id, item.fireAt])).toEqual([[`routine:${r.id}:2026-10-07`, '2026-10-08T08:00']]);
  });
});

describe('égalités d’échéance et tri stable (critère 20)', () => {
  it('20 : task, routine, event et récapitulatif à la même minute : rappels par identifiant (event, routine, task), récapitulatif en dernier, dans tous les ordres d’entrée', () => {
    const t = task({ date: asLocalDate('2026-10-07'), time: asLocalTime('21:00') });
    const routine = makeRoutine({ spaceId: PERSO, time: asLocalTime('21:00') });
    const event = makeEvent({ spaceId: PERSO, startDate: '2026-10-07', allDay: false, startTime: asLocalTime('21:00'), endTime: asLocalTime('22:00') });
    const rs = [reminder('task', t, 0), reminder('routine', routine, 0), reminder('event', event, 0)];
    const base = { tasks: [t], routines: [routine], events: [event], recaps: DEFAULT_RECAPS, limit: 4 };
    const forward = plan({ ...base, reminders: rs });
    const backward = plan({ ...base, reminders: [...rs].reverse() });
    expect(forward).toEqual(backward);
    expect(ids(forward.items)).toEqual([`event:${rs[2]?.id}:2026-10-07`, `routine:${rs[1]?.id}:2026-10-07`, `task:${rs[0]?.id}`, 'recap:evening:2026-10-07']);
  });

  it('20 : à égalité au plafond, le premier identifiant est gardé et le couperet est stable', () => {
    const tasks = Array.from({ length: 5 }, () => task({ date: asLocalDate('2026-10-09'), time: asLocalTime('09:00') }));
    const rs = tasks.map((t) => reminder('task', t, 0));
    const expected = rs.map((r) => `task:${r.id}`).sort().slice(0, 3);
    const a = plan({ tasks, reminders: rs, limit: 3 });
    const b = plan({ tasks: [...tasks].reverse(), reminders: [...rs].reverse(), limit: 3 });
    expect(ids(a.items)).toEqual(expected);
    expect(b).toEqual(a);
    expect(a.coverage).toEqual({ state: 'until', until: '2026-10-09T09:00' });
    expect(a.total).toBe(5);
  });

  it('20 : le tri par identifiant est en unités de code (majuscule avant minuscule), pas par locale', () => {
    const t1 = task({ date: asLocalDate('2026-10-09'), time: asLocalTime('09:00') });
    const t2 = task({ date: asLocalDate('2026-10-09'), time: asLocalTime('09:00') });
    const upper = { ...reminder('task', t1, 0), id: 'B0000000-0000-4000-8000-000000000001' as ReminderId };
    const lower = { ...reminder('task', t2, 0), id: 'a0000000-0000-4000-8000-000000000001' as ReminderId };
    expect(ids(plan({ tasks: [t1, t2], reminders: [lower, upper] }).items)).toEqual([`task:${upper.id}`, `task:${lower.id}`]);
  });
});

describe('64 et 65 candidats, notifications réservées (critère 6 et 20)', () => {
  function candidates(count: number) {
    const tasks: Task[] = [];
    const reminders: Reminder[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = task({ date: asLocalDate('2026-10-09'), time: asLocalTime(`${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`) });
      tasks.push(t);
      reminders.push(reminder('task', t, 0));
    }
    return { tasks, reminders };
  }

  it('20 : exactement 64 candidats : 64 éléments, total 64, complete', () => {
    const result = plan(candidates(64));
    expect(result.items).toHaveLength(64);
    expect(result.total).toBe(64);
    expect(result.coverage).toEqual({ state: 'complete' });
  });

  it('20 : exactement 65 candidats : 64 éléments, total 65, until = échéance du 64e, le 65e écarté', () => {
    const result = plan(candidates(65));
    expect(result.items).toHaveLength(64);
    expect(result.total).toBe(65);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-10-09T01:03' });
    expect(fires(result.items)).not.toContain('2026-10-09T01:04');
  });

  it('6 : limit 63 avec 64 candidats : until ; avec 63 candidats : complete', () => {
    expect(plan({ ...candidates(64), limit: 63 }).coverage).toEqual({ state: 'until', until: '2026-10-09T01:02' });
    expect(plan({ ...candidates(63), limit: 63 }).coverage).toEqual({ state: 'complete' });
  });

  it('20 : limit 0 sans candidat : empty ; limit 0 avec candidats : aucun élément, total conservé', () => {
    expect(plan({ limit: 0 }).coverage).toEqual({ state: 'empty' });
    const result = plan({ ...candidates(3), limit: 0 });
    expect(result).toMatchObject({ items: [], total: 3, coverage: { state: 'until', until: NOW } });
  });

  it('20 : le total compte les candidats même quand les récapitulatifs saturent le plafond', () => {
    const result = plan({ recaps: DEFAULT_RECAPS });
    expect(result.items).toHaveLength(64);
    expect(result.coverage).toEqual({ state: 'until', until: '2026-11-08T07:30' });
  });
});

describe('entrée vide et totalité', () => {
  it('toutes entrées vides, récapitulatifs désactivés : plan vide, ne lève pas', () => {
    expect(plan()).toEqual({ items: [], coverage: { state: 'empty' }, total: 0, deadSnoozeIds: [] });
  });

  it('rappels orphelins (cible supprimée, jamais fournie) et récapitulatif à l’heure mal formée : plan vide', () => {
    const t = task();
    const recaps = { morning: { enabled: true, time: '7h30' as LocalTime }, evening: { enabled: false, time: asLocalTime('21:00') } } as RecapSettings;
    expect(plan({ reminders: [reminder('task', t, 0), reminder('routine', t, 0), reminder('event', t, 0)], recaps })).toEqual({ items: [], coverage: { state: 'empty' }, total: 0, deadSnoozeIds: [] });
  });

  it('now avec secondes : tronqué à la minute', () => {
    const t = task({ date: asLocalDate('2026-10-07'), time: asLocalTime('10:00') });
    const result = plan({ tasks: [t], reminders: [reminder('task', t, 0)], now: '2026-10-07T09:59:59' as never });
    expect(fires(result.items)).toEqual(['2026-10-07T10:00']);
  });
});
