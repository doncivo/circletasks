import type { Migration } from '../migrator';

/**
 * E-03 : table `holiday` (PRD 6 : country, date, name, kind, source, overridden), synchronisable (colonnes de synchro, résolution par
 * hlc : une saisie manuelle faite sur un appareil gagne sur l'autre). Une ligne par pays, année et fête (`key`, unique) :
 * - seules les fêtes lunaires tunisiennes (`kind` `lunar`) y sont écrites ; les fêtes fixes et calculées (Pâques) se calculent dans
 *   `src/domain/holidays`, sans ligne ;
 * - `source` `table` : date recopiée de la table annuelle embarquée au démarrage (`ensureHolidayTable`), rapprochée à chaque mise à
 *   jour de l'app ; `source` `manual` et `overridden` à 1 : date saisie à la main, jamais écrasée par la table (critères 5 et 6) ;
 * - `name` porte la clé du nom (src/i18n `events.holidays.<key>`), jamais un texte.
 * Aucune donnée n'est semée ici : une migration publiée ne se modifie plus, la table embarquée change chaque année. Rejouable.
 */
export const migration0010Holiday: Migration = {
  version: 10,
  name: 'holiday',
  statements: [
    `CREATE TABLE IF NOT EXISTS holiday (
      id          TEXT PRIMARY KEY,
      country     TEXT NOT NULL CHECK (country IN ('FR', 'TN')),
      year        INTEGER NOT NULL,
      key         TEXT NOT NULL,
      date        TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('fixed', 'computed', 'lunar')),
      source      TEXT NOT NULL DEFAULT 'table' CHECK (source IN ('table', 'manual')),
      overridden  INTEGER NOT NULL DEFAULT 0 CHECK (overridden IN (0, 1)),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL,
      UNIQUE (country, year, key)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_holiday_year ON holiday(year)',
    'CREATE INDEX IF NOT EXISTS idx_holiday_deleted_at ON holiday(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_holiday_hlc ON holiday(hlc)',
  ],
};
