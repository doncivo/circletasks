import { describe, expect, it } from 'vitest';
import { addMinutesTo, defaultEventEnd, endAfterStartChange, EVENT_TITLE_MAX, validateEvent, validateEventTitle } from './eventRules';
import { makeEvent } from './eventTestKit';
import type { EventFields } from './model';
import { asLocalDate as d, asLocalTime as tm } from './types';

const fieldsOf = (overrides: Parameters<typeof makeEvent>[0] = {}): EventFields => {
  const event = makeEvent(overrides);
  return {
    spaceId: event.spaceId,
    title: event.title,
    startDate: event.startDate,
    startTime: event.startTime,
    endDate: event.endDate,
    endTime: event.endTime,
    allDay: event.allDay,
    kind: event.kind,
    repeat: event.repeat,
    important: event.important,
    icon: event.icon,
    birthYear: event.birthYear,
  };
};

describe('règles des événements (E-01)', () => {
  it('titre : 1 à 200 caractères après nettoyage', () => {
    expect(validateEventTitle('  Point client ')).toEqual({ ok: true, value: 'Point client' });
    expect(validateEventTitle('   ')).toEqual({ ok: false, error: 'empty-title' });
    expect(validateEventTitle('a'.repeat(EVENT_TITLE_MAX)).ok).toBe(true);
    expect(validateEventTitle('a'.repeat(EVENT_TITLE_MAX + 1))).toEqual({ ok: false, error: 'title-too-long' });
  });

  it('journée entière : un seul jour, sans heure', () => {
    const result = validateEvent(fieldsOf({ allDay: true, startDate: '2026-09-23', endDate: '2026-09-25', startTime: tm('10:00'), endTime: tm('11:00') }));
    expect(result).toMatchObject({ ok: true, value: { endDate: '2026-09-23', startTime: null, endTime: null } });
  });

  it('plage horaire : heures obligatoires, fin >= début, passage de minuit permis', () => {
    expect(validateEvent(fieldsOf({ allDay: false }))).toEqual({ ok: false, error: 'missing-time' });
    const base = { allDay: false, startDate: '2026-09-23', endDate: '2026-09-23' };
    expect(validateEvent(fieldsOf({ ...base, startTime: tm('10:00'), endTime: tm('09:59') }))).toEqual({ ok: false, error: 'end-before-start' });
    expect(validateEvent(fieldsOf({ ...base, startTime: tm('10:00'), endTime: tm('10:00') })).ok).toBe(true);
    expect(validateEvent(fieldsOf({ ...base, endDate: '2026-09-24', startTime: tm('22:00'), endTime: tm('02:00') })).ok).toBe(true);
    expect(validateEvent(fieldsOf({ ...base, endDate: '2026-09-22', startTime: tm('10:00'), endTime: tm('11:00') }))).toEqual({ ok: false, error: 'end-before-start' });
  });

  it('durée par défaut d’une heure, passage au jour suivant', () => {
    expect(defaultEventEnd(d('2026-09-23'), tm('10:00'))).toEqual({ date: '2026-09-23', time: '11:00' });
    expect(defaultEventEnd(d('2026-09-23'), tm('23:30'))).toEqual({ date: '2026-09-24', time: '00:30' });
    expect(addMinutesTo(d('2026-09-23'), tm('00:10'), -20)).toEqual({ date: '2026-09-22', time: '23:50' });
  });

  it('changer le début garde la durée de l’événement', () => {
    const end = endAfterStartChange({ date: d('2026-09-23'), time: tm('10:00') }, { date: d('2026-09-24'), time: tm('14:00') }, { date: d('2026-09-23'), time: tm('11:30') });
    expect(end).toEqual({ date: '2026-09-24', time: '15:30' });
    const fixed = endAfterStartChange({ date: d('2026-09-23'), time: tm('10:00') }, { date: d('2026-09-23'), time: tm('10:00') }, { date: d('2026-09-22'), time: tm('09:00') });
    expect(fixed).toEqual({ date: '2026-09-23', time: '11:00' });
  });
});
