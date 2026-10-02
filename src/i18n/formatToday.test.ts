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
