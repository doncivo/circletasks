import { describe, expect, it } from 'vitest';
import { createManualClock, nowIso, nowLocalTime, systemClock, todayLocal } from './clock';

describe('Clock', () => {
  it("l'horloge système suit Date.now", () => {
    const before = Date.now();
    const now = systemClock.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("l'horloge manuelle se fixe et avance", () => {
    const clock = createManualClock('2026-10-01T08:00:00.000Z');
    expect(nowIso(clock)).toBe('2026-10-01T08:00:00.000Z');
    clock.advance(90_000);
    expect(nowIso(clock)).toBe('2026-10-01T08:01:30.000Z');
    clock.set(Date.UTC(2027, 0, 1));
    expect(nowIso(clock)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuse un instant invalide', () => {
    expect(() => createManualClock('pas une date')).toThrow(TypeError);
  });

  it('donne la date et l’heure locales au format attendu', () => {
    const local = new Date(2026, 2, 5, 7, 4); // 5 mars 2026, 07:04 heure locale
    const clock = createManualClock(local.getTime());
    expect(todayLocal(clock)).toBe('2026-03-05');
    expect(nowLocalTime(clock)).toBe('07:04');
  });
});
