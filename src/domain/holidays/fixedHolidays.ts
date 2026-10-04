import { addDays, makeLocalDate } from '../localDate';
import type { HolidayCountry, HolidayKind } from '../model';
import type { LocalDate } from '../types';
import { easterSunday } from './easter';

/**
 * Jours fériés calculés sans table (E-03 critères 1 et 2). Chaque fête a une clé stable (`key`) : le texte affiché est dans
 * src/i18n (`events.holidays.<key>`), jamais ici.
 *
 * France : fixes (1er janv., 1er mai, 8 mai, 14 juil., 15 août, 1er nov., 11 nov., 25 déc.) et calculés depuis Pâques (lundi de Pâques,
 * Ascension, lundi de Pentecôte). Métropole : ni Alsace-Moselle ni ponts (hors périmètre).
 *
 * Tunisie : fêtes civiles à date fixe — 1er janv., 14 janv. (Révolution et Jeunesse), 20 mars (Indépendance), 9 avr. (Martyrs),
 * 1er mai (Travail), 25 juil. (République), 13 août (Femme), 15 oct. (Évacuation). Liste à valider par Ali (le 14 janv. était la date de
 * la Révolution avant le décret de décembre 2021 qui célèbre le 17 déc. ; les fêtes religieuses sont lues dans la table annuelle).
 */
export interface CalculatedHoliday {
  readonly country: HolidayCountry;
  readonly key: string;
  readonly date: LocalDate;
  readonly kind: Extract<HolidayKind, 'fixed' | 'computed'>;
}

const fixed = (country: HolidayCountry, year: number, key: string, month: number, day: number): CalculatedHoliday => ({
  country,
  key,
  date: makeLocalDate(year, month, day),
  kind: 'fixed',
});

/** Jours fériés de la France pour l'année (tri par date). */
export function frenchHolidays(year: number): CalculatedHoliday[] {
  const easter = easterSunday(year);
  const computed = (key: string, offset: number): CalculatedHoliday => ({ country: 'FR', key, date: addDays(easter, offset), kind: 'computed' });
  return [
    fixed('FR', year, 'newYear', 1, 1),
    computed('easterMonday', 1),
    fixed('FR', year, 'labourDay', 5, 1),
    fixed('FR', year, 'victoryDay', 5, 8),
    computed('ascension', 39),
    computed('whitMonday', 50),
    fixed('FR', year, 'bastilleDay', 7, 14),
    fixed('FR', year, 'assumption', 8, 15),
    fixed('FR', year, 'allSaints', 11, 1),
    fixed('FR', year, 'armistice', 11, 11),
    fixed('FR', year, 'christmas', 12, 25),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Fêtes civiles de la Tunisie pour l'année, à date fixe (tri par date). */
export function tunisianFixedHolidays(year: number): CalculatedHoliday[] {
  return [
    fixed('TN', year, 'newYear', 1, 1),
    fixed('TN', year, 'revolutionYouth', 1, 14),
    fixed('TN', year, 'independence', 3, 20),
    fixed('TN', year, 'martyrs', 4, 9),
    fixed('TN', year, 'labourDay', 5, 1),
    fixed('TN', year, 'republic', 7, 25),
    fixed('TN', year, 'womenDay', 8, 13),
    fixed('TN', year, 'evacuation', 10, 15),
  ];
}
