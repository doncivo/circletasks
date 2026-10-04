import { describe, expect, it } from 'vitest';
import { ageAtOccurrence, annualStartDate, applyKind, checkBirthYear, defaultCountdown, defaultIconFor, isAnnualKind, isLeapYear, nextAnnualDate } from './eventKinds';
import { validateEvent } from './eventRules';
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

describe('types d’événement (E-02)', () => {
  it('anniversaire et date importante sont annuels ; icône par défaut : gâteau et étoile (critère 1)', () => {
    expect(isAnnualKind('birthday')).toBe(true);
    expect(isAnnualKind('important')).toBe(true);
    expect(isAnnualKind('event')).toBe(false);
    expect(defaultIconFor('birthday')).toEqual({ kind: 'lucide', name: 'cake' });
    expect(defaultIconFor('important')).toEqual({ kind: 'lucide', name: 'star' });
    expect(defaultIconFor('event')).toBeNull();
  });

  it('compte à rebours activé d’office pour un anniversaire et une date importante (critère 6, E-04 D2)', () => {
    expect(defaultCountdown('birthday')).toBe(true);
    expect(defaultCountdown('important')).toBe(true);
    expect(defaultCountdown('event')).toBe(false);
  });

  it('âge calculé sur l’année de l’occurrence ; rien sans année de naissance (critères 2 à 4, D3)', () => {
    const karim = makeEvent({ kind: 'birthday', repeat: 'yearly', startDate: '1992-09-25', birthYear: 1992 });
    expect(ageAtOccurrence(karim, d('2026-09-25'))).toBe(34);
    expect(ageAtOccurrence(karim, d('2027-09-25'))).toBe(35);
    expect(ageAtOccurrence(karim, d('1992-09-25'))).toBe(0);
    expect(ageAtOccurrence(karim, d('1991-09-25'))).toBeNull();
    expect(ageAtOccurrence(makeEvent({ kind: 'birthday', birthYear: null }), d('2026-09-25'))).toBeNull();
    // Date importante : années écoulées (10 ans de mariage).
    expect(ageAtOccurrence(makeEvent({ kind: 'important', birthYear: 2016 }), d('2026-06-01'))).toBe(10);
    // Un événement ordinaire n’affiche jamais d’âge.
    expect(ageAtOccurrence(makeEvent({ kind: 'event', birthYear: 1992 }), d('2026-09-25'))).toBeNull();
  });

  it('année de naissance : entier de 1900 à aujourd’hui, jamais future (critère 4)', () => {
    expect(checkBirthYear(null, 2026)).toBeNull();
    expect(checkBirthYear(1992, 2026)).toBeNull();
    expect(checkBirthYear(2026, 2026)).toBeNull();
    expect(checkBirthYear(2027, 2026)).toBe('birth-year-future');
    expect(checkBirthYear(1899, 2026)).toBe('birth-year-invalid');
    expect(checkBirthYear(1992.5, 2026)).toBe('birth-year-invalid');
    expect(checkBirthYear(2027, null)).toBeNull();
  });

  it('date de début stockée : année de naissance, sinon année en cours ; le 29 févr. est conservé ou ramené au 28 (critère 5)', () => {
    expect(annualStartDate(9, 25, 1992, 2026)).toBe('1992-09-25');
    expect(annualStartDate(9, 25, null, 2026)).toBe('2026-09-25');
    expect(annualStartDate(2, 29, 1992, 2026)).toBe('1992-02-29');
    expect(annualStartDate(2, 29, 1993, 2026)).toBe('1993-02-28');
    expect(annualStartDate(2, 29, null, 2026)).toBe('2024-02-29');
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
  });

  it('prochaine date d’un jour et d’un mois', () => {
    expect(nextAnnualDate(9, 25, d('2026-09-25'))).toBe('2026-09-25');
    expect(nextAnnualDate(9, 25, d('2026-09-26'))).toBe('2027-09-25');
    expect(nextAnnualDate(2, 29, d('2026-03-01'))).toBe('2027-02-28');
  });

  it('changer de type garde titre, espace et icône choisie ; l’icône par défaut suit le type (critère 7)', () => {
    const custom = fieldsOf({ title: 'Karim', icon: { kind: 'lucide', name: 'heart' } });
    const birthday = applyKind(custom, 'birthday');
    expect(birthday).toMatchObject({ title: 'Karim', spaceId: custom.spaceId, icon: { name: 'heart' }, kind: 'birthday', repeat: 'yearly', allDay: true });
    const bare = applyKind(fieldsOf({ title: 'Karim' }), 'birthday');
    expect(bare.icon).toEqual({ kind: 'lucide', name: 'cake' });
    expect(applyKind(bare, 'important').icon).toEqual({ kind: 'lucide', name: 'star' });
    expect(applyKind(bare, 'event')).toMatchObject({ icon: null, birthYear: null, kind: 'event' });
  });

  it('un anniversaire est normalisé annuel, journée entière, sans heure ; l’année future est refusée', () => {
    const base = fieldsOf({ kind: 'birthday', repeat: 'once', allDay: false, startTime: tm('10:00'), endTime: tm('11:00'), startDate: '1992-09-25', birthYear: 1992 });
    expect(validateEvent(base, { today: d('2026-10-04') })).toMatchObject({ ok: true, value: { repeat: 'yearly', allDay: true, startTime: null, endTime: null, endDate: '1992-09-25', birthYear: 1992 } });
    expect(validateEvent({ ...base, birthYear: 2030 }, { today: d('2026-10-04') })).toEqual({ ok: false, error: 'birth-year-future' });
    expect(validateEvent({ ...base, birthYear: 1800 }, { today: d('2026-10-04') })).toEqual({ ok: false, error: 'birth-year-invalid' });
    expect(validateEvent({ ...base, birthYear: null }, { today: d('2026-10-04') })).toMatchObject({ ok: true, value: { birthYear: null } });
  });

  it('un événement ordinaire n’a pas d’année de naissance', () => {
    expect(validateEvent(fieldsOf({ kind: 'event', birthYear: 1992 }), { today: d('2026-10-04') })).toMatchObject({ ok: true, value: { birthYear: null } });
  });
});
