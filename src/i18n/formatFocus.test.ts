import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './index';
import { formatFocusDuration, formatFocusSessions, formatFocusToday } from './formatFocus';

afterEach(() => setLocale('fr'));

describe('formatFocusDuration (F-03 critère 6)', () => {
  it.each([
    [0, '0 min'],
    [45, '45 min'],
    [59, '59 min'],
    [60, '1 h'],
    [75, '1 h 15'],
    [125, '2 h 05'],
    [150, '2 h 30'],
    [860, '14 h 20'],
    [1440, '24 h'],
    [1500, '25 h'],
    [-4, '0 min'],
    [44.6, '45 min'],
  ])('%d min -> %s', (minutes, text) => {
    expect(formatFocusDuration(minutes)).toBe(text);
  });
});

describe('pied de l’écran Focus (F-03 critères 1 et 2)', () => {
  it('trois sessions de 45 + 20 + 10 min', () => {
    expect(formatFocusToday(75, 3)).toBe('Aujourd’hui : 1 h 15 de concentration · 3 sessions');
  });
  it('une seule session', () => {
    expect(formatFocusToday(25, 1)).toBe('Aujourd’hui : 25 min de concentration · 1 session');
    expect(formatFocusSessions(1)).toBe('1 session');
  });
  it('aucune session : 0 min de concentration', () => {
    expect(formatFocusToday(0, 0)).toBe('Aujourd’hui : 0 min de concentration');
  });
  it('en anglais aussi', () => {
    setLocale('en');
    expect(formatFocusToday(75, 3)).toBe('Today: 1 h 15 of focus · 3 sessions');
  });
});
