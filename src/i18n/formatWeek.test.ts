import { afterEach, describe, expect, it } from 'vitest';
import { formatWeekDayHeader, formatWeekRange } from './format';
import { setLocale } from './index';

afterEach(() => setLocale('fr'));

describe('formatWeekRange (S-01 critère 2, S-03 critère 5)', () => {
  it('PC : « 21 – 27 septembre 2026 »', () => {
    expect(formatWeekRange('2026-09-21', '2026-09-27', 'long')).toBe('21 – 27 septembre 2026');
  });

  it('iPhone : « 21 – 27 sept. »', () => {
    expect(formatWeekRange('2026-09-21', '2026-09-27', 'short')).toBe('21 – 27 sept.');
  });

  it('à cheval sur deux mois : « 28 sept. – 4 oct. » (iPhone) et « 28 septembre – 4 octobre 2026 » (PC)', () => {
    expect(formatWeekRange('2026-09-28', '2026-10-04', 'short')).toBe('28 sept. – 4 oct.');
    expect(formatWeekRange('2026-09-28', '2026-10-04', 'long')).toBe('28 septembre – 4 octobre 2026');
  });

  it('passage d’année : « 28 déc. – 3 janv. » (iPhone), années affichées sur PC', () => {
    expect(formatWeekRange('2026-12-28', '2027-01-03', 'short')).toBe('28 déc. – 3 janv.');
    expect(formatWeekRange('2026-12-28', '2027-01-03', 'long')).toBe('28 décembre 2026 – 3 janvier 2027');
  });
});

describe('formatWeekDayHeader', () => {
  it('« LUN. » et « 21 »', () => {
    expect(formatWeekDayHeader('2026-09-21')).toEqual({ weekday: 'LUN.', day: '21' });
    expect(formatWeekDayHeader('2026-09-27')).toEqual({ weekday: 'DIM.', day: '27' });
  });
});
