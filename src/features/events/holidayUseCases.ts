import { LUNAR_HOLIDAY_KEYS, LUNAR_TABLE_YEARS, holidaysInRange, isLunarKey, isValidOverrideDate, lunarTableDate, yearsToRead, type HolidayCountries, type HolidayEntry } from '../../domain/holidays';
import { holidayId } from '../../domain/sync/naturalIds';
import type { Holiday, HolidayCountry } from '../../domain/model';
import type { LocalDate } from '../../domain/types';
import type { DataAccess, NewHoliday } from '../../db/repositories';
import type { AppContainer } from '../app/container';
import { emitEventsChanged } from './eventEvents';

/**
 * Cas d'usage « jours fériés » (E-03, ADR 0004) : les écrans appellent ces fonctions, jamais les repositories. Les règles (quels
 * fériés, calcul de Pâques, fusion de la table et de la saisie manuelle) sont dans `src/domain/holidays`.
 */
export type HolidayUseCaseDeps = Pick<AppContainer, 'ids' | 'data'>;

/** Rapprochement de la table de la base et de la table embarquée, une fois par base et par session (les lectures l'attendent). */
const tableReady = new WeakMap<DataAccess, Promise<void>>();

/**
 * Recopie la table annuelle embarquée dans `holiday` (fêtes lunaires tunisiennes de 2026 à 2030) : insère les lignes absentes, suit
 * les dates d'une nouvelle version de la table, ne touche jamais une date saisie à la main (critère 6). Rejouable, sans écriture quand
 * tout est à jour. Un échec n'est pas mémorisé : la lecture suivante réessaie, et l'affichage retombe sur la table embarquée.
 */
export function ensureHolidayTable(deps: HolidayUseCaseDeps): Promise<void> {
  const known = tableReady.get(deps.data);
  if (known) return known;
  const rows: NewHoliday[] = LUNAR_TABLE_YEARS.flatMap((year) =>
    LUNAR_HOLIDAY_KEYS.flatMap((key) => {
      const date = lunarTableDate(year, key);
      return date === null ? [] : [{ id: holidayId('TN', year, key), country: 'TN' as const, year, key, date, name: key, kind: 'lunar' as const, source: 'table' as const, overridden: false }];
    }),
  );
  const run = deps.data.transaction((repos) => repos.holidays.syncTable(rows)).then(() => undefined);
  tableReady.set(deps.data, run);
  run.catch(() => tableReady.delete(deps.data));
  return run;
}

/** Calendriers activés (réglage partagé `holidays.countries`) ; les deux par défaut. */
export function readHolidayCountries(deps: Pick<HolidayUseCaseDeps, 'data'>): Promise<HolidayCountries> {
  return deps.data.repos.settings.get('holidays.countries');
}

export interface HolidayData {
  readonly countries: HolidayCountries;
  /** Lignes `holiday` des années lues : fêtes lunaires et saisies manuelles. */
  readonly rows: readonly Holiday[];
}

/** Réglage et lignes nécessaires pour calculer les fériés de [from, to]. Ne rejette pas : sans base lisible, la table embarquée suffit. */
export async function loadHolidayData(deps: HolidayUseCaseDeps, from: LocalDate, to: LocalDate): Promise<HolidayData> {
  const countries = await readHolidayCountries(deps).catch((): HolidayCountries => ({ FR: true, TN: true }));
  await ensureHolidayTable(deps).catch(() => undefined);
  const rows = await deps.data.repos.holidays.listForYears(yearsToRead(from, to)).catch((): Holiday[] => []);
  return { countries, rows };
}

/** Jours fériés de [from, to] pour les calendriers activés. */
export async function loadHolidays(deps: HolidayUseCaseDeps, from: LocalDate, to: LocalDate): Promise<HolidayEntry[]> {
  const data = await loadHolidayData(deps, from, to);
  return holidaysInRange({ from, to, countries: data.countries, rows: data.rows });
}

export type HolidayOverrideError = 'not-editable' | 'invalid-date';

export interface HolidayUseCases {
  /** E-03 critère 3 : active ou désactive un calendrier ; l'état est conservé, l'autre pays n'est pas touché. */
  setCountry(country: HolidayCountry, enabled: boolean): Promise<void>;
  /** E-03 critère 5 : date saisie à la main (`source` manual, `overridden`), prioritaire sur la table ; réservée aux fêtes lunaires. */
  overrideDate(holiday: Pick<HolidayEntry, 'country' | 'key' | 'year' | 'kind'>, date: LocalDate): Promise<{ ok: true } | { ok: false; error: HolidayOverrideError }>;
  /** E-03 critère 5 : « Rétablir la date de la table ». Renvoie vrai si une saisie existait. */
  restoreTableDate(holiday: Pick<HolidayEntry, 'country' | 'key' | 'year' | 'kind'>): Promise<boolean>;
}

export function createHolidayUseCases(deps: HolidayUseCaseDeps): HolidayUseCases {
  const { data } = deps;
  return {
    async setCountry(country, enabled) {
      const current = await readHolidayCountries(deps);
      await data.repos.settings.set('holidays.countries', { ...current, [country]: enabled });
      emitEventsChanged(data);
    },

    async overrideDate(holiday, date) {
      if (holiday.country !== 'TN' || holiday.kind !== 'lunar' || !isLunarKey(holiday.key)) return { ok: false, error: 'not-editable' };
      if (!isValidOverrideDate(holiday.year, date)) return { ok: false, error: 'invalid-date' };
      await ensureHolidayTable(deps).catch(() => undefined);
      await data.repos.holidays.setOverride(
        { id: holidayId('TN', holiday.year, holiday.key), country: 'TN', year: holiday.year, key: holiday.key, date, name: holiday.key, kind: 'lunar', source: 'manual', overridden: true },
        date,
      );
      emitEventsChanged(data);
      return { ok: true };
    },

    async restoreTableDate(holiday) {
      if (holiday.country !== 'TN' || holiday.kind !== 'lunar' || !isLunarKey(holiday.key)) return false;
      const existing = await data.repos.holidays.getByKey('TN', holiday.year, holiday.key);
      if (!existing?.overridden) return false;
      await data.repos.holidays.clearOverride('TN', holiday.year, holiday.key, lunarTableDate(holiday.year, holiday.key));
      emitEventsChanged(data);
      return true;
    },
  };
}
