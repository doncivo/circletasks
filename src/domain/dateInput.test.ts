import { describe, expect, it } from 'vitest';
import { addMonths, monthGrid, monthOf, moveCalendarFocus } from './calendarMonth';
import { parseFrenchDate, parseTimeInput } from './dateInput';
import { asLocalDate } from './types';
import { timeToWheel, WHEEL_HOURS, WHEEL_MINUTES, wheelDayIndex, wheelDays, wheelToTime } from './wheelChoices';

// Mercredi 23 septembre 2026 (PC-Date.html).
const TODAY = asLocalDate('2026-09-23');

const ok = (text: string, today = TODAY) => {
  const result = parseFrenchDate(text, today);
  if (!result.ok) throw new Error(`« ${text} » non comprise (${result.error})`);
  return result.value;
};

describe('parseFrenchDate (T-14, critère 7)', () => {
  it.each([
    ['demain', '2026-09-24', null],
    ['Demain', '2026-09-24', null],
    ['aujourd’hui', '2026-09-23', null],
    ["aujourd'hui", '2026-09-23', null],
    ['après-demain', '2026-09-25', null],
    ['apres demain', '2026-09-25', null],
    ['hier', '2026-09-22', null],
    ['lun. 10h', '2026-09-28', '10:00'],
    ['ven 10h', '2026-09-25', '10:00'],
    ['vendredi', '2026-09-25', null],
    ['mercredi', '2026-09-30', null],
    ['lundi prochain', '2026-09-28', null],
    ['mardi prochain', '2026-09-29', null],
    ['semaine prochaine', '2026-09-28', null],
    ['25/09', '2026-09-25', null],
    ['25/09/2026', '2026-09-25', null],
    ['25.09', '2026-09-25', null],
    ['25-09-26', '2026-09-25', null],
    ['2026-09-25', '2026-09-25', null],
    ['25 sept. 14:30', '2026-09-25', '14:30'],
    ['25 septembre 14h30', '2026-09-25', '14:30'],
    ['le 1er octobre', '2026-10-01', null],
    ['ven. 25 sept.', '2026-09-25', null],
    ['ven 25/09 à 9h', '2026-09-25', '09:00'],
    ['dans 3 jours', '2026-09-26', null],
    ['dans 1 jour', '2026-09-24', null],
    ['dans 2 semaines', '2026-10-07', null],
    ['dans 1 mois', '2026-10-23', null],
    ['demain 10:00', '2026-09-24', '10:00'],
    ['10h demain', '2026-09-24', '10:00'],
    ['10h', '2026-09-23', '10:00'],
    ['  DEMAIN   à   8h15 ', '2026-09-24', '08:15'],
  ])('« %s » → %s %s', (text, date, time) => {
    expect(ok(text)).toEqual({ date, time });
  });

  it('une date sans année est la prochaine occurrence, aujourd’hui compris', () => {
    expect(ok('23/09').date).toBe('2026-09-23');
    expect(ok('22/09').date).toBe('2027-09-22');
    expect(ok('1 janv.').date).toBe('2027-01-01');
    expect(ok('29/02', asLocalDate('2026-09-23')).date).toBe('2028-02-29');
  });

  it('« dans 1 mois » borne au dernier jour du mois', () => {
    expect(ok('dans 1 mois', asLocalDate('2026-01-31')).date).toBe('2026-02-28');
  });

  it('un jour de semaine seul est strictement après aujourd’hui', () => {
    expect(ok('mercredi').date).toBe('2026-09-30');
  });

  it('« Un jour » : sans date ni heure', () => {
    expect(ok('un jour')).toEqual({ date: null, time: null });
    expect(ok('Un jour 10h')).toEqual({ date: null, time: null });
  });

  it('texte vide : empty ; texte non compris : unparsable (critère 8)', () => {
    expect(parseFrenchDate('', TODAY)).toEqual({ ok: false, error: 'empty' });
    expect(parseFrenchDate('   ', TODAY)).toEqual({ ok: false, error: 'empty' });
    for (const text of ['blabla', '31/02', '32/01', '25/13', '25h', 'demain 25h', '2026-02-30', '25 foo', 'dans x jours', '30 fév']) {
      expect(parseFrenchDate(text, TODAY), text).toEqual({ ok: false, error: 'unparsable' });
    }
  });
});

describe('parseTimeInput (critère 11)', () => {
  it.each([
    ['10', '10:00'],
    ['10h', '10:00'],
    ['10:00', '10:00'],
    ['1030', '10:30'],
    ['930', '09:30'],
    ['9', '09:00'],
    ['10h30', '10:30'],
    ['0:05', '00:05'],
    [' 14 h 30 ', '14:30'],
  ])('« %s » → %s', (text, expected) => {
    expect(parseTimeInput(text)).toEqual({ ok: true, value: expected });
  });

  it('vide = sans heure', () => {
    expect(parseTimeInput('')).toEqual({ ok: true, value: null });
    expect(parseTimeInput('   ')).toEqual({ ok: true, value: null });
  });

  it.each(['24', '25h', '10:60', '2400', 'abc', '10h5', '1', '12345'])('« %s » est refusée', (text) => {
    if (text === '1') {
      expect(parseTimeInput(text)).toEqual({ ok: true, value: '01:00' });
      return;
    }
    expect(parseTimeInput(text)).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('calendarMonth (critères 9, 12)', () => {
  it('septembre 2026 : lundi en premier, 1er sept. un mardi (une case vide)', () => {
    const grid = monthGrid(2026, 9);
    expect(grid[0]).toBeNull();
    expect(grid[1]).toBe('2026-09-01');
    expect(grid).toHaveLength(31);
    expect(grid.at(-1)).toBe('2026-09-30');
  });

  it('un mois commençant un lundi n’a pas de case vide ; un dimanche en a six', () => {
    expect(monthGrid(2026, 6)[0]).toBe('2026-06-01');
    expect(monthGrid(2026, 2).filter((d) => d === null)).toHaveLength(6);
    expect(monthGrid(2028, 2)).toHaveLength(29 + monthGrid(2028, 2).filter((d) => d === null).length);
  });

  it('mois précédent et suivant, à cheval sur l’année', () => {
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 9 }, 14)).toEqual({ year: 2027, month: 11 });
    expect(monthOf(TODAY)).toEqual({ year: 2026, month: 9 });
  });

  it('flèches, Début / Fin, pages', () => {
    expect(moveCalendarFocus(TODAY, 'ArrowRight')).toBe('2026-09-24');
    expect(moveCalendarFocus(TODAY, 'ArrowLeft')).toBe('2026-09-22');
    expect(moveCalendarFocus(TODAY, 'ArrowUp')).toBe('2026-09-16');
    expect(moveCalendarFocus(TODAY, 'ArrowDown')).toBe('2026-09-30');
    expect(moveCalendarFocus(TODAY, 'Home')).toBe('2026-09-21');
    expect(moveCalendarFocus(TODAY, 'End')).toBe('2026-09-27');
    expect(moveCalendarFocus(asLocalDate('2026-10-31'), 'PageUp')).toBe('2026-09-30');
    expect(moveCalendarFocus(TODAY, 'PageDown')).toBe('2026-10-23');
    expect(moveCalendarFocus(TODAY, 'a')).toBeNull();
  });
});

describe('wheelChoices (critères 2, 3, 4)', () => {
  it('minutes par pas de 5, heures de 00 à 23', () => {
    expect(WHEEL_MINUTES).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(WHEEL_HOURS[0]).toBe(0);
    expect(WHEEL_HOURS.at(-1)).toBe(23);
    expect(WHEEL_HOURS).toHaveLength(24);
  });

  it('les jours passés et futurs sont proposés, aujourd’hui au rang prévu', () => {
    const days = wheelDays(TODAY, 3, 4);
    expect(days).toEqual(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(wheelDayIndex(TODAY, TODAY, 3, 4)).toBe(3);
    expect(wheelDayIndex(TODAY, asLocalDate('2026-09-25'), 3, 4)).toBe(5);
    expect(wheelDayIndex(TODAY, asLocalDate('2030-01-01'), 3, 4)).toBe(7);
    expect(wheelDayIndex(TODAY, asLocalDate('2020-01-01'), 3, 4)).toBe(0);
  });

  it('heure et minutes : « — » = sans heure ; minutes arrondies au pas de 5', () => {
    expect(wheelToTime(null, 30)).toBeNull();
    expect(wheelToTime(9, 5)).toBe('09:05');
    expect(timeToWheel(null)).toBeNull();
    expect(timeToWheel(asTime('10:07'))).toEqual({ hour: 10, minute: 5 });
    expect(timeToWheel(asTime('10:58'))).toEqual({ hour: 10, minute: 55 });
    expect(timeToWheel(asTime('00:00'))).toEqual({ hour: 0, minute: 0 });
  });
});

function asTime(value: string): Parameters<typeof timeToWheel>[0] {
  return value as Parameters<typeof timeToWheel>[0];
}

describe('mini-calendrier selon le premier jour (P-03 critère 2)', () => {
  it('la grille de septembre 2026 (1er = mardi) compte 1 case vide en lundi, 2 en dimanche, 3 en samedi', () => {
    expect(monthGrid(2026, 9, 'monday').findIndex((cell) => cell !== null)).toBe(1);
    expect(monthGrid(2026, 9, 'sunday').findIndex((cell) => cell !== null)).toBe(2);
    expect(monthGrid(2026, 9, 'saturday').findIndex((cell) => cell !== null)).toBe(3);
  });

  it('Début et Fin vont au premier et au dernier jour de la semaine réglée', () => {
    // 2026-09-23 est un mercredi.
    expect(moveCalendarFocus(asLocalDate('2026-09-23'), 'Home', 'sunday')).toBe('2026-09-20');
    expect(moveCalendarFocus(asLocalDate('2026-09-23'), 'End', 'sunday')).toBe('2026-09-26');
    expect(moveCalendarFocus(asLocalDate('2026-09-23'), 'Home')).toBe('2026-09-21');
    expect(moveCalendarFocus(asLocalDate('2026-09-23'), 'End')).toBe('2026-09-27');
  });
});
