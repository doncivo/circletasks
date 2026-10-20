import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bodyDomain from '../../domain/notificationBody';
import { makeEvent } from '../../domain/eventTestKit';
import type { Reminder, Task } from '../../domain/model';
import { planNotifications, type PlannedItem } from '../../domain/notificationPlan';
import { DEFAULT_PRO_QUIET_HOURS } from '../../domain/quietHours';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { asEntityId, asLocalDate, asLocalDateTime, asLocalTime, type SpaceId } from '../../domain/types';
import { ensureLocale, setLocale } from '../../i18n';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { notificationBodyFr } from '../../i18n/fr.notificationBody';
import { notificationBodyEn } from '../../i18n/en.notificationBody';
import { requestFor, requestsFor } from './notificationTexts';

interface BodyCase {
  readonly kind?: 'task' | 'routine' | 'event' | 'snooze';
  readonly originKind?: 'task' | 'routine' | 'event';
  readonly date?: string;
  readonly time?: string;
  readonly offset?: number;
  readonly fireAt?: string;
  readonly allDay?: boolean;
  readonly space?: 'Pro' | 'Perso' | null;
}

export function bodyFixture(input: BodyCase = {}) {
  const kind = input.kind ?? 'task';
  const originKind = input.originKind ?? 'task';
  const date = input.date ?? '2026-09-23';
  const time = input.time ?? '09:00';
  const offsetMin = input.offset ?? 0;
  const targetId = '11000000-0000-4000-8000-000000000001';
  const reminderId = '22000000-0000-4000-8000-000000000001';
  const spaceId = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
  const scheduledAt = reminderFireAt(asLocalDate(date), time, offsetMin);
  const item = {
    kind, originKind, id: `${kind}:${reminderId}:${date}`, reminderId, targetId, offsetMin, spaceId,
    occurrenceDate: kind === 'snooze' && originKind === 'task' ? null : date,
    scheduledAt, fireAt: input.fireAt ?? scheduledAt,
  } as unknown as PlannedItem;
  const lookup = {
    tasks: new Map([[targetId, { title: 'Tâche', date: asLocalDate(date), time: asLocalTime(time), spaceId }]]),
    routines: new Map([[targetId, { title: 'Routine', time: asLocalTime(time), spaceId }]]),
    events: new Map([[targetId, { title: 'Événement', startDate: asLocalDate(date), startTime: input.allDay ? null : asLocalTime(time), allDay: input.allDay ?? false, spaceId }]]),
    spaces: input.space === null ? new Map<string, { name: string }>() : new Map([[spaceId, { name: input.space ?? 'Perso' }]]),
  };
  return { item, lookup };
}

const cases: readonly [string, BodyCase, string][] = [
  ['tâche Pro à l’heure', { space: 'Pro' }, '09:00 · Pro'],
  ['avance trente', { offset: 30 }, '09:00 · Perso'],
  ['avance quinze', { offset: 15 }, '09:00 · Perso'],
  ['avance soixante', { offset: 60 }, '09:00 · Perso'],
  ['annonce la veille', { date: '2026-09-24', offset: 1440 }, 'jeu. 24 sept. · 09:00 · Perso'],
  ['soirée décalée', { date: '2026-09-22', time: '19:30', space: 'Pro', fireAt: '2026-09-23T08:00' }, 'mar. 22 sept. · 19:30 · Pro · décalé'],
  ['avance trente puis plage', { date: '2026-09-22', time: '20:00', offset: 30, space: 'Pro', fireAt: '2026-09-23T08:00' }, 'mar. 22 sept. · 20:00 · Pro · décalé'],
  ['avance zéro puis plage', { date: '2026-09-22', time: '20:00', space: 'Pro', fireAt: '2026-09-23T08:00' }, 'mar. 22 sept. · 20:00 · Pro · décalé'],
  ['matin décalé même jour', { time: '07:00', space: 'Pro', fireAt: '2026-09-23T08:00' }, '07:00 · Pro · décalé'],
  ['vendredi au lundi', { date: '2026-09-25', time: '19:30', space: 'Pro', fireAt: '2026-09-28T08:00' }, 'ven. 25 sept. · 19:30 · Pro · décalé'],
  ['dimanche annoncé samedi', { date: '2026-09-27', offset: 1440, space: 'Pro', fireAt: '2026-09-28T08:00' }, 'dim. 27 sept. · 09:00 · Pro · décalé'],
  ['routine Perso', { kind: 'routine', time: '07:00' }, '07:00 · Perso'],
  ['routine Pro décalée', { kind: 'routine', date: '2026-09-22', time: '20:00', space: 'Pro', fireAt: '2026-09-23T08:00' }, 'mar. 22 sept. · 20:00 · Pro · décalé'],
  ...[0, 1440, 10080].map(offset => [`événement avance ${offset}`, { kind: 'event', time: '14:30', space: 'Pro', offset }, 'mer. 23 sept. · 14:30 · Pro'] as [string, BodyCase, string]),
  ['journée entière annoncée la veille', { kind: 'event', allDay: true, date: '2027-03-12', offset: 1440 }, 'ven. 12 mars · Journée entière · Perso'],
  ['journée entière décalée', { kind: 'event', allDay: true, date: '2026-09-26', space: 'Pro', fireAt: '2026-09-28T08:00' }, 'sam. 26 sept. · Journée entière · Pro · décalé'],
  ['répétition tâche', { kind: 'snooze', time: '14:00', fireAt: '2026-09-23T14:15' }, 'Reporté · 14:00'],
  ['répétition tâche annoncée la veille', { kind: 'snooze', date: '2026-09-24', fireAt: '2026-09-23T09:15' }, 'Reporté · jeu. 24 sept. · 09:00'],
  ['répétition routine', { kind: 'snooze', originKind: 'routine', time: '07:00', fireAt: '2026-09-23T07:15' }, 'Reporté · 07:00'],
  ['répétition événement', { kind: 'snooze', originKind: 'event', time: '14:30', fireAt: '2026-09-23T14:45' }, 'Reporté · mer. 23 sept. · 14:30'],
  ['répétition journée entière', { kind: 'snooze', originKind: 'event', date: '2027-03-12', allDay: true, fireAt: '2027-03-12T09:15' }, 'Reporté · ven. 12 mars · Journée entière'],
  ['espace introuvable', { space: null }, '09:00'],
  ['événement sans espace', { kind: 'event', time: '14:30', space: null }, 'mer. 23 sept. · 14:30'],
  ['décalage sans espace', { date: '2026-09-22', time: '19:30', space: null, fireAt: '2026-09-23T08:00' }, 'mar. 22 sept. · 19:30 · décalé'],
];

describe('N-FIX-02 : texte réellement lu sur la notification', () => {
  beforeEach(() => { setLocale('fr'); setFormatPrefs({ timeFormat: '24h' }); });
  afterEach(() => { vi.restoreAllMocks(); setLocale('fr'); setFormatPrefs({ timeFormat: '24h' }); });
  it.each(cases)('%s', (_, input, expected) => {
    const { item, lookup } = bodyFixture(input);
    const body = requestFor(item, lookup).body;
    expect(body).toBe(expected);
    expect(body).not.toMatch(/[{}()]|notifications\./);
  });

  it('l’heure suit le point de formatage commun en 12 h', () => {
    setFormatPrefs({ timeFormat: '12h' });
    const { item, lookup } = bodyFixture({ space: 'Pro' });
    expect(requestFor(item, lookup).body).toBe('9:00 AM · Pro');
  });

  it('catalogue anglais chargé avec le corps, sans clé brute', async () => {
    await ensureLocale('en');
    setLocale('en');
    const { item, lookup } = bodyFixture({ time: '20:00', date: '2026-09-22', fireAt: '2026-09-23T08:00' });
    expect(requestFor(item, lookup).body).toBe('Tue, Sep 22 · 20:00 · Perso · shifted');
  });

  it('les quatre natures passent une seule fois par la description pure commune', () => {
    const describeBody = vi.spyOn(bodyDomain, 'bodyParts');
    for (const kind of ['task', 'routine', 'event', 'snooze'] as const) {
      const { item, lookup } = bodyFixture({ kind });
      requestFor(item, lookup);
    }
    expect(describeBody).toHaveBeenCalledTimes(4);
    const { lookup } = bodyFixture();
    requestFor({ kind: 'recap', id: 'recap:morning:2026-09-24', recapKind: 'morning', day: asLocalDate('2026-09-24'), fireAt: '2026-09-24T07:30' as PlannedItem['fireAt'], content: null }, lookup);
    expect(describeBody).toHaveBeenCalledTimes(4);
  });

  it.each([0, 30, 60, 1440, 10080])('heure de l’élément conservée après décalage et avance %s', offset => {
    const { item, lookup } = bodyFixture({ date: '2026-09-22', time: '20:00', offset, fireAt: '2026-09-23T08:00', space: 'Pro' });
    const body = requestFor(item, lookup).body;
    expect(body).toBe('mar. 22 sept. · 20:00 · Pro · décalé');
    expect(body).not.toContain('08:00');
    if (item.kind !== 'recap' && item.kind !== 'snooze' && item.scheduledAt.slice(11) !== '20:00') expect(body).not.toContain(item.scheduledAt.slice(11));
    expect(body.endsWith(' · décalé')).toBe(true);
  });

  it('catalogues de même forme, sans nombre ni pluriel automatique', () => {
    expect(Object.keys(notificationBodyEn)).toEqual(Object.keys(notificationBodyFr));
    expect(Object.values(notificationBodyFr).join(' ')).not.toMatch(/\{(?:n|count|number)\}|\bplural\b|\d/);
  });

  it('un plan réel conserve les heures des cibles pour tâche décalée, journée entière et répétition', () => {
    const pro = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
    const perso = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
    const task = { id: '11000000-0000-4000-8000-000000000001', spaceId: pro, title: 'Tâche', date: asLocalDate('2026-09-22'), time: asLocalTime('20:00'), status: 'todo', someday: false, deletedAt: null } as unknown as Task;
    const event = makeEvent({ startDate: '2027-03-12', spaceId: perso, allDay: true });
    const taskReminder = { id: '22000000-0000-4000-8000-000000000001', targetType: 'task', targetId: task.id, offsetMin: 30, deletedAt: null } as unknown as Reminder;
    const eventReminder = { id: '22000000-0000-4000-8000-000000000002', targetType: 'event', targetId: event.id, offsetMin: 1440, deletedAt: null } as unknown as Reminder;
    const plan = planNotifications({
      now: asLocalDateTime('2026-09-22T18:00'), tasks: [task], routines: [], routineLogs: [], routinePauses: [], events: [event], reminders: [taskReminder, eventReminder],
      spaces: [{ id: pro, quietHours: DEFAULT_PRO_QUIET_HOURS }, { id: perso, quietHours: [] }],
      recaps: { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: false, time: asLocalTime('21:00') } },
      snoozes: [{ id: `snooze:task:${taskReminder.id}`, originId: `task:${taskReminder.id}`, fireAt: asLocalDateTime('2026-09-22T18:15') }],
    });
    expect(requestsFor(plan, { tasks: new Map([[task.id, task]]), routines: new Map(), events: new Map([[event.id, event]]), spaces: new Map([[pro, { name: 'Pro' }], [perso, { name: 'Perso' }]]) }).map(request => request.body)).toEqual([
      'Reporté · 20:00', 'mar. 22 sept. · 20:00 · Pro · décalé', 'ven. 12 mars · Journée entière · Perso',
    ]);
  });
});
