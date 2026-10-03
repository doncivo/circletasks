import { describe, expect, it } from 'vitest';
import type { QuietHours } from './model';
import {
  DEFAULT_PRO_QUIET_HOURS,
  allDayRange,
  describeQuietHours,
  effectiveFireAt,
  isAllDayRange,
  validateQuietHours,
  validateQuietRange,
} from './quietHours';
import { asLocalDateTime, type LocalTime, type Weekday } from './types';

const at = (value: string) => asLocalDateTime(value);
const range = (weekdays: Weekday[], from: string, to: string): QuietHours => ({ weekdays, from: from as LocalTime, to: to as LocalTime });
const PRO = DEFAULT_PRO_QUIET_HOURS;

describe('plages par défaut de Pro (ES-07 critère 1)', () => {
  it('chaque soir 19:00 → 08:00 et le week-end en entier', () => {
    expect(PRO).toEqual([
      { weekdays: [1, 2, 3, 4, 5, 6, 7], from: '19:00', to: '08:00' },
      { weekdays: [6, 7], from: '00:00', to: '00:00' },
    ]);
    expect(validateQuietHours(PRO)).toMatchObject({ ok: true });
  });
});

describe('échéance effective d’un rappel (ES-07 critère 5)', () => {
  // Septembre 2026 : lun. 21, mar. 22, mer. 23, jeu. 24, ven. 25, sam. 26, dim. 27, lun. 28.
  it('Pro : mardi 20:00 → mercredi 08:00', () => expect(effectiveFireAt(at('2026-09-22T20:00'), PRO)).toBe('2026-09-23T08:00'));
  it('Pro : samedi 10:00 → lundi 08:00', () => expect(effectiveFireAt(at('2026-09-26T10:00'), PRO)).toBe('2026-09-28T08:00'));
  it('Pro : mardi 12:00 inchangé', () => expect(effectiveFireAt(at('2026-09-22T12:00'), PRO)).toBe('2026-09-22T12:00'));
  it('Perso (aucune plage) : mardi 20:00 inchangé', () => expect(effectiveFireAt(at('2026-09-22T20:00'), [])).toBe('2026-09-22T20:00'));

  it('bornes : 19:00 est silencieux (début inclus), 08:00 ne l’est plus (fin exclue), 18:59 est libre', () => {
    expect(effectiveFireAt(at('2026-09-22T18:59'), PRO)).toBe('2026-09-22T18:59');
    expect(effectiveFireAt(at('2026-09-22T19:00'), PRO)).toBe('2026-09-23T08:00');
    expect(effectiveFireAt(at('2026-09-23T07:59'), PRO)).toBe('2026-09-23T08:00');
    expect(effectiveFireAt(at('2026-09-23T08:00'), PRO)).toBe('2026-09-23T08:00');
  });

  it('traverse minuit : 00:30 le mercredi (plage du mardi soir) → 08:00 le mercredi', () => {
    expect(effectiveFireAt(at('2026-09-23T00:30'), PRO)).toBe('2026-09-23T08:00');
  });

  it('vendredi 19:00 → lundi 08:00 : soir, samedi, dimanche et dimanche soir forment une seule plage continue (critère 6)', () => {
    expect(effectiveFireAt(at('2026-09-25T19:00'), PRO)).toBe('2026-09-28T08:00');
    expect(effectiveFireAt(at('2026-09-27T23:00'), PRO)).toBe('2026-09-28T08:00');
    expect(effectiveFireAt(at('2026-09-28T07:59'), PRO)).toBe('2026-09-28T08:00');
  });

  it('plages qui se chevauchent ou s’enchaînent : fin de la dernière plage continue (critère 6)', () => {
    const overlapping = [range([1, 2, 3, 4, 5], '19:00', '08:00'), range([1, 2, 3, 4, 5], '07:00', '09:30'), range([1, 2, 3, 4, 5], '09:30', '10:00')];
    expect(effectiveFireAt(at('2026-09-22T20:00'), overlapping)).toBe('2026-09-23T10:00');
    // Ordre des plages sans effet.
    expect(effectiveFireAt(at('2026-09-22T20:00'), [...overlapping].reverse())).toBe('2026-09-23T10:00');
  });

  it('plage « toute la journée » sur certains jours seulement', () => {
    const wednesday = [allDayRange([3])];
    expect(effectiveFireAt(at('2026-09-23T15:00'), wednesday)).toBe('2026-09-24T00:00');
    expect(effectiveFireAt(at('2026-09-22T23:59'), wednesday)).toBe('2026-09-22T23:59');
  });

  it('changement d’heure (29 mars 2026 en Europe/Paris) : heure locale flottante, 08:00 reste 08:00', () => {
    // La nuit du 28 au 29 mars ne dure que 23 h : le calcul sur l'heure locale ne s'en aperçoit pas.
    expect(effectiveFireAt(at('2026-03-28T22:00'), PRO)).toBe('2026-03-30T08:00'); // samedi soir → lundi 08:00
    const weekdaysOnly = [range([1, 2, 3, 4, 5], '19:00', '08:00')];
    expect(effectiveFireAt(at('2026-03-26T22:00'), weekdaysOnly)).toBe('2026-03-27T08:00');
    expect(effectiveFireAt(at('2026-10-24T23:00'), [range([6], '22:00', '07:00')])).toBe('2026-10-25T07:00'); // fin d'heure d'été
  });

  it('passage d’une année et d’un mois : 31 décembre 23:00 → 1er janvier 08:00', () => {
    expect(effectiveFireAt(at('2026-12-31T23:00'), [range([4], '19:00', '08:00')])).toBe('2027-01-01T08:00');
  });

  it('silence continu sur toute la semaine : l’échéance d’origine est conservée (le rappel n’est pas perdu)', () => {
    const always = [allDayRange([1, 2, 3, 4, 5, 6, 7])];
    expect(effectiveFireAt(at('2026-09-22T12:00'), always)).toBe('2026-09-22T12:00');
  });

  it('une plage invalide est ignorée', () => {
    expect(effectiveFireAt(at('2026-09-22T20:00'), [range([], '19:00', '08:00'), range([2], '10:00', '10:00')])).toBe('2026-09-22T20:00');
  });
});

describe('validation des plages (ES-07 critères 3 et 4)', () => {
  it('jours, heures 24 h ; début = fin refusé hors « toute la journée »', () => {
    expect(validateQuietRange(range([2, 1, 2], '19:00', '08:00'))).toEqual({ ok: true, value: range([1, 2], '19:00', '08:00') });
    expect(validateQuietRange(range([], '19:00', '08:00'))).toEqual({ ok: false, error: 'no-days' });
    expect(validateQuietRange(range([9 as Weekday], '19:00', '08:00'))).toEqual({ ok: false, error: 'invalid-day' });
    expect(validateQuietRange(range([1], '25:00', '08:00'))).toEqual({ ok: false, error: 'invalid-time' });
    expect(validateQuietRange(range([1], '10:00', '10:00'))).toEqual({ ok: false, error: 'empty-range' });
    expect(validateQuietRange(range([1], '00:00', '00:00'))).toMatchObject({ ok: true });
    expect(isAllDayRange(range([1], '00:00', '00:00'))).toBe(true);
    expect(isAllDayRange(range([1], '00:00', '08:00'))).toBe(false);
  });

  it('première plage refusée avec son rang', () => {
    expect(validateQuietHours([range([1], '19:00', '08:00'), range([2], '09:00', '09:00')])).toEqual({ ok: false, error: { index: 1, error: 'empty-range' } });
    expect(validateQuietHours([])).toEqual({ ok: true, value: [] });
  });
});

describe('résumé des plages (ES-07 critère 2)', () => {
  it('Pro par défaut : « 19:00 – 08:00 » et « week-end » ; aucune plage : liste vide', () => {
    expect(describeQuietHours(PRO)).toEqual([{ kind: 'every-day', from: '19:00', to: '08:00' }, { kind: 'weekend-all-day' }]);
    expect(describeQuietHours([])).toEqual([]);
  });
  it('autres formes : jours choisis, toute la journée sur certains jours ; plage invalide ignorée', () => {
    expect(describeQuietHours([range([1, 3], '12:00', '14:00'), allDayRange([3]), range([2], '10:00', '10:00')])).toEqual([
      { kind: 'range', weekdays: [1, 3], from: '12:00', to: '14:00' },
      { kind: 'all-day', weekdays: [3] },
    ]);
  });
});
