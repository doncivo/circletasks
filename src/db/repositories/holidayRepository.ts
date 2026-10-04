import type { Holiday, HolidayCountry, HolidayFields } from '../../domain/model';
import type { HolidayId, LocalDate } from '../../domain/types';

export type NewHoliday = HolidayFields & { readonly id: HolidayId };

/**
 * Jours fériés stockés (M7, E-03). Seules les fêtes lunaires tunisiennes ont une ligne (voir `Holiday`) : la table annuelle recopiée
 * de la table embarquée et les dates saisies à la main. Aucune règle métier ici (quelles fêtes, quelles dates, fusion) :
 * `src/domain/holidays`.
 */
export interface HolidayRepository {
  /** Lignes non supprimées des années demandées. */
  listForYears(years: readonly number[]): Promise<Holiday[]>;
  getByKey(country: HolidayCountry, year: number, key: string): Promise<Holiday | null>;
  /**
   * E-03 critère 6 : rapproche la base de la table annuelle embarquée. Insère les lignes absentes ; met à jour la date des lignes
   * `table` dont la date a changé (nouvelle version de la table) ; ne touche JAMAIS une ligne saisie à la main (`overridden`).
   * Renvoie le nombre de lignes écrites (0 quand tout est à jour : aucun tampon de synchro inutile).
   */
  syncTable(rows: readonly NewHoliday[]): Promise<number>;
  /** E-03 critère 5 : saisie manuelle (`source` `manual`, `overridden` vrai) ; crée la ligne si elle n'existe pas (année hors table). */
  setOverride(holiday: NewHoliday, date: LocalDate): Promise<Holiday>;
  /**
   * E-03 critère 5 : « Rétablir la date de la table » : la date de la table, `source` `table`, `overridden` faux ; sans date de table
   * (année non couverte), la ligne est supprimée logiquement. Renvoie null dans ce dernier cas.
   */
  clearOverride(country: HolidayCountry, year: number, key: string, tableDate: LocalDate | null): Promise<Holiday | null>;
}
