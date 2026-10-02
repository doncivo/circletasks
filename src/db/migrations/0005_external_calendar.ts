import type { Migration } from '../migrator';

/**
 * S-05 : agendas externes lus en lecture seule (PRD section 6, M8). `calendar_account` porte les colonnes de synchro (le
 * rattachement des agendas à un espace, ES-06, est un réglage partagé) ; `external_event` n'en a pas : ses lignes sont relues
 * depuis Google ou iCloud par chaque appareil (K-01, ordre 2) et ne circulent pas dans les journaux de synchro. Les instants sont
 * en UTC (`start_utc`, `end_utc`, ISO 8601) ; une journée entière (`all_day = 1`) garde sa date civile dans la partie date de
 * `start_utc` et, pour `end_utc`, la date de fin EXCLUE (convention Google et iCal). Aucune ligne n'est produite avant K-01.
 */
export const migration0005ExternalCalendar: Migration = {
  version: 5,
  name: 'external_calendar',
  statements: [
    `CREATE TABLE calendar_account (
      id          TEXT PRIMARY KEY,
      provider    TEXT NOT NULL CHECK (provider IN ('google', 'icloud')),
      label       TEXT NOT NULL,
      token_ref   TEXT NOT NULL DEFAULT '',
      calendars   TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_calendar_account_deleted_at ON calendar_account(deleted_at)',
    'CREATE INDEX idx_calendar_account_hlc ON calendar_account(hlc)',
    `CREATE TABLE external_event (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES calendar_account(id),
      calendar_id  TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      title        TEXT NOT NULL,
      start_utc    TEXT NOT NULL,
      end_utc      TEXT,
      all_day      INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
      synced_at    TEXT NOT NULL,
      UNIQUE (account_id, calendar_id, external_id)
    )`,
    // S-05 : lecture d'une plage (une requête par semaine affichée).
    'CREATE INDEX idx_external_event_start ON external_event(start_utc)',
  ],
};
