import { describe, expect, it } from 'vitest';
import { newEntityId } from './id';
import {
  asEntityId,
  asHexColor,
  asLocalDateTime,
  isHexColor,
  isLocalDateTime,
  isWeekday,
  type TaskId,
  asDeviceId,
  asId,
  asIsoDateTime,
  asLocalDate,
  asLocalTime,
  asSpaceId,
  isId,
  isIsoDateTime,
  isLocalDate,
  isLocalTime,
} from './types';

describe('types de base', () => {
  it('reconnaît un UUID canonique en minuscules', () => {
    expect(isId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isId('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe(false);
    expect(isId('pas-un-uuid')).toBe(false);
  });

  it('valide les dates locales, années bissextiles comprises', () => {
    expect(isLocalDate('2026-10-01')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-00-10')).toBe(false);
    expect(isLocalDate('2026-04-00')).toBe(false);
    expect(isLocalDate('2026-4-1')).toBe(false);
  });

  it('valide les heures flottantes 24 h', () => {
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('9:30')).toBe(false);
    expect(isLocalTime('09:60')).toBe(false);
  });

  it('valide les instants ISO UTC', () => {
    expect(isIsoDateTime('2026-10-01T21:30:00.000Z')).toBe(true);
    expect(isIsoDateTime('2026-10-01T21:30:00Z')).toBe(false);
    expect(isIsoDateTime('2026-13-01T21:30:00.000Z')).toBe(false);
  });

  it('les constructeurs lèvent une erreur sur une valeur invalide', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(asId(uuid)).toBe(uuid);
    expect(asSpaceId(uuid)).toBe(uuid);
    expect(asDeviceId(uuid)).toBe(uuid);
    expect(asLocalDate('2026-10-01')).toBe('2026-10-01');
    expect(asLocalTime('08:15')).toBe('08:15');
    expect(asIsoDateTime('2026-10-01T21:30:00.000Z')).toBe('2026-10-01T21:30:00.000Z');
    expect(() => asId('x')).toThrow(TypeError);
    expect(() => asLocalDate('2026-02-30')).toThrow(TypeError);
    expect(() => asLocalTime('25:00')).toThrow(TypeError);
  });

  it('valide date-heure locale flottante, couleur, jour de semaine', () => {
    expect(isLocalDateTime('2026-10-01T09:30')).toBe(true);
    expect(isLocalDateTime('2026-10-01')).toBe(false);
    expect(isLocalDateTime('2026-10-01T09:30:00')).toBe(false);
    expect(isLocalDateTime('2026-10-01T09:30T10:00')).toBe(false);
    expect(asLocalDateTime('2026-10-01T23:59')).toBe('2026-10-01T23:59');
    expect(() => asLocalDateTime('2026-02-30T10:00')).toThrow(TypeError);
    expect(isHexColor('#2f6b7a')).toBe(true);
    expect(isHexColor('#2F6B7A')).toBe(false);
    expect(asHexColor('#b5483b')).toBe('#b5483b');
    expect(isWeekday(1)).toBe(true);
    expect(isWeekday(7)).toBe(true);
    expect(isWeekday(0)).toBe(false);
    expect(isWeekday(1.5)).toBe(false);
  });

  it('construit des identifiants typés', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(asEntityId<TaskId>(uuid)).toBe(uuid);
    expect(() => asEntityId<TaskId>('x')).toThrow(TypeError);
    expect(newEntityId<TaskId>({ next: () => asId(uuid) })).toBe(uuid);
  });
});
