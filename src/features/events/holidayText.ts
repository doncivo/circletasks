import type { HolidayCountries, HolidayEntry } from '../../domain/holidays';
import type { HolidayCountry } from '../../domain/model';
import { t, tDynamic, type MessageKey } from '../../i18n';

/** Nom d'une fête (« Fête de l'Évacuation ») : texte de src/i18n, clé `events.holidays.<key>`. */
export function holidayName(key: string): string {
  return tDynamic(`events.holidays.${key}` as MessageKey);
}

export const countryName = (country: HolidayCountry): string => t(country === 'FR' ? 'events.holidayCountry.FR' : 'events.holidayCountry.TN');

/** Étiquette « Férié FR » / « Férié TN » (Evenements.html). */
export const holidayTagLabel = (holiday: Pick<HolidayEntry, 'country'>): string => t(holiday.country === 'FR' ? 'events.holidayTag.FR' : 'events.holidayTag.TN');

/** « Jour férié · Tunisie », suivi de « date estimée » tant qu'une fête religieuse n'est pas confirmée (E-03 critère 5). */
export function holidaySubtitle(holiday: Pick<HolidayEntry, 'country' | 'estimated'>): string {
  const base = t('events.holidaySubtitle', { country: countryName(holiday.country) });
  return holiday.estimated ? `${base} · ${t('events.holidayEstimated')}` : base;
}

/** Calendriers activés écrits « France, Tunisie » ; null si aucun. */
export function enabledCountriesLabel(countries: HolidayCountries): string | null {
  const names = (['FR', 'TN'] as const).filter((country) => countries[country]).map(countryName);
  return names.length === 0 ? null : names.join(', ');
}
