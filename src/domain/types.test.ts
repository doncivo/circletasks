import { describe, expect, it } from 'vitest';
import {
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
});
