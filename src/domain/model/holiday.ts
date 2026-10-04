import type { HolidayId, LocalDate, SyncMeta } from '../types';

export type HolidayCountry = 'FR' | 'TN';
export type HolidayKind = 'fixed' | 'computed' | 'lunar';
/** `table` : valeur de la table annuelle embarquée ; `manual` : saisie manuelle (prime sur la table). */
export type HolidaySource = 'table' | 'manual';

/**
 * Jour férié stocké (E-03, table `holiday`, migration 0010). Seules les fêtes lunaires tunisiennes y sont écrites : les dates fixes et
 * calculées (Pâques…) se calculent dans `src/domain/holidays`, sans ligne. Une ligne par pays, année et fête (`key`, identifiant
 * stable de la fête, ex. `eidAlFitr`) ; `name` est la clé du nom affiché (src/i18n), jamais un texte.
 * - `source` `table` : date recopiée de la table embarquée au démarrage (`overridden` faux) ;
 * - `source` `manual` : date saisie à la main (`overridden` vrai), jamais écrasée par une mise à jour de la table.
 */
export interface Holiday extends SyncMeta {
  readonly id: HolidayId;
  readonly country: HolidayCountry;
  readonly year: number;
  readonly key: string;
  readonly date: LocalDate;
  readonly name: string;
  readonly kind: HolidayKind;
  readonly source: HolidaySource;
  readonly overridden: boolean;
}

export type HolidayFields = Omit<Holiday, keyof SyncMeta>;
