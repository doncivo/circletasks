import { describe, expect, it } from 'vitest';
import { localToUtcMs } from './timeZone';
import type { LocalDate } from './types';

describe('localToUtcMs', () => {
  const at = (date: string, time: string, tz: string): string => new Date(localToUtcMs(date as LocalDate, time, tz)).toISOString();

  it('heure d’été et d’hiver de Paris, UTC fixe, fuseau à l’ouest', () => {
    expect(at('2026-09-24', '19:00', 'Europe/Paris')).toBe('2026-09-24T17:00:00.000Z');
    expect(at('2026-12-24', '19:00', 'Europe/Paris')).toBe('2026-12-24T18:00:00.000Z');
    expect(at('2026-09-24', '19:00:30', 'UTC')).toBe('2026-09-24T19:00:30.000Z');
    expect(at('2026-01-15', '08:00', 'America/New_York')).toBe('2026-01-15T13:00:00.000Z');
  });

  it('passage à l’heure d’été : l’heure inexistante est décalée vers l’avant', () => {
    expect(at('2026-03-29', '02:30', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z');
    expect(at('2026-03-29', '03:30', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('fuseau invalide : RangeError', () => {
    expect(() => localToUtcMs('2026-09-24' as LocalDate, '10:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});
