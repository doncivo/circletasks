import { describe, expect, it } from 'vitest';
import { parseTimeInput } from './dateInput';
import { formatTime, formatTimeRange, hour12To24, hourColumnLabel, spokenTime } from './timeFormat';

describe('formatTime (P-03 critères 5 et 6)', () => {
  it('24 h par défaut : « 09:00 », « 15:30 »', () => {
    expect(formatTime('09:00')).toBe('09:00');
    expect(formatTime('15:30', '24h')).toBe('15:30');
  });

  it('12 h : « 9:00 AM », « 3:30 PM », minuit et midi', () => {
    expect(formatTime('09:00', '12h')).toBe('9:00 AM');
    expect(formatTime('15:30', '12h')).toBe('3:30 PM');
    expect(formatTime('00:05', '12h')).toBe('12:05 AM');
    expect(formatTime('12:00', '12h')).toBe('12:00 PM');
    expect(formatTime('23:59', '12h')).toBe('11:59 PM');
  });

  it('rend tel quel un texte qui n’est pas une heure', () => {
    expect(formatTime('bientôt', '12h')).toBe('bientôt');
    expect(formatTime('25:00', '12h')).toBe('25:00');
  });

  it('formate une plage, ou la seule heure de début', () => {
    expect(formatTimeRange('10:00', '11:30', '12h')).toBe('10:00 AM – 11:30 AM');
    expect(formatTimeRange('10:00', '10:00')).toBe('10:00');
    expect(formatTimeRange('10:00', null)).toBe('10:00');
  });

  it('lit l’heure en langage naturel, quel que soit le format (critère 11)', () => {
    expect(spokenTime('15:30')).toBe('quinze heures trente');
    expect(spokenTime('09:00')).toBe('neuf heures');
    expect(spokenTime('01:21')).toBe('une heure vingt et un');
    expect(spokenTime('00:45')).toBe('zéro heure quarante-cinq');
  });

  it('colonne des heures des roues', () => {
    expect(hourColumnLabel(0, '24h')).toBe('00');
    expect(hourColumnLabel(0, '12h')).toBe('12');
    expect(hourColumnLabel(11, '12h')).toBe('11');
    expect(hour12To24(12, false)).toBe(0);
    expect(hour12To24(12, true)).toBe(12);
    expect(hour12To24(3, true)).toBe(15);
  });
});

describe('parseTimeInput : les deux formes restent acceptées (critère 6)', () => {
  it.each([
    ['15h30', '15:30'],
    ['3:30 PM', '15:30'],
    ['3:30pm', '15:30'],
    ['3pm', '15:00'],
    ['9 am', '09:00'],
    ['12:15 AM', '00:15'],
    ['12 PM', '12:00'],
    ['09:00', '09:00'],
  ])('« %s » donne %s', (text, expected) => {
    expect(parseTimeInput(text)).toEqual({ ok: true, value: expected });
  });

  it('refuse une heure de 12 h hors plage', () => {
    expect(parseTimeInput('13 pm').ok).toBe(false);
    expect(parseTimeInput('0 am').ok).toBe(false);
    expect(parseTimeInput('3:75 pm').ok).toBe(false);
  });
});
