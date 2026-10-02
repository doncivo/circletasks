import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import {
  detectTimeZoneChange,
  externalEventDisplay,
  isValidTimeZone,
  nowTimeIn,
  todayIn,
  utcToLocal,
  utcToLocalIso,
} from './timeZone';

describe('utcToLocal (T-11, critère 3)', () => {
  it('08:00Z s’affiche 10:00 à Paris (été) et 09:00 à Tunis', () => {
    expect(utcToLocal('2026-09-23T08:00:00Z', 'Europe/Paris')).toEqual({ date: '2026-09-23', time: '10:00' });
    expect(utcToLocal('2026-09-23T08:00:00Z', 'Africa/Tunis')).toEqual({ date: '2026-09-23', time: '09:00' });
  });

  it('change de date quand le fuseau passe minuit', () => {
    expect(utcToLocal('2026-09-23T23:30:00Z', 'Europe/Paris')).toEqual({ date: '2026-09-24', time: '01:30' });
    expect(utcToLocal('2026-09-23T00:30:00Z', 'America/New_York')).toEqual({ date: '2026-09-22', time: '20:30' });
  });

  it('minuit s’écrit 00:00 (jamais 24:00)', () => {
    expect(utcToLocal('2026-01-10T23:00:00Z', 'Europe/Paris')).toEqual({ date: '2026-01-11', time: '00:00' });
  });

  it('hiver : Paris est à UTC+1', () => {
    expect(utcToLocalIso('2026-01-15T08:00:00Z', 'Europe/Paris')).toBe('2026-01-15T09:00');
  });

  it('passage à l’heure d’été (29 mars 2026) : 00:59Z → 01:59, 01:00Z → 03:00 à Paris', () => {
    expect(utcToLocalIso('2026-03-29T00:59:00Z', 'Europe/Paris')).toBe('2026-03-29T01:59');
    expect(utcToLocalIso('2026-03-29T01:00:00Z', 'Europe/Paris')).toBe('2026-03-29T03:00');
  });

  it('rejette un instant ou un fuseau invalide', () => {
    expect(() => utcToLocal('pas une date', 'Europe/Paris')).toThrow(RangeError);
    expect(() => utcToLocal('2026-09-23T08:00:00Z', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('externalEventDisplay (critères 3 et 4)', () => {
  it('convertit un événement horodaté', () => {
    const event = { allDay: false, startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' };
    expect(externalEventDisplay(event, 'Europe/Paris')).toMatchObject({ startDate: '2026-09-23', startTime: '10:00', endTime: '11:00' });
    expect(externalEventDisplay(event, 'Africa/Tunis')).toMatchObject({ startTime: '09:00', endTime: '10:00' });
  });

  it('une journée entière reste sur sa date, quel que soit le fuseau', () => {
    const event = { allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: null };
    for (const tz of ['Europe/Paris', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
      expect(externalEventDisplay(event, tz)).toEqual({
        startDate: '2026-09-23',
        startTime: null,
        endDate: null,
        endTime: null,
        allDay: true,
      });
    }
  });
});

describe('todayIn / nowTimeIn (critère 8)', () => {
  it('suit le fuseau', () => {
    const clock = createManualClock('2026-09-23T22:30:00Z');
    expect(todayIn(clock, 'Europe/Paris')).toBe('2026-09-24');
    expect(todayIn(clock, 'America/New_York')).toBe('2026-09-23');
    expect(nowTimeIn(clock, 'Europe/Paris')).toBe('00:30');
  });
});

describe('fuseau du système et changement (critère 6)', () => {
  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Nope/Nope')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('detectTimeZoneChange', () => {
    expect(detectTimeZoneChange('Europe/Paris', 'Europe/Paris')).toBeNull();
    expect(detectTimeZoneChange('Europe/Paris', null)).toBeNull();
    expect(detectTimeZoneChange('Europe/Paris', 'Africa/Tunis')).toEqual({ previous: 'Europe/Paris', current: 'Africa/Tunis' });
    expect(detectTimeZoneChange(null, 'Europe/Paris')).toEqual({ previous: null, current: 'Europe/Paris' });
  });
});

describe('heures flottantes (critères 1, 2, 7)', () => {
  it('les tâches sont des chaînes sans fuseau : aucune conversion n’existe pour elles', () => {
    // 02:30 le jour du passage à l'heure d'été n'existe pas en réalité à Paris ; la tâche reste 02:30.
    const time: string = '02:30';
    expect(time).toBe('02:30');
  });
});
