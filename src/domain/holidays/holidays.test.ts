import { describe, expect, it } from 'vitest';
import { asLocalDate as d } from '../types';
import { easterSunday } from './easter';
import { frenchHolidays, tunisianFixedHolidays } from './fixedHolidays';
import { DEFAULT_HOLIDAY_COUNTRIES, holidaysInRange, holidaysOfYear, holidaysOnDate, isValidOverrideDate, uncoveredLunarYears, yearsToRead } from './holidays';
import { isLunarKey, isLunarYearCovered, LUNAR_HOLIDAY_KEYS, LUNAR_HOLIDAY_TABLE, LUNAR_TABLE_LAST_YEAR, LUNAR_TABLE_YEARS, lunarTableDate } from './lunarTable';

const EASTER: Record<number, string> = { 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2029: '2029-04-01', 2030: '2030-04-21' };

describe('Pâques et fériés calculés de la France, 2026 à 2030 (E-03 critère 1)', () => {
  it('dimanche de Pâques connu pour 2026 à 2030, et pour des années de référence', () => {
    for (const [year, date] of Object.entries(EASTER)) expect(easterSunday(Number(year))).toBe(date);
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2000)).toBe('2000-04-23');
  });

  it('huit fériés fixes et trois fériés mobiles, pour chaque année de 2026 à 2030', () => {
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const list = frenchHolidays(year);
      expect(list).toHaveLength(11);
      const dates = Object.fromEntries(list.map((h) => [h.key, h.date]));
      expect(dates['newYear']).toBe(`${year}-01-01`);
      expect(dates['labourDay']).toBe(`${year}-05-01`);
      expect(dates['victoryDay']).toBe(`${year}-05-08`);
      expect(dates['bastilleDay']).toBe(`${year}-07-14`);
      expect(dates['assumption']).toBe(`${year}-08-15`);
      expect(dates['allSaints']).toBe(`${year}-11-01`);
      expect(dates['armistice']).toBe(`${year}-11-11`);
      expect(dates['christmas']).toBe(`${year}-12-25`);
      const easter = Date.parse(`${EASTER[year]}T00:00:00Z`);
      const offset = (key: string): number => Math.round((Date.parse(`${dates[key]}T00:00:00Z`) - easter) / 86_400_000);
      expect([offset('easterMonday'), offset('ascension'), offset('whitMonday')]).toEqual([1, 39, 50]);
      expect(list.filter((h) => h.kind === 'computed').map((h) => h.key).sort()).toEqual(['ascension', 'easterMonday', 'whitMonday']);
      expect(list.map((h) => h.date)).toEqual([...list.map((h) => h.date)].sort());
    }
    expect(frenchHolidays(2026).find((h) => h.key === 'easterMonday')?.date).toBe('2026-04-06');
    expect(frenchHolidays(2026).find((h) => h.key === 'ascension')?.date).toBe('2026-05-14');
    expect(frenchHolidays(2026).find((h) => h.key === 'whitMonday')?.date).toBe('2026-05-25');
  });
});

describe('fériés civils de la Tunisie (E-03 critère 2)', () => {
  it('huit fêtes fixes, dont le 15 octobre « Évacuation »', () => {
    const list = tunisianFixedHolidays(2026);
    expect(list.map((h) => [h.key, h.date])).toEqual([
      ['newYear', '2026-01-01'],
      ['independence', '2026-03-20'],
      ['martyrs', '2026-04-09'],
      ['labourDay', '2026-05-01'],
      ['republic', '2026-07-25'],
      ['womenDay', '2026-08-13'],
      ['evacuation', '2026-10-15'],
      ['revolution', '2026-12-17'],
    ]);
    expect(list.every((h) => h.kind === 'fixed' && h.country === 'TN')).toBe(true);
  });
});

describe('table des fêtes religieuses (E-03 critères 2 et 8)', () => {
  it('quatre fêtes par année de 2026 à 2030, dates valides et dans l’ordre de l’année', () => {
    expect(LUNAR_TABLE_YEARS).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(LUNAR_HOLIDAY_KEYS).toEqual(['eidAlFitr', 'eidAlAdha', 'rasElAmElHejri', 'mouled']);
    for (const year of LUNAR_TABLE_YEARS) {
      for (const key of LUNAR_HOLIDAY_KEYS) {
        const date = lunarTableDate(year, key);
        expect(date, `${year} ${key}`).toMatch(new RegExp(`^${year}-\\d{2}-\\d{2}$`));
        expect(Number.isNaN(Date.parse(`${date}T00:00:00Z`))).toBe(false);
      }
      const table = LUNAR_HOLIDAY_TABLE[year];
      expect(table?.eidAlFitr && table.eidAlAdha && table.eidAlFitr < table.eidAlAdha).toBe(true);
    }
    expect(lunarTableDate(2026, 'eidAlFitr')).toBe('2026-03-20');
    expect(lunarTableDate(2031, 'eidAlFitr')).toBeNull();
    expect(isLunarKey('mouled')).toBe(true);
    expect(isLunarKey('christmas')).toBe(false);
  });

  it('RAPPEL DE MISE À JOUR ANNUELLE : la table couvre l’année courante et la suivante (date figée, test stable)', () => {
    // Jour figé : le test ne dépend pas de l'horloge. L'échéance réelle est signalée dans Réglages › Jours fériés (avertissement non bloquant).
    const frozenYear = 2026;
    expect(isLunarYearCovered(frozenYear)).toBe(true);
    expect(isLunarYearCovered(frozenYear + 1)).toBe(true);
    expect(LUNAR_TABLE_LAST_YEAR).toBeGreaterThanOrEqual(frozenYear + 1);
  });
});

describe('jours fériés d’une année, pays activables séparément (E-03 critères 1 à 5, 8)', () => {
  const keys = (list: ReturnType<typeof holidaysOfYear>): string[] => list.map((h) => `${h.country}:${h.key}`);

  it('France seule, Tunisie seule, les deux, aucune', () => {
    const fr = holidaysOfYear({ year: 2026, countries: { FR: true, TN: false } });
    expect(fr).toHaveLength(11);
    expect(fr.every((h) => h.country === 'FR' && !h.estimated && !h.editable && h.tableDate === null)).toBe(true);
    const tn = holidaysOfYear({ year: 2026, countries: { FR: false, TN: true } });
    expect(tn).toHaveLength(12);
    expect(keys(tn)).toContain('TN:evacuation');
    expect(holidaysOfYear({ year: 2026, countries: DEFAULT_HOLIDAY_COUNTRIES })).toHaveLength(23);
    expect(holidaysOfYear({ year: 2026, countries: { FR: false, TN: false } })).toEqual([]);
  });

  it('fêtes lunaires : table embarquée, « date estimée », modifiables ; fixes et calculées non modifiables', () => {
    const list = holidaysOfYear({ year: 2026, countries: DEFAULT_HOLIDAY_COUNTRIES });
    const fitr = list.find((h) => h.key === 'eidAlFitr');
    expect(fitr).toMatchObject({ country: 'TN', date: '2026-03-20', kind: 'lunar', estimated: true, overridden: false, tableDate: '2026-03-20', editable: true });
    expect(list.filter((h) => h.kind === 'lunar')).toHaveLength(4);
    expect(list.filter((h) => h.editable).every((h) => h.kind === 'lunar')).toBe(true);
    expect(list.find((h) => h.key === 'easterMonday')).toMatchObject({ editable: false, estimated: false });
  });

  it('la saisie manuelle prime sur la table et n’est plus « estimée » ; sa date de table reste connue (critère 5)', () => {
    const rows = [{ country: 'TN' as const, year: 2026, key: 'eidAlFitr', date: d('2026-03-21'), overridden: true }];
    const fitr = holidaysOfYear({ year: 2026, countries: DEFAULT_HOLIDAY_COUNTRIES, rows }).find((h) => h.key === 'eidAlFitr');
    expect(fitr).toMatchObject({ date: '2026-03-21', estimated: false, overridden: true, tableDate: '2026-03-20' });
  });

  it('une ligne de la base non saisie à la main suit la table de la base, reste estimée (critère 6)', () => {
    const rows = [{ country: 'TN' as const, year: 2026, key: 'mouled', date: d('2026-08-26'), overridden: false }];
    expect(holidaysOfYear({ year: 2026, countries: DEFAULT_HOLIDAY_COUNTRIES, rows }).find((h) => h.key === 'mouled')).toMatchObject({ date: '2026-08-26', estimated: true, overridden: false });
  });

  it('année non couverte : fixes et calculés présents, fêtes religieuses absentes (critère 8)', () => {
    const list = holidaysOfYear({ year: 2031, countries: DEFAULT_HOLIDAY_COUNTRIES });
    expect(list.filter((h) => h.country === 'FR')).toHaveLength(11);
    expect(list.filter((h) => h.country === 'TN')).toHaveLength(8);
    expect(list.some((h) => h.kind === 'lunar')).toBe(false);
    expect(uncoveredLunarYears([2030, 2031, 2032], DEFAULT_HOLIDAY_COUNTRIES)).toEqual([2031, 2032]);
    expect(uncoveredLunarYears([2031], { FR: true, TN: false })).toEqual([]);
    // Même année non couverte : une date saisie à la main s'affiche tout de même.
    const manual = [{ country: 'TN' as const, year: 2031, key: 'mouled', date: d('2031-07-01'), overridden: true }];
    expect(holidaysOfYear({ year: 2031, countries: DEFAULT_HOLIDAY_COUNTRIES, rows: manual }).find((h) => h.key === 'mouled')).toMatchObject({ date: '2031-07-01', tableDate: null, estimated: false });
  });

  it('plage et jour : une saisie manuelle qui change d’année est trouvée', () => {
    expect(yearsToRead(d('2026-12-28'), d('2027-01-03'))).toEqual([2025, 2026, 2027, 2028]);
    const range = holidaysInRange({ from: d('2026-10-01'), to: d('2026-11-30'), countries: DEFAULT_HOLIDAY_COUNTRIES });
    expect(range.map((h) => `${h.date} ${h.key}`)).toEqual(['2026-10-15 evacuation', '2026-11-01 allSaints', '2026-11-11 armistice']);
    expect(holidaysOnDate(d('2026-10-15'), DEFAULT_HOLIDAY_COUNTRIES)).toHaveLength(1);
    expect(holidaysOnDate(d('2026-10-15'), { FR: true, TN: false })).toEqual([]);
    const rows = [{ country: 'TN' as const, year: 2026, key: 'rasElAmElHejri', date: d('2027-01-01'), overridden: true }];
    expect(holidaysOnDate(d('2027-01-01'), { FR: false, TN: true }, rows).map((h) => h.key).sort()).toEqual(['newYear', 'rasElAmElHejri']);
  });

  it('une date saisie reste dans l’année de la fête ou une année voisine', () => {
    expect(isValidOverrideDate(2026, d('2026-03-21'))).toBe(true);
    expect(isValidOverrideDate(2026, d('2027-01-01'))).toBe(true);
    expect(isValidOverrideDate(2026, d('2031-01-01'))).toBe(false);
  });
});
