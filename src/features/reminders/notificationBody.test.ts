import { beforeEach, describe, expect, it } from 'vitest';
import type { PlannedItem } from '../../domain/notificationPlan';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { asLocalDate } from '../../domain/types';
import { setLocale } from '../../i18n';
import { requestFor } from './notificationTexts';

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
  const spaceId = '10000000-0000-4000-8000-000000000001';
  const scheduledAt = reminderFireAt(asLocalDate(date), time, offsetMin);
  const item = {
    kind, originKind, id: `${kind}:${reminderId}:${date}`, reminderId, targetId, offsetMin, spaceId,
    occurrenceDate: kind === 'snooze' && originKind === 'task' ? null : date,
    scheduledAt, fireAt: input.fireAt ?? scheduledAt,
  } as unknown as PlannedItem;
  const lookup = {
    tasks: new Map([[targetId, { title: 'Tâche', date, time, spaceId }]]),
    routines: new Map([[targetId, { title: 'Routine', time, spaceId }]]),
    events: new Map([[targetId, { title: 'Événement', startDate: date, startTime: input.allDay ? null : time, allDay: input.allDay ?? false, spaceId }]]),
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
  beforeEach(() => setLocale('fr'));
  it.each(cases)('%s', (_, input, expected) => {
    const { item, lookup } = bodyFixture(input);
    const body = requestFor(item, lookup).body;
    expect(body).toBe(expected);
    expect(body).not.toMatch(/[{}()]|notifications\./);
  });
});
