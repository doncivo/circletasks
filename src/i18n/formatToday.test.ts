import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './index';
import { formatTodayHeader, formatWeekdayName } from './format';

afterEach(() => setLocale('fr'));

describe('formatTodayHeader (A-01 critère 2)', () => {
  it('iPhone : « sept. 2026 » et « 23 mer. »', () => {
    expect(formatTodayHeader('2026-09-23', 'short')).toEqual({ monthLine: 'sept. 2026', dayLine: '23 mer.' });
  });

  it('PC : « septembre 2026 » et « 23 mercredi »', () => {
    expect(formatTodayHeader('2026-09-23', 'long')).toEqual({ monthLine: 'septembre 2026', dayLine: '23 mercredi' });
  });

  it('un autre jour (flèches PC) : « 24 jeudi »', () => {
    expect(formatTodayHeader('2026-09-24', 'long').dayLine).toBe('24 jeudi');
  });

  it('nom du jour pour l’état vide', () => {
    expect(formatWeekdayName('2026-09-27')).toBe('dimanche');
  });
});

describe('formatDetailDate et formatStamp (A-08 critère 5)', () => {
  it('date de la fiche : « Mer. 23 sept. 2026 »', async () => {
    const { formatDetailDate } = await import('./format');
    expect(formatDetailDate('2026-09-23')).toBe('Mer. 23 sept. 2026');
  });

  it('horodatage relatif en français, heures en 24 h', async () => {
    const { formatStamp } = await import('./format');
    const now = new Date(2026, 8, 23, 20, 0).getTime();
    expect(formatStamp(new Date(2026, 8, 23, 18, 4).toISOString(), now)).toBe('aujourd’hui à 18:04');
    expect(formatStamp(new Date(2026, 8, 22, 18, 4).toISOString(), now)).toBe('hier à 18:04');
    expect(formatStamp(new Date(2026, 8, 2, 9, 5).toISOString(), now)).toBe('le 2 sept. à 09:05');
    expect(formatStamp(new Date(2025, 11, 31, 9, 5).toISOString(), now)).toBe('le 31 déc. 2025 à 09:05');
  });
});
