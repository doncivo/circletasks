import { afterEach, describe, expect, it } from 'vitest';
import { parseTimeInput } from '../domain/dateInput';
import { formatTime, formatTimeRange, weekdayInitials, weekdayNamesLong } from './format';
import { setFormatPrefs } from './formatPrefs';

afterEach(() => setFormatPrefs({ firstWeekday: 'monday', timeFormat: '24h' }));

describe('P-03 QA : préférences d’affichage', () => {
  it('initiales et noms de jours décalés selon le premier jour (critère 2)', () => {
    expect(weekdayInitials().join(' ')).toBe('L M M J V S D');
    setFormatPrefs({ firstWeekday: 'sunday' });
    expect(weekdayInitials().join(' ')).toBe('D L M M J V S');
    expect(weekdayNamesLong()[0]).toBe('dimanche');
    setFormatPrefs({ firstWeekday: 'saturday' });
    expect(weekdayInitials().join(' ')).toBe('S D L M M J V');
  });

  it('le formateur i18n suit le format choisi, à chaud ; minuit et midi (critères 6 et 8)', () => {
    expect(formatTime('00:00')).toBe('00:00');
    setFormatPrefs({ timeFormat: '12h' });
    expect(formatTime('00:00')).toBe('12:00 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('09:00')).toBe('9:00 AM');
    expect(formatTimeRange('09:00', '15:30')).toBe('9:00 AM – 3:30 PM');
    setFormatPrefs({ timeFormat: '24h' });
    expect(formatTime('15:30')).toBe('15:30');
  });

  it('saisie libre acceptée dans les deux formes, minuit et midi compris (critère 6)', () => {
    const v = (s: string) => {
      const r = parseTimeInput(s);
      return r.ok ? r.value : 'ERR';
    };
    expect(v('15h30')).toBe('15:30');
    expect(v('3:30 pm')).toBe('15:30');
    expect(v('3:30 PM')).toBe('15:30');
    expect(v('9 am')).toBe('09:00');
    expect(v('12:00 AM')).toBe('00:00');
    expect(v('12:00 PM')).toBe('12:00');
    expect(v('12am')).toBe('00:00');
    expect(v('12pm')).toBe('12:00');
    expect(v('0:30 am')).toBe('ERR');
    expect(v('13 pm')).toBe('ERR');
    expect(v('3:75 pm')).toBe('ERR');
  });
});
