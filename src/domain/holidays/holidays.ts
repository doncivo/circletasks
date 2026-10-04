import type { Holiday, HolidayCountry, HolidayKind } from '../model';
import type { LocalDate } from '../types';
import { frenchHolidays, tunisianFixedHolidays } from './fixedHolidays';
import { isLunarYearCovered, LUNAR_HOLIDAY_KEYS, lunarTableDate, type LunarHolidayKey } from './lunarTable';

/**
 * Jours fériés d'une année (E-03) : France et Tunisie activables séparément. Les fériés fixes et calculés (Pâques) se calculent ; les
 * fêtes religieuses tunisiennes sont lues dans la table annuelle (lignes `holiday` de la base, à défaut la table embarquée) et la date
 * saisie à la main prime sur la table (PRD 6). Fonctions pures : aucune lecture de base ni d'horloge.
 */
export interface HolidayEntry {
  readonly country: HolidayCountry;
  readonly year: number;
  /** Identifiant stable de la fête ; le nom affiché est `events.holidays.<key>` dans src/i18n. */
  readonly key: string;
  readonly date: LocalDate;
  readonly kind: HolidayKind;
  /** Fête lunaire non confirmée : « date estimée » (critère 5). Faux pour une date calculée et pour une date saisie à la main. */
  readonly estimated: boolean;
  /** Date saisie à la main (`overridden`) : prime sur la table. */
  readonly overridden: boolean;
  /** Date de la table pour une fête lunaire (« Rétablir la date de la table ») ; null sinon. */
  readonly tableDate: LocalDate | null;
  /** Seule une fête lunaire a une date modifiable (D4, critère 5). */
  readonly editable: boolean;
}

export interface HolidayCountries {
  readonly FR: boolean;
  readonly TN: boolean;
}

/** Les deux calendriers sont activés par défaut (critère 4). */
export const DEFAULT_HOLIDAY_COUNTRIES: HolidayCountries = { FR: true, TN: true };

export interface HolidaysOfYearInput {
  readonly year: number;
  readonly countries: HolidayCountries;
  /** Lignes `holiday` lues en base pour cette année (fêtes lunaires et saisies manuelles). */
  readonly rows?: readonly Pick<Holiday, 'country' | 'year' | 'key' | 'date' | 'overridden'>[];
}

const byDate = (a: HolidayEntry, b: HolidayEntry): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.country < b.country ? -1 : a.country > b.country ? 1 : a.key < b.key ? -1 : 1);

/**
 * Fêtes lunaires tunisiennes d'une année : la date saisie à la main si elle existe, sinon la ligne de la base, sinon la table embarquée ;
 * une fête sans date connue (année non couverte) est absente (critère 8).
 */
function lunarEntries(input: HolidaysOfYearInput): HolidayEntry[] {
  const entries: HolidayEntry[] = [];
  for (const key of LUNAR_HOLIDAY_KEYS) {
    const tableDate = lunarTableDate(input.year, key);
    const row = input.rows?.find((candidate) => candidate.country === 'TN' && candidate.year === input.year && candidate.key === key);
    const manual = row?.overridden === true;
    const date = manual ? row.date : (row?.date ?? tableDate);
    if (date === null || date === undefined) continue;
    entries.push({ country: 'TN', year: input.year, key, date, kind: 'lunar', estimated: !manual, overridden: manual, tableDate, editable: true });
  }
  return entries;
}

/** Jours fériés de l'année pour les pays activés, triés par date. */
export function holidaysOfYear(input: HolidaysOfYearInput): HolidayEntry[] {
  const entries: HolidayEntry[] = [];
  const calculated = (country: HolidayCountry, list: ReturnType<typeof frenchHolidays>): void => {
    for (const holiday of list) entries.push({ country, year: input.year, key: holiday.key, date: holiday.date, kind: holiday.kind, estimated: false, overridden: false, tableDate: null, editable: false });
  };
  if (input.countries.FR) calculated('FR', frenchHolidays(input.year));
  if (input.countries.TN) {
    calculated('TN', tunisianFixedHolidays(input.year));
    entries.push(...lunarEntries(input));
  }
  return entries.sort(byDate);
}

/**
 * Années à lire pour couvrir [from, to] : une fête saisie à la main peut changer d'année, donc on garde une année de marge de chaque
 * côté (le 1er janvier d'une année peut recevoir une fête de l'année précédente corrigée).
 */
export function yearsToRead(from: LocalDate, to: LocalDate): number[] {
  const first = Number(from.slice(0, 4)) - 1;
  const last = Number(to.slice(0, 4)) + 1;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export interface HolidaysInRangeInput {
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly countries: HolidayCountries;
  readonly rows?: readonly Pick<Holiday, 'country' | 'year' | 'key' | 'date' | 'overridden'>[];
}

/** Jours fériés dont la date tombe dans [from, to] (bornes incluses), triés. */
export function holidaysInRange(input: HolidaysInRangeInput): HolidayEntry[] {
  return yearsToRead(input.from, input.to)
    .flatMap((year) => holidaysOfYear({ year, countries: input.countries, ...(input.rows ? { rows: input.rows } : {}) }))
    .filter((entry) => entry.date >= input.from && entry.date <= input.to)
    .sort(byDate);
}

/** Jours fériés d'un jour donné. */
export function holidaysOnDate(date: LocalDate, countries: HolidayCountries, rows?: HolidaysInRangeInput['rows']): HolidayEntry[] {
  return holidaysInRange({ from: date, to: date, countries, ...(rows ? { rows } : {}) });
}

/** Années sans fêtes religieuses (table non couverte) parmi `years`, tunisien activé : sert au message « Dates religieuses non disponibles pour 2031 ». */
export function uncoveredLunarYears(years: readonly number[], countries: HolidayCountries): number[] {
  return countries.TN ? years.filter((year) => !isLunarYearCovered(year)) : [];
}

/** Une date saisie à la main reste dans l'année de la fête ou une année voisine (l'annonce officielle diffère de quelques jours, pas d'une année). */
export function isValidOverrideDate(year: number, date: LocalDate): boolean {
  return Math.abs(Number(date.slice(0, 4)) - year) <= 1;
}

export type { LunarHolidayKey };
